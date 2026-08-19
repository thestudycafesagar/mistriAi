# Mistri AI — Extraction API

Upload a bank statement, sales invoice, or purchase invoice (PDF or image) and get back structured, ready-to-import data as JSON.

> **Base URL:** replace `https://YOUR-DOMAIN` below with the actual hosted URL you were given.

> **⚠️ No authentication.** These endpoints do not currently require an API key. Anyone with the base URL can call them, and each call consumes the server owner's Mistral API credits. Don't publish the base URL anywhere public — treat it like a shared secret.

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/extract/bank-statement` | Extract a bank statement |
| `POST` | `/api/extract/invoice` | Extract a sales or purchase invoice |
| `POST` | `/api/extract` | Generic — same as above, but `docType` picks which one |
| `GET` | `/api/health` | Check the service is up and configured |

Use the two dedicated endpoints unless you have a reason not to — they're simpler (no `docType` needed for bank statements) and mean exactly what they say.

---

## Extracting a document

### Request

`multipart/form-data` with:

| Field | Required | Notes |
|---|---|---|
| `file` | Yes | The PDF or image to extract. PDFs up to 200MB; images up to 25MB. |
| `docType` | Only for `/api/extract/invoice` and `/api/extract` | `"SALES_INVOICE"` or `"PURCHASE_INVOICE"` (invoice endpoint); `"BANK_STATEMENT"`, `"SALES_INVOICE"`, or `"PURCHASE_INVOICE"` (generic endpoint). Omit entirely when calling `/api/extract/bank-statement`. |

Accepted file types: PDF, JPEG, PNG, WEBP, TIFF, GIF.

### curl example

```bash
# Bank statement
curl -X POST https://YOUR-DOMAIN/api/extract/bank-statement \
  -F "file=@statement.pdf"

# Sales invoice
curl -X POST https://YOUR-DOMAIN/api/extract/invoice \
  -F "file=@invoice.pdf" \
  -F "docType=SALES_INVOICE"

# Purchase invoice
curl -X POST https://YOUR-DOMAIN/api/extract/invoice \
  -F "file=@invoice.pdf" \
  -F "docType=PURCHASE_INVOICE"
```

### JavaScript / fetch example

```javascript
const form = new FormData();
form.append('file', fileInput.files[0]); // a File/Blob

const res = await fetch('https://YOUR-DOMAIN/api/extract/bank-statement', {
  method: 'POST',
  body: form,
});
const result = await res.json();

if (result.success) {
  console.log(`${result.rowCount} rows, extracted in ${result.processingTimeMs}ms`);
  console.table(result.data);
} else {
  console.error(result.error);
}
```

### Success response — `200 OK`

```json
{
  "success": true,
  "docType": "BANK_STATEMENT",
  "rowCount": 42,
  "columns": ["DATE", "DESCRIPTION", "CHEQUE_NO", "Debit", "Credit", "Balance", "LEDGER"],
  "data": [
    { "DATE": "01/04/2024", "DESCRIPTION": "...", "CHEQUE_NO": "", "Debit": "500.00", "Credit": "", "Balance": "21334.39", "LEDGER": "..." }
  ],
  "processingTimeMs": 18342,
  "cached": false,
  "bankSummary": {
    "totalDebit": "12345.00",
    "totalCredit": "9800.50",
    "openingBalance": "21334.39",
    "closingBalance": "18789.89",
    "actualNetChange": "-2544.50",
    "expectedNetChange": "-2544.50",
    "reconciled": true
  }
}
```

| Field | Meaning |
|---|---|
| `docType` | Echoes back what was extracted. |
| `rowCount` | Number of rows in `data`. |
| `columns` | Ordered column names — use this to build a table/CSV header rather than hardcoding field names. |
| `data` | Array of row objects. Every row has every column as a key; a field that wasn't present in the source document is an empty string `""`, never a fabricated value. |
| `processingTimeMs` | Server-side time taken for this extraction, in milliseconds. |
| `cached` | `true` if this exact file (by content) was already extracted before and this result was returned instantly without reprocessing. |
| `bankSummary` | Only present when `docType` is `BANK_STATEMENT`. See below. |
| `warning` / `incompleteChunks` | Only present if one or more pages could not be extracted after repeated retries (typically a transient OCR-provider outage) — see below. **Always check for this field even when `success` is `true`** — a `200`/`success:true` response with `incompleteChunks` present means the extraction is genuinely incomplete, not a full success. |

### Partial results (`incompleteChunks`)

If a page permanently fails after 5 retry attempts (e.g. a burst of `502` errors from the OCR provider), the response still returns everything that WAS successfully extracted — a `200` with `success: true` — rather than discarding good data over one bad page. Check for `incompleteChunks` to know whether that happened:

```json
{
  "success": true,
  "rowCount": 118,
  "data": [ ... ],
  "warning": "1 of 20 page(s) could not be extracted after repeated retries (likely a temporary issue with the OCR provider) — the data below is INCOMPLETE. Re-uploading the same file will retry the missing page(s).",
  "incompleteChunks": [
    { "chunk": 5, "totalChunks": 20, "error": "..." }
  ]
}
```
`data`/`rowCount` reflect only the pages that succeeded — whichever page number(s) appear in `incompleteChunks` contributed zero rows. Re-uploading the identical file retries the extraction fresh (a result with `incompleteChunks` is never cached), so simply trying again shortly after is usually enough once the underlying OCR-provider issue clears.

### `bankSummary` (bank statements only)

| Field | Meaning |
|---|---|
| `totalDebit` / `totalCredit` | Sum of every extracted Debit/Credit value. Always present. |
| `openingBalance` / `closingBalance` | The statement's own printed balance figures, when visible in the scanned document. Empty string if not found. |
| `actualNetChange` | `totalCredit - totalDebit` — what the extracted transactions imply the balance moved by. |
| `expectedNetChange` | `closingBalance - openingBalance` — only present when both balances were found. |
| `reconciled` | `true` if `expectedNetChange` and `actualNetChange` match within a small rounding tolerance; `false` if they don't (see `discrepancy`); `null` if the statement didn't show both balances clearly enough to check at all. **`null` means "not verified," not "verified and wrong"** — don't treat it as an error. |
| `discrepancy` | Only present when `reconciled` is `false` — the absolute difference between expected and actual net change. Treat a `false` here as a signal to have a human review the extraction before trusting it. |

### Row shape by document type

**`BANK_STATEMENT`** — `columns`: `DATE`, `DESCRIPTION`, `CHEQUE_NO`, `Debit`, `Credit`, `Balance`, `LEDGER`

- `DATE` — `DD/MM/YYYY`
- `Debit` / `Credit` — plain decimal string (e.g. `"1234.50"`); empty if not applicable to that row
- `Balance` — the running account balance printed on that specific transaction row (not the statement-level `openingBalance`/`closingBalance` in `bankSummary`); plain decimal string, may be negative for an overdrawn account, empty if not visible for that row
- `LEDGER` — suggested accounting ledger name for the transaction counterparty

**`SALES_INVOICE`** / **`PURCHASE_INVOICE`** — `columns`: `Date`, `VoucherNo`, `PartyLedger`, `PartyGSTIN`, `Item_Name`, `HSNCode`, `Quantity`, `Unit`, `Rate`, `TaxableValue`, `CGSTRate`, `CGSTAmount`, `SGSTRate`, `SGSTAmount`, `IGSTRate`, `IGSTAmount`, and `SalesLedger` (sales) or `PurchaseLedger` (purchase)

- One row per line item; invoice-level fields (`Date`, `VoucherNo`, `PartyLedger`, `PartyGSTIN`) repeat on every row belonging to that invoice
- `PartyGSTIN` is the **buyer's** GSTIN for sales invoices, the **supplier's** GSTIN for purchase invoices
- `IGSTRate` / `IGSTAmount` are empty when IGST doesn't apply (intra-state transaction)

### Error responses

```json
{ "success": false, "error": "human-readable message" }
```

| Status | Meaning | What to do |
|---|---|---|
| `400` | Bad request — missing file, invalid/missing `docType`, unsupported file type, or file too large | Fix the request; don't retry as-is |
| `500` | Server error — includes misconfiguration (no Mistral API key set) or an extraction failure that exhausted retries | Safe to retry once; if it persists, contact the server owner |
| `503` | Server is at capacity (too many requests queued) | Back off and retry — see below |

A `503` response includes a `Retry-After` header (seconds). Wait at least that long before retrying.

---

## Health check

```bash
curl https://YOUR-DOMAIN/api/health
```

Returns `200` with `status: "ok"` when the service is running and has a Mistral API key configured; `503` with `status: "degraded"` if it's up but not configured to actually extract anything.

```json
{
  "status": "ok",
  "service": "API chalata BABU"
}
```

No auth required — safe to poll from an uptime monitor.

---

## Notes for integrators

- **Large PDFs take longer.** A multi-page statement is processed in chunks; expect anywhere from a few seconds (a short document, or a repeat of one already processed) to a few minutes (a long one). `processingTimeMs` in the response tells you exactly how long your specific request took.
- **Re-uploading the same file is fast.** If you send the identical file twice (byte-for-byte), the second response comes back instantly (`cached: true`) instead of reprocessing.
- **Ledger names get more consistent over time**, not because the underlying AI model is being retrained (it isn't — that's not how the hosted OCR service works), but because the server remembers counterparty names it has confidently resolved before and reuses them. This is most noticeable for bank statements from accounts you extract repeatedly.
- **Bank statement totals are cross-checked automatically, not just displayed.** `bankSummary.reconciled` tells you whether the sum of extracted transactions actually matches the statement's own printed opening/closing balance — check this field before trusting a bank statement extraction in an automated pipeline. `reconciled: false` means something is likely wrong (a misread amount, a missed row) and the result should go to a human for review rather than straight into accounting software.
- **Concurrent requests are queued, not rejected**, up to a server-configured limit — past that, you'll get a `503` with `Retry-After` rather than an unbounded wait.
- Every field in `data` reflects what was actually printed in the source document. If something's missing from the document (e.g. no invoice number printed), the corresponding field is an empty string rather than a guessed value.
