// ─────────────────────────────────────────────────────────────────────────────
// Exact-duplicate-content result cache, at two granularities:
//
//   1. Whole-file (getCached/setCached): the identical file (same bytes)
//      submitted again for the same document type — a re-upload after a
//      transient failure, someone re-processing a statement they already
//      extracted, a double-submit. Skips Mistral entirely.
//   2. Per-chunk (getCachedChunk/setCachedChunk): a single PAGES_PER_CHUNK
//      slice of a PDF (see mistral.ts) that's byte-identical to a
//      previously-processed chunk, even from a DIFFERENT original file —
//      a corrected re-export where most pages are unchanged, overlapping
//      date-range exports, a resubmission after a network failure partway
//      through. That specific chunk skips Mistral while genuinely new
//      chunks in the same document still get properly read.
//
// Both are safe in the same way: identical bytes in means identical correct
// output out, so reusing a stored result never risks returning stale or
// fabricated data for content that's actually new. This is fundamentally
// different from (and does NOT extend to) "we recognize this bank's
// layout" — a new statement's actual transactions have never been read
// before and must go through OCR regardless of how many prior statements
// from that bank we've processed.
//
// Complementary to ledgerMemory.ts, which is about NEW documents that share
// a *counterparty* with previously-seen ones — a different, safe kind of
// reuse (a name, not a transaction's worth of new facts).
//
// Persistence: JSON files under data/ocr-cache/. Same caveat as
// ledgerMemory.ts — this only accumulates across requests on a persistent
// server process, not on serverless platforms where each invocation may be
// a fresh instance.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { DocumentType } from './schemas';

const CACHE_DIR = join(process.cwd(), 'data', 'ocr-cache');
const CHUNK_CACHE_DIR = join(CACHE_DIR, 'chunks');

export interface CachedResult {
  rows: Record<string, string>[];
  /** Arbitrary small string metadata alongside the rows — e.g. bank-statement openingBalance/closingBalance. */
  meta?: Record<string, string>;
}

interface CacheEntry extends CachedResult {
  docType: DocumentType;
  cachedAt: string;
}

/** SHA-256 of the file's bytes — identical files hash identically regardless of filename. */
export async function hashFile(file: File): Promise<string> {
  const buffer = Buffer.from(await file.arrayBuffer());
  return createHash('sha256').update(buffer).digest('hex');
}

function readEntry(path: string): CachedResult | null {
  try {
    if (!existsSync(path)) return null;
    const entry = JSON.parse(readFileSync(path, 'utf-8')) as CacheEntry;
    return { rows: entry.rows, meta: entry.meta };
  } catch (err) {
    console.warn('[OCR Cache] Failed to read cache entry (treating as a miss):', err);
    return null;
  }
}

function writeEntry(dir: string, path: string, docType: DocumentType, result: CachedResult): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entry: CacheEntry = { docType, rows: result.rows, meta: result.meta, cachedAt: new Date().toISOString() };
    writeFileSync(path, JSON.stringify(entry), 'utf-8');
  } catch (err) {
    // Nice-to-have cache — never let a write failure fail the extraction
    // that already succeeded.
    console.warn('[OCR Cache] Failed to persist cache entry (continuing without caching this result):', err);
  }
}

function cachePath(docType: DocumentType, hash: string): string {
  return join(CACHE_DIR, `${docType}-${hash}.json`);
}

function chunkCachePath(docType: DocumentType, hash: string): string {
  return join(CHUNK_CACHE_DIR, `${docType}-${hash}.json`);
}

/** Returns the cached extraction result for this exact file + docType, or null on a cache miss. */
export function getCached(docType: DocumentType, hash: string): CachedResult | null {
  return readEntry(cachePath(docType, hash));
}

/** Records the extraction result for this exact file + docType for future re-use. */
export function setCached(docType: DocumentType, hash: string, rows: Record<string, string>[], meta?: Record<string, string>): void {
  writeEntry(CACHE_DIR, cachePath(docType, hash), docType, { rows, meta });
}

/** Returns the cached extraction result for this exact PDF chunk + docType, or null on a cache miss. */
export function getCachedChunk(docType: DocumentType, hash: string): CachedResult | null {
  return readEntry(chunkCachePath(docType, hash));
}

/** Records the extraction result for this exact PDF chunk + docType for future re-use. */
export function setCachedChunk(docType: DocumentType, hash: string, rows: Record<string, string>[], meta?: Record<string, string>): void {
  writeEntry(CHUNK_CACHE_DIR, chunkCachePath(docType, hash), docType, { rows, meta });
}
