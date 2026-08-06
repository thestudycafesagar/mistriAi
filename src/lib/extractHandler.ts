// ─────────────────────────────────────────────────────────────────────────────
// Shared request handler behind all /api/extract* routes.
//
// One implementation of validation + queueing + response-building, reused by:
//   - /api/extract              (generic — docType is a form field; kept for
//                                 the existing web UI, which already posts here)
//   - /api/extract/bank-statement (docType is fixed — no field required)
//   - /api/extract/invoice        (docType must be SALES_INVOICE or PURCHASE_INVOICE)
//
// Keeping this in one place means a validation fix or behavior change
// applies to every route identically instead of having to be repeated (and
// potentially drift) across multiple route.ts files.
// ─────────────────────────────────────────────────────────────────────────────
import { NextRequest, NextResponse } from 'next/server';
import { enqueueOcr, QueueSaturatedError } from './queue';
import { runOcr, hasMistralApiKey, type BankStatementSummary } from './mistral';
import { SCHEMAS, type DocumentType } from './schemas';
import { hashFile, getCached, setCached } from './ocrCache';

const ALLOWED_MIME = [
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/tiff',
  'image/gif',
];

// Max file size is a server memory safety net, not a Mistral API constraint:
// PDFs are split into chunks before upload, so Mistral only ever sees small
// per-chunk files regardless of how long the original document is. Images
// are sent as a single request (no chunking), so keep that cap tight.
const MAX_PDF_SIZE_BYTES = 200 * 1024 * 1024;   // 200 MB — comfortably covers 100-200+ scanned pages
const MAX_IMAGE_SIZE_BYTES = 25 * 1024 * 1024;  // 25 MB — single-shot upload

const DOC_TYPE_LABELS: Record<DocumentType, string> = {
  BANK_STATEMENT: 'Bank Statement',
  SALES_INVOICE: 'Sales Invoice',
  PURCHASE_INVOICE: 'Purchase Invoice',
};

function humanJoin(labels: string[]): string {
  if (labels.length <= 1) return labels.join('');
  if (labels.length === 2) return labels.join(' or ');
  return `${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}`;
}

export interface ExtractRouteOptions {
  /** Document types this endpoint accepts via the `docType` form field. Ignored when `fixedDocType` is set. */
  allowedDocTypes: DocumentType[];
  /**
   * If set, this endpoint always extracts as this type and does NOT read
   * `docType` from the request at all (e.g. the dedicated bank-statement
   * route) — simpler for external API consumers who only ever send one kind
   * of document to that URL.
   */
  fixedDocType?: DocumentType;
}

/**
 * Validates the incoming multipart request, runs OCR extraction through the
 * shared queue, and returns the JSON response. Used by every /api/extract*
 * route so they all share identical validation and error handling.
 */
export async function handleExtractRequest(req: NextRequest, options: ExtractRouteOptions): Promise<NextResponse> {
  try {
    // ── Parse multipart form ──────────────────────────────────────────────────
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid form data. Please upload a PDF or image.' },
        { status: 400 },
      );
    }

    const file = formData.get('file') as File | null;

    // ── Validation ─────────────────────────────────────────────────────────────
    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { success: false, error: 'No file uploaded. Please select a PDF or image.' },
        { status: 400 },
      );
    }

    let docType: DocumentType;
    if (options.fixedDocType) {
      docType = options.fixedDocType;
    } else {
      let provided = formData.get('docType') as string | null;

      // Fallback for external apps that send transactionType instead of docType
      if (!provided) {
        const transactionType = formData.get('transactionType') as string | null;
        if (transactionType === 'sale') provided = 'SALES_INVOICE';
        else if (transactionType === 'purchase') provided = 'PURCHASE_INVOICE';
      }

      if (!provided || !options.allowedDocTypes.includes(provided as DocumentType)) {
        const choices = humanJoin(options.allowedDocTypes.map(dt => DOC_TYPE_LABELS[dt]));
        return NextResponse.json(
          { success: false, error: `Invalid document type. Choose ${choices}.` },
          { status: 400 },
        );
      }
      docType = provided as DocumentType;
    }

    const mimeType = file.type || 'application/octet-stream';
    if (!ALLOWED_MIME.includes(mimeType)) {
      return NextResponse.json(
        { success: false, error: `Unsupported file type: ${mimeType}. Please upload a PDF or image (JPEG, PNG, WEBP, TIFF).` },
        { status: 400 },
      );
    }

    const maxSizeBytes = mimeType === 'application/pdf' ? MAX_PDF_SIZE_BYTES : MAX_IMAGE_SIZE_BYTES;
    if (file.size > maxSizeBytes) {
      return NextResponse.json(
        {
          success: false,
          error: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum allowed size is ${(maxSizeBytes / 1024 / 1024).toFixed(0)} MB.`,
        },
        { status: 400 },
      );
    }

    if (!hasMistralApiKey()) {
      return NextResponse.json(
        { success: false, error: 'Server configuration error: no Mistral API key is configured (MISTRAL_API_KEY / MISTRAL_API_KEYS).' },
        { status: 500 },
      );
    }

    // ── Exact-duplicate-file cache ────────────────────────────────────────────
    // A re-upload of the identical file (retry after a failure, someone
    // re-processing a statement they already extracted) can skip Mistral
    // entirely and return the previous result instantly.
    const startedAt = Date.now();
    const fileHash = await hashFile(file);
    const cached = getCached(docType, fileHash);

    let rows: Record<string, string>[];
    let bankSummary: BankStatementSummary | undefined;
    let servedFromCache = false;

    if (cached) {
      rows = cached.rows;
      bankSummary = cached.meta?.bankSummary ? JSON.parse(cached.meta.bankSummary) : undefined;
      servedFromCache = true;
    } else {
      // ── Enqueue the OCR task ────────────────────────────────────────────────
      let result;
      try {
        result = await enqueueOcr(() => runOcr(file, docType));
      } catch (err) {
        if (err instanceof QueueSaturatedError) {
          // Many concurrent users + a full queue: tell the caller to back off
          // and retry, rather than accepting the request and making them wait
          // indefinitely (or exhausting server memory holding queued files).
          return NextResponse.json(
            { success: false, error: err.message },
            { status: 503, headers: { 'Retry-After': '10' } },
          );
        }
        throw err;
      }
      rows = result.rows;
      bankSummary = result.bankSummary;
      setCached(docType, fileHash, rows, bankSummary ? { bankSummary: JSON.stringify(bankSummary) } : undefined);
    }
    const processingTimeMs = Date.now() - startedAt;

    const columns = SCHEMAS[docType].columns;
    const companyName = formData.get('companyName') as string;
    const companyGSTIN = formData.get('companyGSTIN') as string;

    const responsePayload: any = {
      success: true,
      docType,
      rowCount: rows.length,
      columns,
      data: rows,
      processingTimeMs,
      cached: servedFromCache,
    };

    if (companyName !== null) responsePayload.companyName = companyName;
    if (companyGSTIN !== null) responsePayload.companyGSTIN = companyGSTIN;
    if (bankSummary) responsePayload.bankSummary = bankSummary;

    return NextResponse.json(responsePayload);

  } catch (err: unknown) {
    console.error('[extractHandler] Error:', err);

    const message =
      err instanceof Error
        ? err.message
        : 'An unexpected error occurred during extraction.';

    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}

/**
 * Given the raw NextResponse from handleExtractRequest, if the docType is
 * SALES_INVOICE or PURCHASE_INVOICE, transforms the output into the flat
 * invoice object shape that the external webapp expects, with mappedRow embedded.
 * Date format is always YYYY-MM-DD. Missing fields are left empty/null.
 * For BANK_STATEMENT (or errors) the original response is returned unchanged.
 */
export async function formatInvoiceResponse(res: NextResponse): Promise<NextResponse> {
  if (!res.ok) return res;

  const json = await res.json();
  if (!json.success) return NextResponse.json(json, { status: res.status });

  const { docType, data: rows = [], companyName = '', companyGSTIN = '' } = json;

  if (docType !== 'SALES_INVOICE' && docType !== 'PURCHASE_INVOICE') {
    return NextResponse.json(json);
  }

  const firstData = rows[0] || {};
  const mappedRow = firstData.mappedRow || {};

  // Fields — leave empty string when not present (do not default to placeholder values)
  const invoiceNumber = mappedRow.SupplierInvoiceNo   || '';
  const invoiceDate   = mappedRow.SupplierInvoiceDate || '';   // already YYYY-MM-DD from Mistral
  const partyLedger   = mappedRow.PartyLedger         || '';
  const partyGSTIN    = mappedRow.PartyGSTIN          || '';

  const sellerName  = docType === 'SALES_INVOICE' ? companyName  : partyLedger;
  const sellerGSTIN = docType === 'SALES_INVOICE' ? companyGSTIN : partyGSTIN;
  const buyerName   = docType === 'SALES_INVOICE' ? partyLedger  : companyName;
  const buyerGSTIN  = docType === 'SALES_INVOICE' ? partyGSTIN   : companyGSTIN;

  const taxableValue = mappedRow.TaxableValue   || 0;
  const cgstRaw      = mappedRow['CGST Amount'];
  const sgstRaw      = mappedRow['SGST Amount'];
  const igstRaw      = mappedRow['IGST Amount'];
  // Use null for zero/absent tax fields so the external app can distinguish "not applicable" from 0
  const cgstAmount         = cgstRaw  || null;
  const sgstAmount         = sgstRaw  || null;
  const igstAmount         = igstRaw  || null;
  const totalInvoiceAmount = taxableValue + (cgstRaw || 0) + (sgstRaw || 0) + (igstRaw || 0);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lineItems = (mappedRow.items || []).map((item: any) => ({
    description:   item.ItemName  || '',
    hsnSac:        item.HSNCode   || '',
    goodsQuantity: item.Quantity != null && item.Quantity !== 0 ? item.Quantity : null,
    goodsRate:     item.Rate     != null && item.Rate !== 0     ? item.Rate     : null,
    amount:        item.ExtractedAmount || 0,
  }));

  // Build the embedded mappedRow, stripping internal-only fields
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const embeddedMappedRow: any = { ...mappedRow };
  delete embeddedMappedRow.acct_legs;   // internal field not needed by external app

  // Return flat object — the external webapp wraps this as rawApiResponse itself
  return NextResponse.json({
    invoiceNumber:      invoiceNumber   || undefined,   // omit key entirely if empty
    invoiceDate:        invoiceDate     || undefined,
    sellerName:         sellerName      || undefined,
    sellerGSTIN:        sellerGSTIN     || undefined,
    buyerName:          buyerName       || undefined,
    buyerGSTIN:         buyerGSTIN      || undefined,
    lineItems,
    taxableValue,
    cgstAmount,
    sgstAmount,
    igstAmount,
    totalInvoiceAmount,
    mappedRow: Object.keys(embeddedMappedRow).length ? embeddedMappedRow : undefined,
  });
}
