// ─────────────────────────────────────────────────────────────────────────────
// GET /api/health
//
// Public status check — no auth, no file upload, no Mistral call. Lets a
// caller (uptime monitor, or a human checking the hosted URL is alive)
// confirm the service is running and correctly configured, before they ever
// try to POST a document.
//
// Returns 200 "ok" when the server is up AND has at least one Mistral API
// key configured (i.e. it can actually do its job). Returns 503 "degraded"
// if the process is running but MISTRAL_API_KEY / MISTRAL_API_KEYS is
// missing — up, but unable to extract anything until that's fixed.
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from 'next/server';
import { hasMistralApiKey, getMistralKeyCount } from '@/lib/mistral';
import { getQueueStats } from '@/lib/queue';
import { getLearnedCount } from '@/lib/ledgerMemory';

export async function GET() {
  const configured = hasMistralApiKey();

  const body = {
    status: configured ? 'ok' : 'degraded',
    service: 'API chalata BABU',
  };

  return NextResponse.json(body, { status: configured ? 200 : 503 });
}
