// ─────────────────────────────────────────────────────────────────────────────
// POST /api/extract/invoice
//
// Dedicated endpoint for external API consumers extracting invoices — both
// sales and purchase invoices are handled here (same line-item shape, just a
// different ledger direction), distinguished by the `docType` field.
//
// Accepts multipart/form-data with:
//   - file     : PDF or image
//   - docType  : 'SALES_INVOICE' | 'PURCHASE_INVOICE'
//
// Response shape (JSON):
//   { timestamp, rawApiResponse: { invoiceNumber, ... }, mappedRow: { ... } }
//   { success: false, error: string }  (4xx/5xx — see status code)
//
// Shares validation/queueing/retry/load-balancing logic with every other
// /api/extract* route via src/lib/extractHandler.ts — nothing here is
// duplicated, so fixes made there apply here automatically.
// ─────────────────────────────────────────────────────────────────────────────
import { NextRequest, NextResponse } from 'next/server';
import { handleExtractRequest, formatInvoiceResponse } from '@/lib/extractHandler';

export const maxDuration = 800;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const res = await handleExtractRequest(req, {
    allowedDocTypes: ['SALES_INVOICE', 'PURCHASE_INVOICE'],
  });
  return formatInvoiceResponse(res);
}
