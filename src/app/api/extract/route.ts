// ─────────────────────────────────────────────────────────────────────────────
// POST /api/extract
//
// Generic endpoint used by the web UI AND external API consumers.
// Accepts multipart/form-data with `file` and `docType`.
//
// Response format is auto-detected:
//   - If the request includes a `companyName` field (external app pattern),
//     invoice responses are returned as a flat object with mappedRow embedded.
//   - Otherwise (web UI), the standard { success, columns, data } format is used.
//
// Dedicated single-purpose endpoints also exist:
//   POST /api/extract/bank-statement  (docType is implicit)
//   POST /api/extract/invoice         (always returns flat invoice format)
// ─────────────────────────────────────────────────────────────────────────────
import { NextRequest, NextResponse } from 'next/server';
import { handleExtractRequest, formatInvoiceResponse } from '@/lib/extractHandler';

export const maxDuration = 800;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const res = await handleExtractRequest(req, {
    allowedDocTypes: ['BANK_STATEMENT', 'SALES_INVOICE', 'PURCHASE_INVOICE'],
  });

  if (!res.ok) return res;

  const json = await res.json();

  // If companyName is in the request (external app sends it), format as flat invoice
  if (json.companyName !== undefined && json.success &&
      (json.docType === 'SALES_INVOICE' || json.docType === 'PURCHASE_INVOICE')) {
    return formatInvoiceResponse(NextResponse.json(json));
  }

  return NextResponse.json(json);
}
