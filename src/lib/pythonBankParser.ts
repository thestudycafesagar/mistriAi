// ─────────────────────────────────────────────────────────────────────────────
// Local (non-AI) bank-statement parser — runs parse_bank_statement.py as a
// subprocess before falling back to Mistral OCR for BANK_STATEMENT PDFs.
//
// Why: parse_bank_statement.py already does this deterministically and for
// free (pdfplumber for native/text PDFs, Tesseract OCR for scanned ones) — no
// point spending a Mistral call when a local parse already gets the exact
// answer. It doesn't always succeed (Tesseract/Poppler might not be
// installed, or a layout it can't handle), so every failure mode here is
// designed to return null and let the caller fall through to Mistral exactly
// as if this module didn't exist — this must never be the reason a bank
// statement extraction fails outright.
//
// The script's output columns are whatever text the source statement itself
// used as headers (varies bank to bank — "NARRATION" vs "PARTICULARS" vs
// "Remarks", "WITHDRAWAL(DR)" vs "Debit", etc.), not the app's fixed
// DATE/DESCRIPTION/CHEQUE_NO/Debit/Credit/LEDGER schema — normalizePythonRow()
// below maps between them with the same kind of keyword heuristics the
// script already uses internally for its own column detection.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const PYTHON_SCRIPT_PATH = path.join(process.cwd(), 'parse_bank_statement.py');
// Generous: a dense multi-year statement processed through the word-coordinate
// extractor (no gridlines) or the Tesseract OCR path can legitimately take
// tens of seconds to a few minutes. This only bounds the local-parse attempt —
// Mistral is still available as a fallback afterward within the route's own
// maxDuration budget.
const PYTHON_TIMEOUT_MS = Number(process.env.PYTHON_BANK_PARSER_TIMEOUT_MS) || 5 * 60 * 1000;

const TEMP_DIR = path.join(os.tmpdir(), 'mistri-ai-bank-parse');

interface PythonProcessResult {
  ok: boolean;
  /** Combined stdout+stderr tail, for diagnostics — the script reports its own
   *  errors (e.g. "Is poppler installed and in PATH?") via plain print() to
   *  stdout, not stderr, so both have to be captured to see the real reason. */
  output: string;
}

function runPythonProcess(inputPath: string, outputXlsxPath: string): Promise<PythonProcessResult> {
  return new Promise((resolve) => {
    let child;
    try {
      // turbopackIgnore: PYTHON_SCRIPT_PATH is computed from process.cwd(), which
      // Turbopack's build-time file tracer can't resolve statically — without this
      // it conservatively traces (and would bundle) the entire project directory
      // into the server output. The path is a fixed repo-root file, not user input.
      child = spawn(/*turbopackIgnore: true*/ PYTHON_BIN, [PYTHON_SCRIPT_PATH, inputPath, outputXlsxPath]);
    } catch (err) {
      resolve({ ok: false, output: `spawn threw synchronously: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    let output = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ ok: false, output: `${output}\n[timed out after ${PYTHON_TIMEOUT_MS}ms]` });
    }, PYTHON_TIMEOUT_MS);

    child.stdout?.on('data', (d) => { output += d.toString(); });
    child.stderr?.on('data', (d) => { output += d.toString(); });

    // A missing interpreter (ENOENT) or any other spawn-level failure lands here.
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, output: `${output}\n[spawn error] ${err.message}` });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, output });
    });
  });
}

function toStr(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

// Debit/Credit come through as a JSON number (or null) — pandas already
// coerced them via pd.to_numeric. A 0 is treated the same as absent: every
// real transaction has a non-zero amount in exactly one of Debit/Credit
// (mirrors RULE 1 in schemas.ts for the Mistral path), so a 0 here is a
// parsing artifact, not a genuine zero-rupee transaction.
function toAmountStr(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  if (!Number.isFinite(n) || n === 0) return '';
  return n.toFixed(2);
}

// Balance is a running account total, not a Debit/Credit amount — unlike
// toAmountStr() above, a genuine 0.00 balance is real information (an
// account can legitimately sit at zero) and must NOT collapse to blank, and
// a negative value (overdrawn) is valid too.
function toBalanceStr(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  if (!Number.isFinite(n)) return '';
  return n.toFixed(2);
}

const NARRATION_KEYWORDS = ['narration', 'particular', 'description', 'detail', 'remark'];
const CHEQUE_KEYWORDS = ['chq', 'cheque', 'ref'];
const DEBIT_KEYWORDS = ['debit', 'withdraw'];
const CREDIT_KEYWORDS = ['credit', 'deposit'];

// Column headers can carry a stray space mid-word from upstream text
// extraction — the same class of artifact ledger.ts already strips from bank
// codes (e.g. "SBIN0002296" read as "S BIN0002296"). Confirmed on a real
// ICICI statement: its header came through as "Withdra wal (Dr)", which
// broke a substring match on "withdraw" and blanked every Debit value.
// Stripping ALL internal whitespace (not just trim()) before matching makes
// every keyword check below immune to this, not just this one bank's case.
function normalizeKey(k: string): string {
  return k.toLowerCase().replace(/\s+/g, '');
}

function findKey(keys: string[], predicate: (normalized: string) => boolean): string | undefined {
  return keys.find(k => predicate(normalizeKey(k)));
}

/**
 * Maps one of the script's dynamically-headered JSON records onto this app's
 * fixed BANK_STATEMENT columns. Returns null for a row with nothing usable
 * (no date, no narration, no amount in either direction) rather than passing
 * junk downstream.
 */
function normalizePythonRow(record: Record<string, unknown>): Record<string, string> | null {
  const keys = Object.keys(record);
  if (keys.length === 0) return null;

  // Prefer a plain "date" column over a "value date" column when both exist
  // (mirrors the script's own date_col preference) — but fall back to
  // whatever date-ish column is available rather than leaving DATE blank.
  const dateKey =
    findKey(keys, l => l.includes('date') && !l.includes('value')) ??
    findKey(keys, l => l.includes('date'));

  // "transaction" is a weaker signal than the primary keywords above — some
  // statements name their narration column literally "Transaction" (e.g.
  // RBL), but "transaction" is also a substring of things like "Transaction
  // Date"/"Transaction Id" that must NOT be read as narration. Only fall
  // back to it, and only for a key that isn't itself a date/id column.
  const narrationKey =
    findKey(keys, l => NARRATION_KEYWORDS.some(w => l.includes(w))) ??
    findKey(keys, l => l.includes('transaction') && !l.includes('date') && !l.includes('id'));
  const chequeKey = findKey(keys, l => CHEQUE_KEYWORDS.some(w => l.includes(w)));

  // Exact "Debit"/"Credit" keys (the script produces these directly once it
  // splits an inline Cr/Dr marker or a separate Cr/Dr column) take priority
  // over keyword-guessing a native Withdrawal/Deposit-style column pair.
  //
  // The "balance" exclusion guards against matching the running-balance
  // column, but it has to be a *preference*, not an outright ban: some
  // statements produce a compound header like "Deposits Balance" for the
  // actual deposit-amount column (a header-merge quirk upstream in the
  // script), which contains both "deposit" and "balance" — a hard ban would
  // silently drop every credit-side amount for that statement (confirmed:
  // this exact case blanked every Credit value in a real Canara-format
  // statement). A bare "Balance"/"Closing Balance" column never contains a
  // credit/debit keyword itself, so it's still never eligible under the
  // fallback tier — only a column that names its amount AND happens to also
  // say "balance" can match there.
  const debitKey =
    keys.find(k => normalizeKey(k) === 'debit') ??
    findKey(keys, l => DEBIT_KEYWORDS.some(w => l.includes(w)) && !l.includes('balance')) ??
    findKey(keys, l => DEBIT_KEYWORDS.some(w => l.includes(w)));
  const creditKey =
    keys.find(k => normalizeKey(k) === 'credit') ??
    findKey(keys, l => CREDIT_KEYWORDS.some(w => l.includes(w)) && !l.includes('balance')) ??
    findKey(keys, l => CREDIT_KEYWORDS.some(w => l.includes(w)));

  // The running-balance column, e.g. "Balance", "Balance( )", "BALANCE(INR)",
  // "Balance Amount" — for testing/verification, so each row can be eyeballed
  // against the source PDF's own running total. Must never reuse a column
  // already claimed as Debit/Credit (a compound name like "Deposits Balance"
  // is the deposit AMOUNT, not the running balance — copying it into both
  // would duplicate the transaction value into Balance, which is wrong).
  const claimedKeys = new Set([debitKey, creditKey].filter((k): k is string => Boolean(k)));
  const balanceKey =
    keys.find(k => !claimedKeys.has(k) && normalizeKey(k) === 'balance') ??
    keys.find(k => !claimedKeys.has(k) && normalizeKey(k).includes('balance'));

  const DATE = dateKey ? toStr(record[dateKey]).replace(/-/g, '/') : '';
  const DESCRIPTION = narrationKey ? toStr(record[narrationKey]) : '';
  const CHEQUE_NO = chequeKey ? toStr(record[chequeKey]) : '';
  const Debit = debitKey ? toAmountStr(record[debitKey]) : '';
  const Credit = creditKey ? toAmountStr(record[creditKey]) : '';
  const Balance = balanceKey ? toBalanceStr(record[balanceKey]) : '';

  if (!DATE && !DESCRIPTION && !Debit && !Credit) return null;

  // LEDGER is intentionally left blank — the caller (runOcr in mistral.ts)
  // re-derives it via suggestBankLedger() on DESCRIPTION, exactly the same
  // deterministic path used for Mistral-sourced rows, so ledger behavior is
  // identical regardless of which engine produced the row.
  return { DATE, DESCRIPTION, CHEQUE_NO, Debit, Credit, Balance, LEDGER: '' };
}

/**
 * Attempts to extract a bank statement's transactions using the local Python
 * parser instead of Mistral OCR. Returns null on ANY failure (script missing,
 * interpreter missing, a dependency not installed, timeout, malformed output,
 * zero transactions found, or nothing mappable to the app's columns) — every
 * one of those must silently fall through to the existing Mistral path, never
 * surface as an error to the caller.
 */
export async function tryPythonBankStatementParse(file: File): Promise<Record<string, string>[] | null> {
  const id = randomUUID();
  const inputPath = path.join(TEMP_DIR, `${id}.pdf`);
  const outputXlsxPath = path.join(TEMP_DIR, `${id}.xlsx`);
  const outputJsonPath = path.join(TEMP_DIR, `${id}.json`);

  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(inputPath, buffer);

    console.log('[pythonBankParser] Attempting local parse via parse_bank_statement.py before falling back to Mistral OCR...');
    const result = await runPythonProcess(inputPath, outputXlsxPath);

    if (!result.ok) {
      console.warn(`[pythonBankParser] Local parser did not succeed — falling back to Mistral OCR. ${result.output.trim() ? `output: ${result.output.trim()}` : ''}`);
      return null;
    }

    let raw: string;
    try {
      raw = await fs.readFile(outputJsonPath, 'utf8');
    } catch {
      console.warn('[pythonBankParser] Parser exited successfully but produced no JSON output — falling back to Mistral OCR.');
      return null;
    }

    let records: unknown;
    try {
      records = JSON.parse(raw);
    } catch {
      console.warn('[pythonBankParser] Parser output was not valid JSON — falling back to Mistral OCR.');
      return null;
    }

    if (!Array.isArray(records) || records.length === 0) {
      console.log('[pythonBankParser] Parser returned zero transactions — falling back to Mistral OCR.');
      return null;
    }

    const rows = (records as Record<string, unknown>[])
      .map(normalizePythonRow)
      .filter((r): r is Record<string, string> => r !== null);

    if (rows.length === 0) {
      console.warn('[pythonBankParser] Parser returned rows but none mapped to a usable transaction — falling back to Mistral OCR.');
      return null;
    }

    console.log(`[pythonBankParser] Local parser succeeded — ${rows.length} transaction(s) extracted, skipping Mistral OCR for this document.`);
    return rows;
  } catch (err) {
    console.warn('[pythonBankParser] Unexpected error running local parser — falling back to Mistral OCR:', err);
    return null;
  } finally {
    await Promise.allSettled([
      fs.unlink(inputPath),
      fs.unlink(outputXlsxPath),
      fs.unlink(outputJsonPath),
    ]);
  }
}
