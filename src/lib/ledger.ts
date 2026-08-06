// ─────────────────────────────────────────────────────────────────────────────
// Deterministic ledger-name derivation for bank statement transactions.
//
// The Mistral model's own LEDGER suggestion is inconsistent across calls —
// for the same "TYPE-REF-PARTY-BANK" narration shape it sometimes picks the
// counterparty's name and sometimes the bank name/IFSC code, because it's a
// free-form judgment call with no fixed rule. IMPS/NEFT/RTGS narrations from
// Indian banks follow a consistent enough delimited structure (either "/" or
// "-") that we can parse the counterparty name out reliably instead of
// asking the model to guess. UPI narrations are less rigidly structured, but
// consistently mark the debit/credit direction with a "DR"/"CR" segment, and
// the counterparty name reliably follows that marker — see extractUpiParty()
// below. Formats we can't parse confidently fall back to the model's own
// suggestion.
//
// Every party name this module confidently derives is also recorded in
// ledgerMemory (persisted to disk) — so a later transaction whose narration
// format we CAN'T parse can still resolve correctly if that same party name
// appears anywhere in its description. This is what makes ledger accuracy
// improve the more statements you process — see ledgerMemory.ts for why
// this is rules-based memory, not model fine-tuning.
// ─────────────────────────────────────────────────────────────────────────────
import { lookup as lookupLearnedLedger, remember as rememberLedger } from './ledgerMemory';

const TYPE_CODES = new Set([
  'mmt', 'imps', 'neft', 'rtgs', 'upi', 'ecs', 'ach', 'nach',
  'chq', 'clg', 'cash', 'atm', 'pos', 'ift',
]);

// Routing/remark words that show up inside narration segments but never
// constitute a party name on their own (e.g. "IB TRF TO ICI", "PAYMENT").
const CONNECTOR_WORDS = new Set([
  'ib', 'trf', 'tfr', 'to', 'from', 'by', 'ici', 'mmt', 'imps', 'neft', 'rtgs',
  'upi', 'ecs', 'ach', 'nach', 'cr', 'dr', 'dep', 'wdl', 'chq', 'clg', 'ref',
  'txn', 'payment', 'transfer', 'sent', 'received', 'via', 'through', 'a/c',
  'ac', 'account', 'online', 'mobile', 'netbanking', 'fund', 'funds', 'inft',
  'n', 'adj', 'remitter', 'beneficiary',
]);

// Common Indian bank name fragments. Matched as a substring against the
// whole segment (not per-word) so "Kotak Mahindra" is caught via "kotak"
// even though "mahindra" alone means nothing to us.
const BANK_NAME_PATTERN = new RegExp(
  '\\b(' + [
    'bank', 'kotak', 'hdfc', 'icici', 'axis', 'sbi', 'state\\s*bank',
    'indusind', 'idfc', 'rbl', 'federal', 'karur', 'dcb', 'bandhan',
    'canara', 'baroda', 'pnb', 'punjab\\s*national', 'idbi', 'uco',
    'boi', 'bom', 'citibank', 'citi', 'hsbc', 'standard\\s*chartered',
    'deutsche', 'dbs', 'paytm', 'airtel', 'au\\s*small', 'equitas',
    'ujjivan', 'karnataka', 'south\\s*indian', 'csb', 'dhanlaxmi', 'saraswat',
  ].join('|') + ')\\b',
  'i',
);

function isTypeCodeToken(token: string): boolean {
  return TYPE_CODES.has(token.trim().toLowerCase());
}

/** A long, mostly-numeric segment (UTR/reference number), not a name. */
function isReferenceNumber(token: string): boolean {
  const compact = token.replace(/\s+/g, '');
  if (compact.length < 6) return false;
  const digitCount = (compact.match(/\d/g) || []).length;
  return digitCount / compact.length >= 0.7;
}

/**
 * IFSC routing codes (e.g. "KKBK0000958", "HDFC0001234"): 4 letters + "0" +
 * 6 alphanumeric. These fail the digit-ratio reference-number check (too
 * many letters) but are just as clearly not a party name.
 *
 * OCR sometimes inserts a stray space inside the code (e.g. "SBIN0002296"
 * read as "S BIN0002296", "HDFC0000271" as "HD FC0000271") — strip all
 * internal whitespace before testing so that doesn't slip past this check
 * and get mistaken for a party name.
 */
function isIfscCode(token: string): boolean {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/i.test(token.replace(/\s+/g, ''));
}

function isBankNameToken(token: string): boolean {
  return BANK_NAME_PATTERN.test(token) || isIfscCode(token);
}

// Exactly 4 uppercase letters: the bare IFSC "bank code" prefix UPI
// narrations often use standalone (e.g. "SBIN", "YESB") instead of a full
// IFSC code. Listed explicitly rather than treating "any 4 uppercase
// letters" as a bank code, since that would also catch a short all-caps
// party/company name (e.g. "TATA") — an ambiguity that can't be resolved
// from the string alone, so this only covers commonly-seen codes.
const UPI_BANK_CODES = new Set([
  'SBIN', 'HDFC', 'ICIC', 'UTIB', 'YESB', 'KKBK', 'PUNB', 'BARB', 'IDFB',
  'INDB', 'RATN', 'FDRL', 'KARB', 'SIBL', 'CSBK', 'DCBL', 'BDBL', 'CNRB',
  'UBIN', 'IBKL', 'UCBA', 'CBIN', 'IDIB', 'IOBA', 'MAHB', 'PSIB', 'PYTM',
  'AIRP', 'FINO', 'JIOP', 'AUBL', 'ESFB', 'UJVN',
]);

function isUpiBankCode(token: string): boolean {
  // Same OCR-inserted-space issue as isIfscCode above.
  return UPI_BANK_CODES.has(token.replace(/\s+/g, '').toUpperCase());
}

/**
 * Remark/reference text that occasionally survives the other filters but is
 * clearly not a party name: pure numbers (any length — narrower than
 * isReferenceNumber's 6+ char, mostly-digit requirement), invoice-note
 * phrases, GST-rate shorthand, and a couple of specific recurring remark
 * patterns seen in practice.
 */
function isRemarkPhrase(token: string): boolean {
  const t = token.trim();
  if (/^\d+$/.test(t)) return true;
  if (/^for\s+inv(oice)?\.?\s*(no\.?)?\s*\d*$/i.test(t)) return true;
  if (/^\d+\s*\+\s*gst$/i.test(t)) return true;
  if (/incorrect\s+account\s+number/i.test(t)) return true;
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+bill$/i.test(t)) return true;
  if (/^advertisement$/i.test(t)) return true;
  return false;
}

/** True only if EVERY word in the segment is routing/remark filler — e.g. "IB TRF TO ICI". */
function isConnectorOnly(token: string): boolean {
  const words = token.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  return words.every(w => CONNECTOR_WORDS.has(w));
}

/**
 * Given the delimiter-split segments of a narration, return the segment
 * most likely to be the counterparty's name, or null if nothing qualifies.
 */
function pickPartyToken(rawTokens: string[]): string | null {
  const candidates = rawTokens
    .map(t => t.trim())
    .filter(Boolean)
    .filter(t => !isTypeCodeToken(t))
    .filter(t => !isReferenceNumber(t))
    .filter(t => !isBankNameToken(t))
    .filter(t => !isConnectorOnly(t))
    .filter(t => !isRemarkPhrase(t));

  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

/**
 * UPI narrations aren't as rigidly structured as IMPS/NEFT/RTGS, but they
 * consistently mark the debit/credit direction with a standalone "DR" or
 * "CR" segment, e.g.:
 *   "UPI/509364605941/DR//YESB/paytmqr5c/Paid v"
 *   "UPI/509385577182/CR/TRIPUR/SBIN/tripurari/UPI"
 * The counterparty's name — sometimes truncated to a fixed field width by
 * the bank's system (e.g. "TRIPUR" for "tripurari", which then shows up in
 * full in a later remark segment) — is the segment immediately following
 * that marker, before the counterparty's bank code / VPA fragment / remark
 * that typically follow it. We scan forward from the marker and return the
 * first segment that isn't an empty "//" artifact, a reference number, a
 * bank name/IFSC/bank-code, or routing filler, rather than blindly taking
 * the very next segment (which is sometimes empty or a bank code).
 */
function extractUpiParty(desc: string): string | null {
  if (!/^UPI\b/i.test(desc) || !desc.includes('/')) return null;

  const tokens = desc.split('/').map(t => t.trim());
  const markerIndex = tokens.findIndex(t => /^(DR|CR)$/i.test(t));
  if (markerIndex === -1) return null;

  for (let i = markerIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (isTypeCodeToken(token)) continue;
    if (isReferenceNumber(token)) continue;
    if (isBankNameToken(token)) continue;
    if (isUpiBankCode(token)) continue;
    if (isConnectorOnly(token)) continue;
    if (isRemarkPhrase(token)) continue;
    return token;
  }

  return null;
}

function toTitleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Derive a Tally ledger name from a bank statement transaction description.
 * Falls back to the model's own suggestion (or "Suspense A/c") when the
 * narration doesn't match a pattern we can parse confidently.
 */
export function suggestBankLedger(description: string, modelSuggestion?: string): string {
  const desc = (description || '').trim();
  const fallback = (modelSuggestion || '').trim() || 'Suspense A/c';
  if (!desc) return fallback;

  if (/\bcash\s*dep(osit)?\b/i.test(desc)) return 'Cash';
  if (/\b(atm|cash)\b.*\bw(ith)?dr(awal)?\b|\bwdl\b/i.test(desc)) return 'Cash';
  if (/\bint\.?\s*pd\b|\binterest\s*(paid|credited?)\b/i.test(desc)) return 'Bank Interest';
  if (/\b(sms\s*charges|a\/c\s*maint|amc\s*charges|bank\s*charges|service\s*charge|gst\s*on\s*(bank|charges))\b/i.test(desc)) {
    return 'Bank Charges';
  }
  if (/\bself\b|own\s*a\/?c\s*transfer/i.test(desc)) return 'Self';

  // Fast path: has this same counterparty resolved before (in this or any
  // earlier statement)? If so, use that instead of re-deriving it — faster,
  // and extends correct results to narration formats the parsers below
  // can't handle on their own, as long as the party name text is present.
  const learned = lookupLearnedLedger(desc);
  if (learned) return learned;

  // IMPS/NEFT/RTGS narrations delimited by either "/" (e.g.
  // "MMT/IMPS/509219769017/IB TRF TO ICI/STUDYCAFE/Kotak Mahindra") or "-"
  // (e.g. "NEFT-KKBKN62025040417852826-STUDYCAFE PRIVATE LIMITED-PAYMENT-
  // 2813996082-KKBK0000958", common in Kotak Mahindra statements). The
  // segment order/count varies slightly by bank, so we filter out
  // everything that clearly ISN'T a party name (type codes, reference
  // numbers, bank names/IFSC codes, routing remarks) and take what's left,
  // rather than assuming a fixed position.
  if (/^(MMT|IMPS|NEFT|RTGS)\b/i.test(desc)) {
    const delimiter = desc.includes('/') ? '/' : desc.includes('-') ? '-' : null;
    if (delimiter) {
      const party = pickPartyToken(desc.split(delimiter));
      if (party) {
        const ledgerName = toTitleCase(party);
        rememberLedger(party, ledgerName);
        return ledgerName;
      }
    }
  }

  const upiParty = extractUpiParty(desc);
  if (upiParty) {
    const ledgerName = toTitleCase(upiParty);
    rememberLedger(upiParty, ledgerName);
    return ledgerName;
  }

  return fallback;
}
