// ─────────────────────────────────────────────────────────────────────────────
// Mistral OCR SDK wrapper.
//
// For PDFs  → upload file → get signed URL → ocr.process with document_url
// For images → ocr.process directly with image_url (base64 data URL)
//
// The document_annotation_format + document_annotation_prompt parameters
// instruct the model to return structured JSON matching our schemas.
// ─────────────────────────────────────────────────────────────────────────────
import { Mistral } from '@mistralai/mistralai';
import { PDFDocument } from 'pdf-lib';
import PQueue from 'p-queue';
import { SCHEMAS, type DocumentType } from './schemas';
import { suggestBankLedger } from './ledger';
import { hashFile, getCachedChunk, setCachedChunk } from './ocrCache';

// ── Multi-key load balancing ────────────────────────────────────────────────
// Mistral enforces capacity/throughput limits per API key/account tier (the
// 429 "Service tier capacity exceeded" errors). A single deployment serving
// many concurrent users can outrun one key's allocation even with sensible
// concurrency limits. If more than one key is available (comma-separated in
// MISTRAL_API_KEYS), we spread OCR calls across all of them, always picking
// whichever key currently has the fewest requests in flight ("least
// connections"). With a single key configured this collapses to exactly the
// previous single-client behavior — nothing changes for that setup.
function parseApiKeys(): string[] {
  const multi = process.env.MISTRAL_API_KEYS;
  if (multi && multi.trim()) {
    return multi.split(',').map(k => k.trim()).filter(Boolean);
  }
  const single = process.env.MISTRAL_API_KEY;
  return single ? [single] : [];
}

interface KeyPoolEntry {
  key: string;
  client: Mistral;
  inFlight: number;
}

class MistralKeyPool {
  private entries: KeyPoolEntry[];

  constructor(keys: string[]) {
    // Keep at least one (possibly empty-key) entry so the module can load
    // even with no key configured yet — route handlers are responsible for
    // rejecting requests up front via hasMistralApiKey() before any of this
    // is reached, matching the previous behavior.
    this.entries = (keys.length > 0 ? keys : ['']).map(key => ({
      key,
      client: new Mistral({ apiKey: key }),
      inFlight: 0,
    }));
  }

  get size(): number {
    return this.entries.filter(e => e.key).length;
  }

  /**
   * Reserve the least-busy key not in `excludeKeys`. Falls back to the
   * least-busy key overall if every key is excluded (e.g. a single-key
   * pool, or every key has already failed this round) — we'd rather retry
   * on a known-constrained key than fail outright.
   */
  acquire(excludeKeys: Set<string> = new Set()): { key: string; client: Mistral; release: () => void } {
    const candidates = this.entries.filter(e => !excludeKeys.has(e.key));
    const pool = candidates.length > 0 ? candidates : this.entries;

    let chosen = pool[0];
    for (const entry of pool) {
      if (entry.inFlight < chosen.inFlight) chosen = entry;
    }
    chosen.inFlight++;

    let released = false;
    return {
      key: chosen.key,
      client: chosen.client,
      release: () => {
        if (released) return;
        released = true;
        chosen.inFlight = Math.max(0, chosen.inFlight - 1);
      },
    };
  }
}

const keyPool = new MistralKeyPool(parseApiKeys());

/** Whether at least one non-empty Mistral API key is configured. Routes should check this before enqueueing work. */
export function hasMistralApiKey(): boolean {
  return keyPool.size > 0;
}

/** Number of distinct Mistral API keys available for load balancing (1 = no load balancing, just the one key). */
export function getMistralKeyCount(): number {
  return keyPool.size;
}

const OCR_MODEL = 'mistral-ocr-latest';

// Pages per chunk, per document type. Each chunk costs a fixed per-request
// overhead (upload round-trip, signed-URL mint, connection setup)
// independent of how many pages it contains, so fewer/larger chunks means
// fewer of those fixed costs for the same document — but larger chunks also
// mean more content competing for the same per-call output budget, and the
// Mistral SDK exposes no signal (no finish-reason/truncation flag, no token
// usage — confirmed against its response types) telling us if a chunk's
// annotation was quietly cut short before covering every row. That failure
// mode is invisible: the JSON still parses cleanly, just with fewer rows
// than the source actually contains, so it can only be prevented, not
// detected after the fact.
//
// Bank statements are the risk case: dense multi-line MMT/IMPS/NEFT/UPI
// narrations mean each page can pack in far more transactions (and far more
// output tokens) than a page of almost anything else. This value chased the
// missing/mismatched-amount bug down through 8 → 5 → 3 → 2, each round
// reducing but not eliminating it — every size still let MORE THAN ONE page
// share a single OCR call, and multi-page calls were themselves the
// unreliable case. Direct user-reported comparisons were consistent: a
// single page reliably reconciles exactly (every entry, every amount); 2+
// pages in one call did not, even well under any previously-suspected
// density ceiling. So this is now 1 — every bank statement page gets its
// own OCR call, no exceptions, regardless of total document length. More
// requests, more calls (mitigated by CHUNK_CONCURRENCY below and the
// retry/multi-key infrastructure elsewhere in this file), but this is the
// only value with direct evidence of being reliably exact.
//
// Invoices are the opposite case: real invoices are essentially always 1-2
// pages, so a generous size here means splitPdf()'s `totalPages <=
// pagesPerChunk` short-circuit almost always applies and they're never
// actually split — while still keeping a cap well under the ~30-page
// threshold that caused outright capacity rejections before chunking
// existed, in case an unusually long itemized invoice ever shows up.
const PAGES_PER_CHUNK: Record<DocumentType, number> = {
  BANK_STATEMENT: 1,
  // Invoices are almost always 1-2 pages — set high enough to never split them,
  // eliminating the extra upload round-trip overhead of chunking entirely.
  SALES_INVOICE: 50,
  PURCHASE_INVOICE: 50,
};

// Per-document-type chunk concurrency.
// Bank statements use PAGES_PER_CHUNK=1 (every page = its own OCR call). Running
// those 3 at a time (the old default) caused some pages to not be fully analyzed
// before results were collected — making them sequential (concurrency=1) ensures
// every page is processed completely before the next one starts.
// Invoices use PAGES_PER_CHUNK=50 so they're almost never split at all; the
// concurrency setting doesn't matter much, but keep it at 3 for safety.
const CHUNK_CONCURRENCY: Record<DocumentType, number> = {
  BANK_STATEMENT: 1,
  SALES_INVOICE: 3,
  PURCHASE_INVOICE: 3,
};

// ── Retry helper ────────────────────────────────────────────────────────────
// Mistral's OCR endpoint occasionally returns transient 429/500/502/503/504
// errors under load (their infra, not our request). We retry those with
// exponential backoff + jitter so a flaky chunk doesn't fail the whole
// document, while non-retryable errors (bad auth, bad schema, 4xx) fail fast.
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract an HTTP status code from an error, whether it's a typed Mistral
 * SDK error (which carries `.statusCode`), our own upload error (which we
 * attach `.statusCode` to below), or a plain Error whose message happens to
 * contain "Status NNN" (fallback for anything we haven't typed yet).
 */
function getErrorStatusCode(err: any): number | undefined {
  if (typeof err?.statusCode === 'number') return err.statusCode;
  const match = /status[:\s]+(\d{3})/i.exec(err?.message ?? '');
  return match ? Number(match[1]) : undefined;
}

/**
 * Mistral occasionally rejects a file we JUST uploaded because its own
 * backend hasn't finished propagating the write yet — the file record
 * isn't queryable/fetchable for a brief moment right after the upload
 * response comes back. We've seen Mistral word this three different ways
 * so far:
 *   - HTTP 400 "invalid_request_file" (error code 3310), "File could not
 *     be fetched from url ..." — the OCR endpoint reading the signed URL.
 *   - HTTP 404, "File not found" — the Files API's getSignedUrl() call.
 *   - HTTP 404, "No file matches the given query." — same endpoint, a
 *     different wording for the identical condition.
 * Rather than keep chasing each new wording variant one at a time, detect
 * this generically: ANY 404 from a `/v1/files/...` request is this race,
 * because we only ever query a file by an ID we ourselves just created —
 * there's no legitimate "permanently missing" file to misclassify here.
 * All variants resolve themselves on retry (each retry re-uploads and
 * mints a fresh signed URL), so treat them as transient despite the
 * non-5xx status codes.
 */
function isFilePropagationRaceError(err: any): boolean {
  const message: string = err?.message ?? '';
  if (/File could not be fetched/i.test(message)) return true;
  if (/File not found/i.test(message)) return true;
  if (/No file matches/i.test(message)) return true;

  const status = getErrorStatusCode(err);
  const requestUrl: string = err?.rawResponse?.url ?? '';
  if (status === 404 && requestUrl.includes('/v1/files/')) return true;

  try {
    const body = JSON.parse(err?.body ?? '');
    if (body?.code === '3310' || body?.type === 'invalid_request_file') return true;
    if (typeof body?.detail === 'string' && /file not found|no file matches/i.test(body.detail)) return true;
  } catch {
    // err.body wasn't JSON — nothing more to check.
  }

  return false;
}

/**
 * True for errors worth retrying: known transient HTTP status codes,
 * network-level failures (connection reset, timeout, DNS hiccup) that carry
 * no status code at all, or the file-propagation race above.
 */
function isRetryableError(err: any): boolean {
  if (isFilePropagationRaceError(err)) return true;

  const status = getErrorStatusCode(err);
  if (status !== undefined) return RETRYABLE_STATUS_CODES.has(status);

  const name = err?.name ?? '';
  const message = err?.message ?? '';
  return (
    name === 'ConnectionError' ||
    name === 'RequestTimeoutError' ||
    name === 'UnexpectedClientError' ||
    /ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch failed/i.test(message)
  );
}

/** Reads a `Retry-After` response header (seconds) off a Mistral SDK error, if present. */
function getRetryAfterMs(err: any): number | null {
  const headerValue = err?.headers?.get?.('retry-after');
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

interface RetryOptions {
  label: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Runs `fn`, retrying on transient errors with exponential backoff + jitter.
 * Non-retryable errors (bad request, auth, schema issues) throw immediately.
 */
async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const { label, maxAttempts = 5, baseDelayMs = 2000, maxDelayMs = 20000 } = opts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const isLastAttempt = attempt === maxAttempts;
      if (isLastAttempt || !isRetryableError(err)) {
        if (isLastAttempt && isRetryableError(err)) {
          // Exhausted every retry on an error we normally expect to clear
          // within a second or two (propagation races, transient 5xx).
          // Surviving all attempts is a strong signal this particular
          // failure ISN'T transient — check the key/fileId below against
          // Mistral's dashboard (billing/credit status, key permissions)
          // rather than assuming another retry round would help.
          const diag = [
            err?.mistralKeyMasked ? `key=${err.mistralKeyMasked}` : null,
            err?.mistralFileId ? `fileId=${err.mistralFileId}` : null,
          ].filter(Boolean).join(' ');
          console.error(
            `[Mistral OCR] ${label} still failing after all ${maxAttempts} attempts${diag ? ` [${diag}]` : ''} — ` +
            `giving up. If this recurs, check Mistral account billing/credit status and API key validity.`,
          );
        }
        throw err;
      }

      const status = getErrorStatusCode(err);
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = backoff * (0.25 + Math.random() * 0.5); // 25-75% jitter
      // If the caller already knows the next attempt will hit a different,
      // non-constrained resource (e.g. it switched to a spare API key after
      // a 429), it can set err.fastRetryHintMs to skip the normal
      // capacity-recovery backoff — there's nothing to wait out anymore.
      const delay = err?.fastRetryHintMs ?? getRetryAfterMs(err) ?? Math.round(jitter);

      // mistralFileId / mistralKeyMasked (see uploadAndGetSignedUrl / the
      // per-chunk catch blocks) — if a failure like this keeps recurring
      // across ALL retry attempts instead of resolving within one or two
      // (a brief propagation race normally clears in under a second), these
      // are the first things to check: is it always the same key (a
      // specific key with a billing/permission problem) or does it persist
      // even across different keys and completely different files (an
      // account-level restriction, e.g. exhausted trial credit)?
      const diag = [
        err?.mistralKeyMasked ? `key=${err.mistralKeyMasked}` : null,
        err?.mistralFileId ? `fileId=${err.mistralFileId}` : null,
      ].filter(Boolean).join(' ');

      console.warn(
        `[Mistral OCR] ${label} failed on attempt ${attempt}/${maxAttempts}` +
        `${status ? ` (status ${status})` : ''}${diag ? ` [${diag}]` : ''}: ${err.message}. Retrying in ${(delay / 1000).toFixed(1)}s...`,
      );
      await sleep(delay);
    }
  }

  // Unreachable — loop either returns or throws — but keeps TS happy.
  throw new Error(`[Mistral OCR] ${label} failed after ${maxAttempts} attempts.`);
}

/**
 * Determine whether the given MIME type is a PDF.
 */
function isPdf(mimeType: string): boolean {
  return mimeType === 'application/pdf';
}

/**
 * Upload a file to Mistral's file store and return a temporary signed URL.
 * Used for PDFs since the OCR endpoint requires a URL for multi-page documents.
 * Takes an explicit client + API key so callers can route this through
 * whichever pooled key the load balancer picked for this attempt.
 */
async function uploadAndGetSignedUrl(file: File, client: Mistral, apiKey: string): Promise<string> {
  // We bypass client.files.upload() here because the Mistral SDK internally
  // reconstructs File/Blob objects, which triggers an "expected non-null
  // body source" bug in Next.js's undici fetch polyfill. Using native
  // Next.js fetch with native FormData works flawlessly.
  const formData = new FormData();
  formData.append('file', file);
  formData.append('purpose', 'ocr');

  const uploadRes = await fetch('https://api.mistral.ai/v1/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!uploadRes.ok) {
    const errorText = await uploadRes.text();
    const uploadError = new Error(`Mistral file upload failed (${uploadRes.status}): ${errorText}`);
    (uploadError as any).statusCode = uploadRes.status;
    throw uploadError;
  }

  const uploaded = await uploadRes.json();

  try {
    const signed = await client.files.getSignedUrl({
      fileId: uploaded.id,
    });
    return signed.url;
  } catch (err: any) {
    // Attach which file/key this failure was for — if this keeps recurring
    // (especially surviving all retry attempts, unlike a brief propagation
    // race), that's diagnostic evidence worth checking against Mistral's
    // dashboard: a specific bad/unbilled key, or an account-level restriction.
    err.mistralFileId = uploaded.id;
    throw err;
  }
}

/** Last 4 chars only — enough to tell keys apart in logs without exposing the secret. */
function maskApiKey(key: string): string {
  if (!key) return '(no key configured)';
  return key.length <= 4 ? '****' : `****${key.slice(-4)}`;
}

/**
 * Build the documentAnnotationFormat object in the shape the SDK expects:
 *
 *   { type: 'json_schema', jsonSchema: { name, schemaDefinition } }
 *
 * The SDK outbound schema remaps:
 *   jsonSchema → json_schema   (on ResponseFormat)
 *   schemaDefinition → schema  (on JsonSchema)
 */
function buildAnnotationFormat(schemaObj: object, schemaName: string) {
  return {
    type: 'json_schema' as const,
    jsonSchema: {
      name: schemaName,
      schemaDefinition: schemaObj,
      strict: false,
    },
  };
}

/**
 * Split a PDF File into smaller chunks of `pagesPerChunk` pages each.
 * Returns an array of File objects, each representing a chunk.
 */
async function splitPdf(file: File, pagesPerChunk: number): Promise<File[]> {
  const arrayBuffer = await file.arrayBuffer();
  // Many bank-issued PDFs are flagged "encrypted" purely for owner-password
  // restrictions (block editing/printing) with no user password required to
  // open them at all. pdf-lib refuses to load anything flagged encrypted by
  // default; ignoreEncryption lets it proceed for exactly that common case.
  // A PDF that genuinely requires a password to decrypt its content streams
  // would still fail later (pdf-lib doesn't implement content decryption),
  // surfacing as a clearer downstream error instead of this load-time one.
  const pdfDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
  const totalPages = pdfDoc.getPageCount();

  if (totalPages <= pagesPerChunk) {
    return [file];
  }

  if (pdfDoc.isEncrypted) {
    // `ignoreEncryption` above only bypasses pdf-lib's load-time exception —
    // it does NOT actually decrypt content streams (pdf-lib has no
    // decryption support at all, confirmed in its parser source). Copying
    // pages out of a genuinely encrypted PDF via copyPages()/save() would
    // silently carry the still-ciphertext stream bytes into a new PDF with
    // no encryption dictionary, corrupting every chunk without erroring
    // here — the corruption only surfaces later as a confusing failure from
    // Mistral. Since we can't safely chunk it, send the original file to
    // Mistral as a single request instead and let its backend handle
    // standard PDF decryption itself (permission-restricted bank statements
    // almost always use an empty user password, which any real PDF reader,
    // Mistral's backend included, decrypts transparently). This only risks
    // hitting Mistral's own capacity limit for unusually large encrypted
    // documents (~30+ pages) — that surfaces as a normal, already-handled
    // retryable/reported error rather than silent data corruption.
    console.warn(
      `[Mistral OCR] PDF is encrypted (${totalPages} pages, over the ${pagesPerChunk}-page chunk size) — ` +
      `pdf-lib cannot decrypt content streams to split it safely, so sending it to Mistral as a single ` +
      `request instead of chunking.`,
    );
    return [file];
  }

  const chunks: File[] = [];
  for (let i = 0; i < totalPages; i += pagesPerChunk) {
    const newPdf = await PDFDocument.create();
    const end = Math.min(i + pagesPerChunk, totalPages);

    const pageIndices = Array.from({ length: end - i }, (_, idx) => i + idx);
    const copiedPages = await newPdf.copyPages(pdfDoc, pageIndices);

    for (const page of copiedPages) {
      newPdf.addPage(page);
    }

    const pdfBytes = await newPdf.save();
    const chunkFile = new File([pdfBytes as any], `${file.name}-chunk-${i / pagesPerChunk + 1}.pdf`, {
      type: 'application/pdf',
    });
    chunks.push(chunkFile);
  }

  return chunks;
}

// Matches a DD/MM/YYYY-ish date at the start of a markdown table row/line —
// virtually every bank statement transaction row begins with its date, so
// counting these gives a rough, independent estimate of how many
// transaction rows a page actually contains, using the raw OCR text
// Mistral already returns alongside (not instead of) the structured JSON
// annotation (`ocrResponse.pages[].markdown` — confirmed present on every
// OCR response, at no extra cost to request).
const DATE_LINE_PATTERN = /(?:^|\|)\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/gm;

/**
 * Rough, independent sanity check for bank statement chunks: count
 * date-led lines across the chunk's raw markdown and compare against how
 * many transaction rows the structured annotation actually produced. This
 * is a heuristic (not every date-led line is a transaction, and formats
 * vary), so it's diagnostic-only — logged as a warning, not acted on
 * automatically — but it's evidence from the SAME API call at no extra
 * cost, and the Mistral SDK offers no better signal for detecting an
 * annotation that came back short (see PAGES_PER_CHUNK's comment above).
 */
function warnIfRowCountLooksShort(ocrResponse: any, actualRowCount: number, label: string): void {
  try {
    const markdown = (ocrResponse?.pages ?? []).map((p: any) => p?.markdown ?? '').join('\n');
    const estimated = (markdown.match(DATE_LINE_PATTERN) ?? []).length;
    // Only flag a meaningful, not-just-noise shortfall.
    if (estimated >= 5 && actualRowCount < estimated * 0.7) {
      console.warn(
        `[Mistral OCR] ${label}: extracted ${actualRowCount} transaction row(s), but the raw page text has ` +
        `roughly ${estimated} date-led line(s) — this chunk's annotation may have come back incomplete.`,
      );
    }
  } catch {
    // Diagnostic-only — never let this check itself break extraction.
  }
}

interface ExtractedAnnotation {
  rows: Record<string, string>[];
  /** Only meaningful for BANK_STATEMENT — '' when this chunk's page(s) didn't show it. */
  openingBalance: string;
  /** Only meaningful for BANK_STATEMENT — '' when this chunk's page(s) didn't show it. */
  closingBalance: string;
  TotalCGSTAmount?: string;
  TotalSGSTAmount?: string;
  TotalIGSTAmount?: string;
}

/**
 * Helper to parse and extract rows (and, for bank statements, any visible
 * opening/closing balance) from the Mistral OCR response.
 */
function extractRowsFromOcrResponse(ocrResponse: any): ExtractedAnnotation {
  let annotation: any = ocrResponse?.documentAnnotation ?? null;

  if (!annotation) {
    for (const page of ocrResponse?.pages ?? []) {
      if (page.documentAnnotation) {
        annotation = page.documentAnnotation;
        break;
      }
    }
  }

  if (!annotation) {
    console.error('[Mistral OCR] Full response:', JSON.stringify(ocrResponse, null, 2));
    throw new Error(
      'Mistral OCR did not return a document annotation. ' +
      'Ensure the document contains readable text and the model supports structured annotations.',
    );
  }

  const parsed: any = typeof annotation === 'string' ? JSON.parse(annotation) : annotation;
  const rows: Record<string, string>[] = parsed?.transactions ?? [];

  if (!Array.isArray(rows)) {
    throw new Error('OCR annotation did not return a "transactions" array.');
  }

  return {
    rows,
    openingBalance: typeof parsed?.openingBalance === 'string' ? parsed.openingBalance : '',
    closingBalance: typeof parsed?.closingBalance === 'string' ? parsed.closingBalance : '',
    TotalCGSTAmount: typeof parsed?.TotalCGSTAmount === 'string' ? parsed.TotalCGSTAmount : undefined,
    TotalSGSTAmount: typeof parsed?.TotalSGSTAmount === 'string' ? parsed.TotalSGSTAmount : undefined,
    TotalIGSTAmount: typeof parsed?.TotalIGSTAmount === 'string' ? parsed.TotalIGSTAmount : undefined,
  };
}

// Which columns per document type hold decimal amounts, and therefore need
// normalizeAmount() applied after extraction.
const NUMERIC_FIELDS: Record<DocumentType, string[]> = {
  BANK_STATEMENT: ['Debit', 'Credit'],
  SALES_INVOICE: ['Quantity', 'Rate', 'TaxableValue', 'CGSTAmount', 'SGSTAmount', 'IGSTAmount'],
  PURCHASE_INVOICE: ['Quantity', 'Rate', 'TaxableValue', 'CGSTAmount', 'SGSTAmount', 'IGSTAmount'],
};

/**
 * Normalizes a numeric amount string the model returned, fixing the one
 * failure mode that's actually recoverable from the string alone: the model
 * occasionally writes the decimal separator as a comma instead of a dot
 * (e.g. "25,05" instead of "25.05"). We can tell that apart from a genuine
 * thousands-separator comma because a real thousands group is always 2-3
 * digits, never a 1-2 digit trailing group at the very end of the string.
 *
 * We deliberately do NOT try to "fix" a value that has no separator at all
 * (e.g. "2505" when the source was "25.05") — there's no way to tell that
 * apart from a genuine whole-rupee amount of 2505 without guessing, and a
 * wrong guess would silently corrupt correct data. That case has to be
 * prevented at the source (see the schema's `pattern` + prompt wording in
 * schemas.ts) rather than patched after the fact.
 */
function normalizeAmount(value: string | undefined): string {
  if (!value) return value ?? '';
  let v = value.trim();
  if (!v) return v;

  v = v.replace(/[₹$]|Rs\.?|INR/gi, '').trim();

  const misreadDecimal = /^(\d{1,3}(?:,\d{2,3})*),(\d{1,2})$/.exec(v);
  if (misreadDecimal) {
    v = `${misreadDecimal[1].replace(/,/g, '')}.${misreadDecimal[2]}`;
  } else {
    v = v.replace(/,/g, '');
  }

  return v;
}

/**
 * Removes exact-duplicate transaction rows (same DATE, DESCRIPTION,
 * CHEQUE_NO, Debit, and Credit). Real IMPS/NEFT/UPI narrations embed a
 * unique reference number in DESCRIPTION (see ledger.ts), so a full-field
 * match is a strong, safe signal of a genuine duplicate rather than two
 * coincidentally similar transactions — guards against the same
 * transaction being reported by two adjacent chunks when it visually sits
 * near a chunk's page boundary.
 */
// How many already-kept rows to compare a candidate against. A genuine
// chunk-boundary duplicate always lands immediately adjacent to its twin in
// the merged sequence (the last row of chunk N and the first row of chunk
// N+1) — a small window catches that reliably. A GLOBAL de-duplication (any
// match anywhere in the whole document) does not: a large statement is far
// more likely to contain a genuinely recurring transaction — the same bank
// fee, the same recurring UPI payment — sharing an identical date,
// description, and amount purely by coincidence, and a global check would
// silently delete that second, legitimate occurrence. That's the mechanism
// behind "small statements reconcile exactly, large ones come up short":
// more transactions means more chances for an innocent coincidental repeat,
// which a global de-dup misreads as a boundary artifact.
const DEDUP_WINDOW = 3;

function dedupeBankStatementRows(rows: Record<string, string>[]): Record<string, string>[] {
  const rowKey = (row: Record<string, string>) =>
    [row.DATE, row.DESCRIPTION, row.CHEQUE_NO, row.Debit, row.Credit].join('|');

  const deduped: Record<string, string>[] = [];
  let removed = 0;

  for (const row of rows) {
    const key = rowKey(row);
    const isAdjacentDuplicate = deduped
      .slice(-DEDUP_WINDOW)
      .some(kept => rowKey(kept) === key);

    if (isAdjacentDuplicate) {
      removed++;
      continue;
    }
    deduped.push(row);
  }

  if (removed > 0) {
    console.warn(`[Mistral OCR] Removed ${removed} exact-duplicate transaction row(s) immediately adjacent to their twin, consistent with a chunk boundary.`);
  }

  return deduped;
}

export interface BankStatementSummary {
  /** Sum of every extracted Debit value. Always computable from the extracted rows. */
  totalDebit: string;
  /** Sum of every extracted Credit value. Always computable from the extracted rows. */
  totalCredit: string;
  /** The statement's own printed opening balance, if any chunk's page(s) showed it — '' otherwise. */
  openingBalance: string;
  /** The statement's own printed closing balance, if any chunk's page(s) showed it — '' otherwise. */
  closingBalance: string;
  /** totalCredit - totalDebit. What the extracted transactions imply the balance moved by. */
  actualNetChange: string;
  /** closingBalance - openingBalance. Only present when both were found. */
  expectedNetChange?: string;
  /** true/false only when both balances were found and could be compared; null when there isn't enough printed information to check. */
  reconciled: boolean | null;
  /** |expectedNetChange - actualNetChange|, only present when reconciled === false. */
  discrepancy?: string;
}

const RECONCILIATION_TOLERANCE = 0.5; // rupees — accumulated rounding across many rows

/**
 * Cross-checks the sum of extracted transactions against the statement's
 * own printed opening/closing balance, when we managed to capture both.
 * This is the closest thing to "does this match the bank's numbers" we can
 * offer without a human review — best-effort, since not every statement
 * format prints both figures legibly, and OCR misreads on the balance
 * figures themselves aren't impossible either.
 */
function reconcileBankStatement(
  rows: Record<string, string>[],
  openingBalance: string,
  closingBalance: string,
): BankStatementSummary {
  const sum = (field: string) =>
    rows.reduce((total, row) => total + (parseFloat(row[field]) || 0), 0);

  const totalDebit = sum('Debit');
  const totalCredit = sum('Credit');
  const actualNetChange = totalCredit - totalDebit;

  const summary: BankStatementSummary = {
    totalDebit: totalDebit.toFixed(2),
    totalCredit: totalCredit.toFixed(2),
    openingBalance,
    closingBalance,
    actualNetChange: actualNetChange.toFixed(2),
    reconciled: null,
  };

  if (openingBalance && closingBalance) {
    const expectedNetChange = parseFloat(closingBalance) - parseFloat(openingBalance);
    summary.expectedNetChange = expectedNetChange.toFixed(2);

    const diff = Math.abs(expectedNetChange - actualNetChange);
    summary.reconciled = diff <= RECONCILIATION_TOLERANCE;
    if (!summary.reconciled) {
      summary.discrepancy = diff.toFixed(2);
    }
  }

  return summary;
}

export interface RunOcrResult {
  rows: Record<string, string>[];
  /** Only present for BANK_STATEMENT. */
  bankSummary?: BankStatementSummary;
}

/**
 * Run the Mistral OCR pipeline and return the extracted rows.
 *
 * @param file     Native File object from the user upload
 * @param docType  Document type key to select the right schema + prompt
 */
export async function runOcr(
  file: File,
  docType: DocumentType,
): Promise<RunOcrResult> {
  const { schema, prompt } = SCHEMAS[docType];
  const annotationFormat = buildAnnotationFormat(schema, docType.toLowerCase());
  const allRows: Record<string, string>[] = [];
  // First non-empty opening balance / last non-empty closing balance seen
  // across chunks, in page order — the statement's true opening balance is
  // whatever's earliest in reading order; its true closing balance is
  // whatever's latest. Only relevant for BANK_STATEMENT.
  let openingBalance = '';
  let closingBalance = '';
  let invoiceTotals: { cgst?: string, sgst?: string, igst?: string } = {};

  if (isPdf(file.type)) {
    // ── PDF path: split → upload chunks (bounded parallel) → ocr.process → merge ──
    // No cap on page count here: however many pagesPerChunk-page chunks a
    // document splits into, they're all queued below. `chunkQueue` just
    // bounds how many run at once so a 200-page PDF doesn't take dozens of
    // times as long as a single small chunk.
    const pagesPerChunk = PAGES_PER_CHUNK[docType];
    const chunks = await splitPdf(file, pagesPerChunk);
    const chunkConcurrency = CHUNK_CONCURRENCY[docType];
    console.log(
      `[Mistral OCR] PDF split into ${chunks.length} chunks (max ${pagesPerChunk} pages each), ` +
      `processing ${chunkConcurrency === 1 ? 'sequentially (1 at a time)' : `up to ${chunkConcurrency} at a time`}.`,
    );

    const chunkQueue = new PQueue({ concurrency: chunkConcurrency });
    // Indexed rather than pushed-on-completion so merged rows (and
    // opening/closing balance, for bank statements) stay in original page
    // order regardless of which chunk's OCR call finishes first.
    const chunkResults: Record<string, string>[][] = new Array(chunks.length);
    const chunkBalances: { openingBalance: string; closingBalance: string }[] = new Array(chunks.length).fill(null).map(() => ({ openingBalance: '', closingBalance: '' }));

    try {
      await Promise.all(
        chunks.map((chunk, index) =>
          chunkQueue.add(async () => {
            // Exact-content chunk cache: this specific PAGES_PER_CHUNK slice
            // may already have been processed before — from this same
            // document (a retry/resubmission) or a different one that
            // happens to share this chunk byte-for-byte (a corrected
            // re-export, overlapping date-range exports). Safe because it's
            // keyed by content hash, not by "looks like the same bank" — a
            // hit only ever happens for bytes we've genuinely already read.
            const chunkHash = await hashFile(chunk);
            const cached = getCachedChunk(docType, chunkHash);
            if (cached) {
              console.log(`[Mistral OCR] Chunk ${index + 1}/${chunks.length} matched a previously-processed chunk — skipping OCR.`);
              chunkResults[index] = cached.rows;
              chunkBalances[index] = {
                openingBalance: cached.meta?.openingBalance ?? '',
                closingBalance: cached.meta?.closingBalance ?? '',
              };
              if (cached.meta?.TotalCGSTAmount) invoiceTotals.cgst = cached.meta.TotalCGSTAmount;
              if (cached.meta?.TotalSGSTAmount) invoiceTotals.sgst = cached.meta.TotalSGSTAmount;
              if (cached.meta?.TotalIGSTAmount) invoiceTotals.igst = cached.meta.TotalIGSTAmount;
              return;
            }

            console.log(`[Mistral OCR] Processing chunk ${index + 1}/${chunks.length} (${(chunk.size / 1024).toFixed(1)} KB)`);

            // Persists across retry attempts for this chunk (see withRetry's
            // fastRetryHintMs comment): once a key hits capacity, avoid it
            // on subsequent attempts and skip the backoff wait entirely,
            // since a different key isn't affected by the first one's limit.
            const excludeKeys = new Set<string>();

            const ocrResponse = await withRetry(
              async () => {
                const { key, client, release } = keyPool.acquire(excludeKeys);
                try {
                  const signedUrl = await uploadAndGetSignedUrl(chunk, client, key);

                  return await client.ocr.process({
                    model: OCR_MODEL,
                    document: {
                      type: 'document_url',
                      documentUrl: signedUrl,
                    },
                    documentAnnotationFormat: annotationFormat,
                    documentAnnotationPrompt: prompt,
                  } as any);
                } catch (err: any) {
                  if (getErrorStatusCode(err) === 429 && keyPool.size > 1) {
                    excludeKeys.add(key);
                    err.fastRetryHintMs = Math.round(250 + Math.random() * 250);
                  }
                  err.mistralKeyMasked = maskApiKey(key);
                  throw err;
                } finally {
                  release();
                }
              },
              { label: `Chunk ${index + 1}/${chunks.length}` },
            );

            const { rows, openingBalance: chunkOpening, closingBalance: chunkClosing, TotalCGSTAmount, TotalSGSTAmount, TotalIGSTAmount } = extractRowsFromOcrResponse(ocrResponse);
            if (docType === 'BANK_STATEMENT') {
              const chunkLabel = `Chunk ${index + 1}/${chunks.length} (${pagesPerChunk} pages or fewer)`;
              if (rows.length === 0) {
                // Not necessarily a bug (a chunk could genuinely be a blank
                // divider or an opening/closing-only page), but the Mistral
                // SDK gives no way to distinguish that from a chunk whose
                // annotation silently came back incomplete — worth a log
                // trail to correlate against if row counts look short later.
                console.warn(`[Mistral OCR] ${chunkLabel} returned zero transactions.`);
              } else {
                warnIfRowCountLooksShort(ocrResponse, rows.length, chunkLabel);
              }
            }
            if (TotalCGSTAmount) invoiceTotals.cgst = TotalCGSTAmount;
            if (TotalSGSTAmount) invoiceTotals.sgst = TotalSGSTAmount;
            if (TotalIGSTAmount) invoiceTotals.igst = TotalIGSTAmount;
            chunkResults[index] = rows;
            chunkBalances[index] = { openingBalance: chunkOpening, closingBalance: chunkClosing };
            const metaToCache: Record<string, string> = { openingBalance: chunkOpening, closingBalance: chunkClosing };
            if (TotalCGSTAmount) metaToCache.TotalCGSTAmount = TotalCGSTAmount;
            if (TotalSGSTAmount) metaToCache.TotalSGSTAmount = TotalSGSTAmount;
            if (TotalIGSTAmount) metaToCache.TotalIGSTAmount = TotalIGSTAmount;
            setCachedChunk(docType, chunkHash, rows, metaToCache);
          }),
        ),
      );
    } catch (err) {
      // Don't start chunks that haven't been picked up yet once the document
      // is doomed to fail anyway — no point spending more Mistral calls on it.
      chunkQueue.clear();
      throw err;
    }

    // First non-empty opening balance / last non-empty closing balance,
    // walked in page order — see the comment above openingBalance's
    // declaration for why "first"/"last" rather than "any".
    for (const b of chunkBalances) {
      if (!openingBalance && b.openingBalance) openingBalance = b.openingBalance;
      if (b.closingBalance) closingBalance = b.closingBalance;
    }

    for (const rows of chunkResults) {
      allRows.push(...rows);
    }
  } else {
    // ── Image path: base64 data URL → ocr.process ─────────────────────────────
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64 = buffer.toString('base64');
    const dataUrl = `data:${file.type};base64,${base64}`;

    const imageExcludeKeys = new Set<string>();
    const ocrResponse = await withRetry(
      async () => {
        const { client, key, release } = keyPool.acquire(imageExcludeKeys);
        try {
          return await client.ocr.process({
            model: OCR_MODEL,
            document: {
              type: 'image_url',
              imageUrl: dataUrl,
            },
            documentAnnotationFormat: annotationFormat,
            documentAnnotationPrompt: prompt,
          } as any);
        } catch (err: any) {
          if (getErrorStatusCode(err) === 429 && keyPool.size > 1) {
            imageExcludeKeys.add(key);
            err.fastRetryHintMs = Math.round(250 + Math.random() * 250);
          }
          err.mistralKeyMasked = maskApiKey(key);
          throw err;
        } finally {
          release();
        }
      },
      { label: 'Image OCR' },
    );

    const imageResult = extractRowsFromOcrResponse(ocrResponse);
    allRows.push(...imageResult.rows);
    openingBalance = imageResult.openingBalance;
    closingBalance = imageResult.closingBalance;
    if (imageResult.TotalCGSTAmount) invoiceTotals.cgst = imageResult.TotalCGSTAmount;
    if (imageResult.TotalSGSTAmount) invoiceTotals.sgst = imageResult.TotalSGSTAmount;
    if (imageResult.TotalIGSTAmount) invoiceTotals.igst = imageResult.TotalIGSTAmount;
  }

  for (const field of NUMERIC_FIELDS[docType]) {
    for (const row of allRows) {
      if (field in row) row[field] = normalizeAmount(row[field]);
    }
  }
  if (docType === 'BANK_STATEMENT') {
    openingBalance = normalizeAmount(openingBalance);
    closingBalance = normalizeAmount(closingBalance);
  }

  let finalRows = allRows;
  let bankSummary: BankStatementSummary | undefined;

  if (docType === 'BANK_STATEMENT') {
    finalRows = dedupeBankStatementRows(finalRows);

    // The model's own LEDGER guess is inconsistent across calls (see
    // src/lib/ledger.ts for why); override it with a deterministic parse of
    // the narration where the pattern is reliable, falling back to the
    // model's suggestion otherwise.
    for (const row of finalRows) {
      row.LEDGER = suggestBankLedger(row.DESCRIPTION, row.LEDGER);
    }

    bankSummary = reconcileBankStatement(finalRows, openingBalance, closingBalance);
    if (bankSummary.reconciled === false) {
      console.warn(
        `[Mistral OCR] Bank statement reconciliation mismatch: extracted transactions imply a net change of ` +
        `${bankSummary.actualNetChange}, but the statement's own opening (${openingBalance}) and closing ` +
        `(${closingBalance}) balances imply ${bankSummary.expectedNetChange} (difference: ${bankSummary.discrepancy}).`,
      );
    }
  }

  if (docType === 'SALES_INVOICE' || docType === 'PURCHASE_INVOICE') {
    if (invoiceTotals.cgst) invoiceTotals.cgst = normalizeAmount(invoiceTotals.cgst);
    if (invoiceTotals.sgst) invoiceTotals.sgst = normalizeAmount(invoiceTotals.sgst);
    if (invoiceTotals.igst) invoiceTotals.igst = normalizeAmount(invoiceTotals.igst);
    finalRows = consolidateInvoiceRows(finalRows, docType, invoiceTotals);
  }

  return { rows: finalRows, bankSummary };
}

// ── Invoice consolidation ─────────────────────────────────────────────────────
// Groups all rows with the same VoucherNo into a single nested JSON object per
// invoice, matching the external Tally integration format expected by the user.
function consolidateInvoiceRows(
  rows: Record<string, string>[],
  docType: DocumentType,
  invoiceTotals: { cgst?: string, sgst?: string, igst?: string } = {}
): any[] {
  if (rows.length === 0) return rows;

  // Group rows by VoucherNo (falls back to Date if VoucherNo is absent)
  const groups = new Map<string, Record<string, string>[]>();
  for (const row of rows) {
    const key = (row.VoucherNo ?? '').trim() || (row.Date ?? '').trim() || '__ungrouped__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const consolidated: any[] = [];

  const parseNum = (val: string | undefined) => {
    const n = parseFloat(val ?? '');
    return isNaN(n) ? 0 : n;
  };

  const formatYYYYMMDD = (dateStr: string) => {
    if (!dateStr) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr; // Already YYYY-MM-DD

    const parts = dateStr.replace(/-/g, '/').split('/');
    if (parts.length === 3) {
      // Assuming DD/MM/YY or DD/MM/YYYY
      let year = parts[2];
      if (year.length === 2) year = `20${year}`;
      return `${year}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }
    return dateStr;
  };

  for (const [, group] of groups) {
    const first = group[0];

    const totalCgst = invoiceTotals.cgst !== undefined ? parseNum(invoiceTotals.cgst) : group.reduce((sum, row) => sum + parseNum(row.CGSTAmount), 0);
    const totalSgst = invoiceTotals.sgst !== undefined ? parseNum(invoiceTotals.sgst) : group.reduce((sum, row) => sum + parseNum(row.SGSTAmount), 0);
    const totalIgst = invoiceTotals.igst !== undefined ? parseNum(invoiceTotals.igst) : group.reduce((sum, row) => sum + parseNum(row.IGSTAmount), 0);
    const totalTaxable = group.reduce((sum, row) => sum + parseNum(row.TaxableValue), 0);

    const items = group.map(row => ({
      ItemName: row.Item_Name ?? '',
      Quantity: parseNum(row.Quantity) || null,
      Rate: parseNum(row.Rate),
      HSNCode: row.HSNCode ?? '',
      ExtractedAmount: parseNum(row.TaxableValue),
      Per: row.Unit ?? ''
    }));

    let voucherNo = first.VoucherNo ?? '';
    if (voucherNo.toLowerCase().startsWith('dated')) {
      voucherNo = '';
    }

    const mappedRow: any = {
      SupplierInvoiceNo: voucherNo,
      SupplierInvoiceDate: formatYYYYMMDD(first.Date ?? ''),
      PartyLedger: first.PartyLedger ?? '',
      PartyGSTIN: first.PartyGSTIN ?? '',
      "CGST Amount": totalCgst,
      "SGST Amount": totalSgst,
      "IGST Amount": totalIgst,
      Narration: "",
      items,
      TaxableValue: totalTaxable,
      acct_legs: [],
    };

    if (docType === 'SALES_INVOICE') {
      mappedRow.SalesLedger = "";
    } else {
      mappedRow.PurchaseLedger = "";
    }

    consolidated.push({
      timestamp: new Date().toISOString(),
      mappedRow
    });
  }

  return consolidated;
}
