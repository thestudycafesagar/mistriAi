// ─────────────────────────────────────────────────────────────────────────────
// Shared bank-statement date normalization — used by BOTH extraction engines
// (src/lib/pythonBankParser.ts and src/lib/mistral.ts) so the `DATE` field in
// the final JSON always has the same shape (DD/MM/YYYY, per API-DOCS.md's
// published contract) no matter which engine produced a given row, and no
// matter what format the source PDF itself printed.
//
// Why this exists: parse_bank_statement.py's local parser passes through
// whatever text the source statement literally used — "01/04/2024" (already
// correct), but also "10-OCT-2019" (month abbreviation, day-first) or
// "14−02−2023" (a Unicode minus-sign separator, confirmed on a real Cosmos
// Co-operative Bank statement) — and previously only did a naive `-` → `/`
// character swap, which fixes the separator but does NOT convert a month
// NAME into a month NUMBER. Mistral is prompt-instructed (schemas.ts RULE 6)
// to always output DD/MM/YYYY, but a prompt is not a guarantee — models can
// still deviate. Without a deterministic normalization step, an external
// caller integrating against this app's documented DD/MM/YYYY contract would
// see a different date shape depending on which internal engine happened to
// process a given statement, breaking any date parsing on their end.
// ─────────────────────────────────────────────────────────────────────────────

const MONTH_ABBR: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// Same separator set as parse_bank_statement.py's DATE_SEP: ASCII "/" and
// "-", plus the Unicode hyphen/dash lookalikes (U+2010–U+2015) and the
// Unicode MINUS SIGN (U+2212) some statement generators render dates with.
const SEP = '[\\/\\-‐-―−]';
const DATE_RE = new RegExp(`^(\\d{1,2})${SEP}(\\d{1,2}|[A-Za-z]{3,9})${SEP}(\\d{2,4})$`);

/**
 * Normalizes any bank-statement date either extraction engine can produce —
 * numeric (DD-MM-YYYY), month-abbreviation (DD-MMM-YYYY, e.g. "10-OCT-2019"),
 * any of the separator characters above, 2- or 4-digit years — into a single
 * canonical `DD/MM/YYYY` string. Day-first is assumed throughout (matches
 * every real statement layout seen by this app, and the Mistral prompt's own
 * RULE 6) — this does not attempt to detect US-style MM-DD-YYYY input, since
 * no source statement processed by this app has ever used it.
 *
 * Returns the input unchanged (trimmed) if it doesn't match a recognizable
 * date shape, or if the matched numbers don't form a plausible date (day
 * 1-31, month 1-12) — never throws, never silently drops a value the caller
 * could otherwise still have used even if this can't normalize its exact
 * format.
 */
export function normalizeBankStatementDate(raw: string | undefined | null): string {
  if (!raw) return raw ?? '';
  const s = raw.trim();
  if (!s) return s;

  const m = DATE_RE.exec(s);
  if (!m) return s;

  const day = m[1].padStart(2, '0');

  let month: string;
  if (/^\d+$/.test(m[2])) {
    month = m[2].padStart(2, '0');
  } else {
    const key = m[2].slice(0, 3).toLowerCase();
    const mapped = MONTH_ABBR[key];
    if (!mapped) return s; // unrecognized month name — leave as-is rather than guess
    month = mapped;
  }

  let year = m[3];
  if (year.length === 2) {
    const yy = parseInt(year, 10);
    // Same windowing convention Excel/most spreadsheet tools use for 2-digit
    // years: 00-68 -> 2000-2068, 69-99 -> 1969-1999. None of this app's real
    // source statements have used 2-digit years so far — this is a
    // defensive fallback, not a confirmed real-world case.
    year = (yy <= 68 ? 2000 + yy : 1900 + yy).toString();
  }

  const dayNum = parseInt(day, 10);
  const monthNum = parseInt(month, 10);
  if (dayNum < 1 || dayNum > 31 || monthNum < 1 || monthNum > 12) return s;

  return `${day}/${month}/${year}`;
}
