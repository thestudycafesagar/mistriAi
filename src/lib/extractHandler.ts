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
import { runOcr, hasMistralApiKey, type BankStatementSummary, type IncompleteChunk } from './mistral';
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

/**
 * Logs exactly what a request contained right before it's rejected with
 * 400 — the single biggest time-sink debugging an integration remotely is
 * not knowing whether a caller's request even reached validation with the
 * fields you expected. This makes that visible in the server's own console
 * without needing the caller to also report their side.
 */
function logValidationFailure(file: File | null, fields: Record<string, string>, reason: string): void {
  const fileDesc = file
    ? `"${file.name}" (${file.type || 'no content-type'}, ${file.size} bytes)`
    : 'MISSING';
  const otherKeys = Object.keys(fields).filter(k => fields[k]);
  console.warn(
    `[extractHandler] 400: ${reason} | file=${fileDesc} | other fields received: ` +
    `${otherKeys.length ? otherKeys.map(k => `${k}="${fields[k]}"`).join(', ') : '(none)'}`,
  );
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
    // Next.js 16's built-in req.formData() has been observed to fail to parse
    // multipart bodies from some external HTTP clients (works for this app's
    // own requests, fails for at least one real external caller) with no
    // useful error surfaced — the request just comes back 400 with nothing to
    // debug from. This hand-rolled parser reads the raw bytes and walks the
    // multipart boundaries itself, which has proven reliable against callers
    // where req.formData() was not.
    let parsedDocType = '';
    let parsedTransactionType = '';
    let parsedCompanyName = '';
    let parsedCompanyGSTIN = '';
    let file: File | null = null;
    try {
      const arrayBuffer = await req.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const contentType = req.headers.get('content-type') || '';
      const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
      if (!boundaryMatch) {
        return NextResponse.json(
          { success: false, error: 'Invalid Content-Type header missing boundary.' },
          { status: 400 }
        );
      }
      const boundary = boundaryMatch[1] || boundaryMatch[2];
      const boundaryBuffer = Buffer.from(`--${boundary}`);

      let start = 0;

      while (true) {
        const idx = buffer.indexOf(boundaryBuffer, start);
        if (idx === -1) break;

        start = idx + boundaryBuffer.length;
        if (buffer[start] === 45 && buffer[start + 1] === 45) break; // '--'

        if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
        else if (buffer[start] === 10) start += 1;

        const headerEnd1 = buffer.indexOf(Buffer.from('\r\n\r\n'), start);
        const headerEnd2 = buffer.indexOf(Buffer.from('\n\n'), start);
        let headerEnd = -1;
        let headerLen = 4;

        if (headerEnd1 !== -1 && (headerEnd2 === -1 || headerEnd1 < headerEnd2)) {
          headerEnd = headerEnd1;
          headerLen = 4;
        } else if (headerEnd2 !== -1) {
          headerEnd = headerEnd2;
          headerLen = 2;
        }

        if (headerEnd === -1) break;

        const headers = buffer.toString('utf8', start, headerEnd);
        start = headerEnd + headerLen;

        const nextIdx = buffer.indexOf(boundaryBuffer, start);
        if (nextIdx === -1) break;

        let bodyEnd = nextIdx;
        if (buffer[bodyEnd - 2] === 13 && buffer[bodyEnd - 1] === 10) bodyEnd -= 2;
        else if (buffer[bodyEnd - 1] === 10) bodyEnd -= 1;

        const bodyBuffer = buffer.subarray(start, bodyEnd);
        // `;\s*name=` (anchored on the preceding `;`) rather than bare `name="..."`:
        // the Content-Disposition value is legally allowed to leave name unquoted
        // (`name=file` instead of `name="file"` — seen from a real caller), and an
        // unanchored `name=` pattern would also false-match inside `filename=`.
        const nameMatch = headers.match(/;\s*name=(?:"([^"]*)"|([^;\r\n]+))/i);

        if (nameMatch) {
          const name = (nameMatch[1] ?? nameMatch[2]).trim();
          if (name === 'docType') {
            parsedDocType = bodyBuffer.toString('utf8').trim();
          } else if (name === 'transactionType') {
            parsedTransactionType = bodyBuffer.toString('utf8').trim();
          } else if (name === 'companyName') {
            parsedCompanyName = bodyBuffer.toString('utf8').trim();
          } else if (name === 'companyGSTIN') {
            parsedCompanyGSTIN = bodyBuffer.toString('utf8').trim();
          } else if (name === 'file') {
            const mimeMatch = headers.match(/Content-Type:\s*([^\s\r\n]+)/i);
            const type = mimeMatch ? mimeMatch[1] : 'application/octet-stream';

            const filenameMatch = headers.match(/filename=(?:"([^"]*)"|([^;\r\n]+))/i);
            const filename = filenameMatch ? (filenameMatch[1] ?? filenameMatch[2]).trim() : 'uploaded_file';

            file = new File([bodyBuffer], filename, { type });
          }
        }
      }

      // The loop above ran without throwing but extracted nothing at all —
      // distinct from "caller forgot to attach a file" (which would still
      // have found other fields). This means the boundary this parser
      // computed from the Content-Type header never matched anything in the
      // body, which happens when a caller's HTTP client formats the
      // multipart body in a way this parser doesn't expect. Dump enough of
      // the raw request to diagnose that mismatch without needing the
      // caller to reproduce it with extra instrumentation on their side.
      if (!file && !parsedDocType && !parsedTransactionType && !parsedCompanyName && !parsedCompanyGSTIN) {
        const preview = buffer.subarray(0, 300).toString('utf8').replace(/[^\x20-\x7e\r\n]/g, '.');
        console.warn(
          `[extractHandler] Manual parser found zero multipart parts | ` +
          `content-type="${contentType}" | content-length header="${req.headers.get('content-length')}" | ` +
          `actual body bytes=${buffer.length} | boundary derived="${boundary}" | ` +
          `first 300 bytes of body:\n${preview}`,
        );
      }
    } catch (e: unknown) {
      console.error('[extractHandler] Manual parse error:', e);
      return NextResponse.json(
        { success: false, error: 'Invalid form data. Please upload a PDF or image.' },
        { status: 400 },
      );
    }

    // ── Validation ─────────────────────────────────────────────────────────────
    const receivedFields: Record<string, string> = {
      docType: parsedDocType,
      transactionType: parsedTransactionType,
      companyName: parsedCompanyName,
      companyGSTIN: parsedCompanyGSTIN,
    };

    if (!file) {
      logValidationFailure(file, receivedFields, 'no file field present');
      return NextResponse.json(
        { success: false, error: 'No file uploaded. Please select a PDF or image.' },
        { status: 400 },
      );
    }

    let docType: DocumentType;
    if (options.fixedDocType) {
      docType = options.fixedDocType;
    } else {
      let provided = parsedDocType || null;

      // Fallback for external apps that send transactionType instead of docType
      if (!provided) {
        if (parsedTransactionType === 'sale') provided = 'SALES_INVOICE';
        else if (parsedTransactionType === 'purchase') provided = 'PURCHASE_INVOICE';
      }

      if (!provided || !options.allowedDocTypes.includes(provided as DocumentType)) {
        const choices = humanJoin(options.allowedDocTypes.map(dt => DOC_TYPE_LABELS[dt]));
        logValidationFailure(file, receivedFields, `docType/transactionType did not resolve to one of: ${choices}`);
        return NextResponse.json(
          { success: false, error: `Invalid document type. Choose ${choices}.` },
          { status: 400 },
        );
      }
      docType = provided as DocumentType;
    }

    const mimeType = file.type || 'application/octet-stream';
    if (!ALLOWED_MIME.includes(mimeType)) {
      logValidationFailure(file, receivedFields, `unsupported MIME type "${mimeType}"`);
      return NextResponse.json(
        { success: false, error: `Unsupported file type: ${mimeType}. Please upload a PDF or image (JPEG, PNG, WEBP, TIFF).` },
        { status: 400 },
      );
    }

    const maxSizeBytes = mimeType === 'application/pdf' ? MAX_PDF_SIZE_BYTES : MAX_IMAGE_SIZE_BYTES;
    if (file.size > maxSizeBytes) {
      logValidationFailure(file, receivedFields, `file too large (${file.size} bytes > ${maxSizeBytes} byte cap)`);
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
    let incompleteChunks: IncompleteChunk[] | undefined;

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
      incompleteChunks = result.incompleteChunks;
      // Never cache a result where one or more pages permanently failed
      // (e.g. a burst of Mistral-side 502s) — the whole-file cache exists to
      // instantly replay content we've already read CORRECTLY. Caching an
      // incomplete result would mean a caller's retry (specifically trying
      // to get the missing page this time) just gets served the same
      // incomplete data back again instead of a fresh attempt.
      if (!incompleteChunks) {
        setCached(docType, fileHash, rows, bankSummary ? { bankSummary: JSON.stringify(bankSummary) } : undefined);
      }
    }
    const processingTimeMs = Date.now() - startedAt;

    const columns = SCHEMAS[docType].columns;
    const companyName = parsedCompanyName;
    const companyGSTIN = parsedCompanyGSTIN;

    const responsePayload: any = {
      success: true,
      docType,
      rowCount: rows.length,
      columns,
      data: rows,
      processingTimeMs,
      cached: servedFromCache,
    };

    if (companyName) responsePayload.companyName = companyName;
    if (companyGSTIN) responsePayload.companyGSTIN = companyGSTIN;
    if (bankSummary) responsePayload.bankSummary = bankSummary;
    if (incompleteChunks) {
      // Deliberately still a 200 with success:true — most of the document
      // WAS extracted successfully and that data is real and usable — but
      // this field must never be silently dropped by a caller that only
      // checks `success`. rowCount/data reflect only the pages that
      // succeeded; whichever chunk(s) are listed here contributed nothing.
      responsePayload.incompleteChunks = incompleteChunks;
      responsePayload.warning =
        `${incompleteChunks.length} of ${incompleteChunks[0].totalChunks} page(s) could not be extracted after repeated retries ` +
        `(likely a temporary issue with the OCR provider) — the data below is INCOMPLETE. Re-uploading the same file will retry the missing page(s).`;
    }

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
