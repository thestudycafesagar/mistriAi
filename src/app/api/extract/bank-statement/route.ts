// ─────────────────────────────────────────────────────────────────────────────
// POST /api/extract/bank-statement
//
// Dedicated endpoint for external API consumers extracting bank statements.
// Accepts multipart/form-data with just `file` (PDF or image) — no `docType`
// field needed, this endpoint always extracts as BANK_STATEMENT.
//
// Response shape (JSON):
//   { success: true, docType: "BANK_STATEMENT", rowCount, columns, data, processingTimeMs }
//   { success: false, error: string }  (4xx/5xx — see status code)
//
// Shares validation/queueing/retry/load-balancing logic with every other
// /api/extract* route via src/lib/extractHandler.ts — nothing here is
// duplicated, so fixes made there apply here automatically.
// ─────────────────────────────────────────────────────────────────────────────
import { NextRequest, NextResponse } from 'next/server';
import { handleExtractRequest } from '@/lib/extractHandler';

export const maxDuration = 800;

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handleExtractRequest(req, {
    allowedDocTypes: ['BANK_STATEMENT'],
    fixedDocType: 'BANK_STATEMENT',
  });
}
