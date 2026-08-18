// ─────────────────────────────────────────────────────────────────────────────
// p-queue singleton for throttling concurrent document-extraction requests
// (each task is one whole document — the local Python parse attempt for a
// bank statement, or the full Mistral chunked-OCR pipeline for everything
// else). A single shared queue instance is used across ALL API route
// invocations so that simultaneous user uploads are load-balanced across at
// most `concurrency` documents processing in true parallel at once, instead
// of piling up behind a hardcoded, unconfigurable limit.
//
// concurrency: how many documents run at once. Configurable via
// OCR_QUEUE_CONCURRENCY (env, default 4) — this was previously a hardcoded
// constant, meaning changing it required a code edit + rebuild. Made
// configurable specifically so it can be tuned to a given server's actual
// CPU/memory headroom (e.g. a VPS also running several other unrelated
// services, vs. a dedicated box) without touching code. Each concurrent task
// can spawn a Python subprocess (pandas/pdfplumber, occasionally
// cv2/pytesseract for the scanned-PDF OCR fallback) and/or hold an uploaded
// file in memory, so this is a real resource dial, not just a queue-depth
// setting — raise it gradually and watch server memory/CPU, don't jump
// straight to a very high number on a shared/constrained host.
//
// Backpressure: this process serves potentially many concurrent users, each
// task holding an uploaded file (up to MAX_PDF_SIZE_BYTES, see
// src/app/api/extract/route.ts) in memory until it's processed. Without a
// cap, a burst of requests would queue unboundedly and could exhaust server
// memory well before any of them get a chance to run. MAX_QUEUE_SIZE bounds
// how many tasks (running + waiting) are held at once; requests beyond that
// are rejected immediately with a 503 so the caller can back off and retry,
// instead of silently piling up.
// ─────────────────────────────────────────────────────────────────────────────
import PQueue from 'p-queue';

const QUEUE_CONCURRENCY = Number(process.env.OCR_QUEUE_CONCURRENCY) || 4;

// Module-level singleton — created once per Next.js server process.
const ocrQueue = new PQueue({
  concurrency: QUEUE_CONCURRENCY,   // max documents processing in parallel
});

const MAX_QUEUE_SIZE = Number(process.env.OCR_MAX_QUEUE_SIZE) || 20;

// Optional: log queue activity in development
if (process.env.NODE_ENV === 'development') {
  ocrQueue.on('add', () => {
    console.log(`[OCR Queue] Task added — size: ${ocrQueue.size}, pending: ${ocrQueue.pending}`);
  });
  ocrQueue.on('next', () => {
    console.log(`[OCR Queue] Task finished — size: ${ocrQueue.size}, pending: ${ocrQueue.pending}`);
  });
}

/** Thrown by enqueueOcr() when the queue is at capacity — callers should map this to HTTP 503. */
export class QueueSaturatedError extends Error {
  constructor() {
    super(`OCR queue is at capacity (${MAX_QUEUE_SIZE} tasks running or waiting). Try again shortly.`);
    this.name = 'QueueSaturatedError';
  }
}

/** True once running + waiting tasks reach MAX_QUEUE_SIZE — callers should reject new work rather than enqueue it. */
export function isQueueSaturated(): boolean {
  return ocrQueue.size + ocrQueue.pending >= MAX_QUEUE_SIZE;
}

export function getQueueStats() {
  return { size: ocrQueue.size, pending: ocrQueue.pending, concurrency: ocrQueue.concurrency, maxQueueSize: MAX_QUEUE_SIZE };
}

/**
 * Enqueue an async OCR task.
 * Returns a promise that resolves with the task's return value once the task
 * has been picked up by the queue and completed. Throws QueueSaturatedError
 * immediately (without queueing) if the server is already at capacity.
 */
export async function enqueueOcr<T>(fn: () => Promise<T>): Promise<T> {
  if (isQueueSaturated()) {
    throw new QueueSaturatedError();
  }
  return ocrQueue.add(fn) as Promise<T>;
}

export { ocrQueue };
