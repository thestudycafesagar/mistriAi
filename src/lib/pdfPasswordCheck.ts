// ─────────────────────────────────────────────────────────────────────────────
// Detects a genuinely password-protected PDF (one that can't be opened at
// all without a password) up front, as part of request validation — BEFORE
// either extraction engine (the local Python parser or Mistral) ever
// attempts it. Both would fail on it anyway (Python: pdfplumber/pdfminer
// can't decrypt it either; Mistral: its own backend can't open it), but
// previously with no clear signal why — surfacing instead as a generic
// error, or (after mismatchedStore.ts) as a silent zero-row result saved
// for review with no indication the real cause was simply "wrong/no
// password." This lets extractHandler.ts reject it immediately with a
// specific, actionable message instead.
//
// Reuses parse_bank_statement.py's own pdfplumber/pdfminer-based check
// (Python is already a required runtime dependency of this deployment for
// bank statements — see pythonBankParser.ts) via a fast `--check-only` CLI
// mode that does nothing but this one check — no table extraction — so
// this needs no new dependency and no duplicated detection logic. Applies
// to every docType (bank statement AND both invoice types), since a
// password-protected PDF fails identically regardless of what it contains.
//
// Deliberately does NOT flag a PDF that's merely encrypted for owner-level
// restrictions (printing/editing locked) but opens fine with no password —
// that case already works today via pdf-lib's `ignoreEncryption: true` (see
// the "Encrypted/permission-restricted PDFs" note in mistral.ts) and must
// keep working exactly as before; parse_bank_statement.py's own
// check_password_protected() only ever returns true when pdfminer can't
// open the file's structure at all.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const PYTHON_SCRIPT_PATH = path.join(process.cwd(), 'parse_bank_statement.py');
const TEMP_DIR = path.join(os.tmpdir(), 'mistri-ai-bank-parse');
// This only opens the file's structure to check for encryption, not a full
// parse — nowhere near as slow as tryPythonBankStatementParse()'s own
// 5-minute budget — but still bounded in case the interpreter is missing
// or somehow hangs, so a broken Python setup can never block extraction.
const CHECK_TIMEOUT_MS = 15_000;
// pdfminer's own password-protected exit signal (see the `--check-only`
// mode added to parse_bank_statement.py's __main__).
const PASSWORD_PROTECTED_EXIT_CODE = 3;

/**
 * Returns true only when the PDF genuinely cannot be opened without a
 * password neither engine has. Returns false for anything else — not a
 * PDF, Python/the script unavailable, the check itself failing to run for
 * any reason, or the PDF opening fine — so this can only ever ADD a clear
 * rejection for a case that would otherwise fail anyway, never block a
 * document that could actually be extracted. Fails open, not closed.
 */
export async function isPasswordProtectedPdf(file: File): Promise<boolean> {
  if (file.type !== 'application/pdf') return false;

  const id = randomUUID();
  const inputPath = path.join(TEMP_DIR, `${id}.pdf`);

  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(inputPath, buffer);

    const exitCode = await new Promise<number | null>((resolve) => {
      let child;
      try {
        // turbopackIgnore: PYTHON_SCRIPT_PATH is computed from process.cwd(),
        // same reasoning as pythonBankParser.ts's own spawn() call.
        child = spawn(/*turbopackIgnore: true*/ PYTHON_BIN, [PYTHON_SCRIPT_PATH, inputPath, '--check-only']);
      } catch {
        resolve(null);
        return;
      }

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        resolve(null);
      }, CHECK_TIMEOUT_MS);

      child.on('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(code);
      });
    });

    return exitCode === PASSWORD_PROTECTED_EXIT_CODE;
  } catch {
    return false;
  } finally {
    await fs.unlink(inputPath).catch(() => {});
  }
}
