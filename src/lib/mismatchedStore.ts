// ─────────────────────────────────────────────────────────────────────────────
// Saves any PDF/image that the extraction pipeline (local Python parser
// and/or Mistral OCR — whichever apply to the docType) failed to get real
// data from, so a real-world failure can be pulled back and reproduced
// later instead of being an error the caller saw once and nothing else.
// Wired into handleExtractRequest() (src/lib/extractHandler.ts), the single
// shared function behind every /api/extract* route — so this applies
// uniformly whether the file came from the web UI or an external API
// caller, with no per-route change needed.
//
// Best-effort only: saving here must never affect the actual HTTP response
// — a disk error must not turn a normal extraction-failure response into an
// unrelated crash, and a successful save must never change what the caller
// sees either. Callers should invoke this fire-and-forget (`void
// saveMismatchedFile(...)`), never `await` it before responding.
// ─────────────────────────────────────────────────────────────────────────────
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DocumentType } from './schemas';

const MISMATCHED_DIR = path.join(process.cwd(), 'data', 'mismatched');

const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/tiff': '.tiff',
  'image/gif': '.gif',
};

function fileExtension(mimeType: string, originalName: string): string {
  if (EXT_BY_MIME[mimeType]) return EXT_BY_MIME[mimeType];
  const ext = path.extname(originalName);
  return ext || '';
}

/**
 * Writes the failed file plus a small JSON sidecar (original filename,
 * mime type, size, docType, failure reason, timestamp) into
 * data/mismatched/ — same base name, so the two are easy to pair up when
 * looking through the directory. Never throws.
 */
export async function saveMismatchedFile(
  file: File,
  docType: DocumentType,
  reason: string,
): Promise<void> {
  try {
    await fs.mkdir(MISMATCHED_DIR, { recursive: true });

    const id = `${Date.now()}_${randomUUID().slice(0, 8)}`;
    const ext = fileExtension(file.type, file.name);
    const buffer = Buffer.from(await file.arrayBuffer());

    await fs.writeFile(path.join(MISMATCHED_DIR, `${id}${ext}`), buffer);
    await fs.writeFile(
      path.join(MISMATCHED_DIR, `${id}.json`),
      JSON.stringify(
        {
          originalName: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          docType,
          reason,
          savedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    console.warn(`[mismatchedStore] Saved unextracted ${docType} file for review: ${id}${ext} (${reason})`);
  } catch (err) {
    // Diagnostic-only feature — never let a disk/permission problem here
    // surface as (or mask) a real extraction error.
    console.warn('[mismatchedStore] Failed to save mismatched file (non-fatal):', err);
  }
}
