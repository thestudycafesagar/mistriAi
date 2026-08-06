// ─────────────────────────────────────────────────────────────────────────────
// Persistent "learned" party → ledger name memory for bank statements.
//
// This is NOT model training — Mistral's OCR API is stateless and can't be
// fine-tuned through this integration (see AGENTS.md). What this actually is:
// a small on-disk knowledge base that grows every time suggestBankLedger()
// (src/lib/ledger.ts) confidently derives a party name via its deterministic
// narration parser. The same counterparty (e.g. "STUDYCAFE") recurs across
// many transactions and many statements; once we've resolved a name once, we
// remember it — so a later transaction whose narration format the parser
// CAN'T confidently handle can still resolve correctly if that same party
// name appears anywhere in its description. This is what actually delivers
// "gets more accurate the more documents you process": rules-based memory
// that accumulates with usage, not a retrained model.
//
// Persistence: a JSON file on disk (data/ledger-memory.json). This only
// helps in a persistent server process — on serverless platforms where each
// invocation may be a fresh instance, this degrades to in-memory-only for
// that invocation's lifetime (still correct, just doesn't accumulate across
// invocations). Confirmed this deployment is a persistent server process.
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');
const MEMORY_FILE = join(DATA_DIR, 'ledger-memory.json');

// Ignore anything shorter than this — short/generic tokens (e.g. a stray
// 2-3 letter fragment) risk false-positive substring matches against
// unrelated future narrations.
const MIN_KEY_LENGTH = 4;

type MemoryMap = Map<string, string>;

function normalizeKey(partyName: string): string {
  return partyName.trim().toLowerCase().replace(/\s+/g, ' ');
}

function loadMemory(): MemoryMap {
  try {
    if (!existsSync(MEMORY_FILE)) return new Map();
    const raw = readFileSync(MEMORY_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(parsed));
  } catch (err) {
    // Corrupt or unreadable file — start fresh rather than crash extraction
    // over what's purely a nice-to-have cache.
    console.warn('[LedgerMemory] Failed to load persisted memory, starting empty:', err);
    return new Map();
  }
}

function persistMemory(memory: MemoryMap): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const obj = Object.fromEntries(memory);
    writeFileSync(MEMORY_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (err) {
    // Read-only filesystem, disk full, etc. — degrade to in-memory-only for
    // this process rather than fail the extraction that triggered this.
    console.warn('[LedgerMemory] Failed to persist memory to disk (continuing in-memory only):', err);
  }
}

// Module-level singleton, loaded once per server process.
const memory: MemoryMap = loadMemory();

/**
 * Record a confidently-derived party → ledger mapping so future
 * transactions mentioning the same party resolve instantly and
 * consistently, even from narration formats the parser can't handle.
 */
export function remember(partyName: string, ledgerName: string): void {
  const key = normalizeKey(partyName);
  if (key.length < MIN_KEY_LENGTH) return;
  if (memory.get(key) === ledgerName) return; // no change, skip the disk write

  memory.set(key, ledgerName);
  persistMemory(memory);
}

/**
 * Look for any previously-learned party name that appears within this
 * transaction's description. Returns the remembered ledger name, or null
 * if nothing learned so far matches.
 */
export function lookup(description: string): string | null {
  const desc = normalizeKey(description);
  if (!desc) return null;

  for (const [key, ledgerName] of memory) {
    if (desc.includes(key)) return ledgerName;
  }

  return null;
}

/** For diagnostics/logging — how many party names have been learned so far. */
export function getLearnedCount(): number {
  return memory.size;
}
