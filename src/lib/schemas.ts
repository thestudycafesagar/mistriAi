// ─────────────────────────────────────────────────────────────────────────────
// JSON schemas passed to Mistral's document_annotation_format.
// Each schema wraps the rows in a root { transactions: [...] } object so the
// annotation format can target a named property.
// ─────────────────────────────────────────────────────────────────────────────

export type DocumentType = 'BANK_STATEMENT' | 'SALES_INVOICE' | 'PURCHASE_INVOICE';

// ── Bank Statement ────────────────────────────────────────────────────────────
const bankStatementSchema = {
  type: 'object',
  properties: {
    // Best-effort, whole-statement figures — NOT per-transaction data. Most
    // chunks won't have these visible at all (empty string); only the chunk
    // containing the statement's actual first/last page should. Used to
    // cross-check the sum of extracted transactions against the statement's
    // own printed balances (see reconcileBankStatement() in mistral.ts) —
    // never used to fabricate or adjust any transaction row itself.
    openingBalance: {
      type: 'string',
      pattern: '^$|^\\d+(\\.\\d{1,2})?$',
      description:
        'STATEMENT-LEVEL opening balance ONLY — the balance at the very start of the ENTIRE statement period. ' +
        'This typically appears ONLY on the very first page labelled something like "Statement Opening Balance", ' +
        '"Account Opening Balance", or "Opening Balance as on [date]". ' +
        'DO NOT use values from a "Page Total" block (e.g. "Opening Bal: X" inside a Page Total section) — ' +
        'those are page-level summaries, not the statement opening balance. ' +
        'Leave as empty string "" for all pages except the actual first page that shows the statement-level opening figure.',
    },
    closingBalance: {
      type: 'string',
      pattern: '^$|^\\d+(\\.\\d{1,2})?$',
      description:
        'STATEMENT-LEVEL closing balance ONLY — the final balance at the end of the ENTIRE statement period. ' +
        'This typically appears ONLY on the very last page labelled something like "Closing Balance as on [date]", ' +
        '"Account Closing Balance", or "Final Balance". ' +
        'DO NOT use values from a "Page Total" block (e.g. "Closing Bal: X" inside a Page Total section) — ' +
        'those are page-level summaries, not the statement closing balance. ' +
        'Leave as empty string "" for all pages except the actual last page that shows the statement-level closing figure.',
    },
    transactions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          DATE: {
            type: 'string',
            description: 'Transaction date in DD/MM/YYYY format',
          },
          DESCRIPTION: {
            type: 'string',
            description: 'Full narration / description of the transaction',
          },
          CHEQUE_NO: {
            type: 'string',
            description: 'Cheque number if present, otherwise empty string',
          },
          Debit: {
            type: 'string',
            pattern: '^$|^\\d+(\\.\\d{1,2})?$',
            description:
              'Debit amount as a plain decimal number. Remove thousands-separator commas but ALWAYS keep the decimal point exactly as printed — e.g. "25.05" must stay "25.05", never become "2505" or "25.5". Empty string if not a debit.',
          },
          Credit: {
            type: 'string',
            pattern: '^$|^\\d+(\\.\\d{1,2})?$',
            description:
              'Credit amount as a plain decimal number. Remove thousands-separator commas but ALWAYS keep the decimal point exactly as printed — e.g. "25.05" must stay "25.05", never become "2505" or "25.5". Empty string if not a credit.',
          },
          Balance: {
            type: 'string',
            pattern: '^$|^-?\\d+(\\.\\d{1,2})?$',
            description:
              'The running account Balance shown on THIS transaction row — the SAME Balance column RULE 3 says must never be copied into Debit or Credit. Capture its value here instead: strip ₹/commas, keep the decimal point exactly as printed, optional leading "-" for an overdrawn/negative balance. Empty string if no balance is visible for this row.',
          },
          LEDGER: {
            type: 'string',
            description: 'Suggested Tally ledger name e.g. "HDFC Bank", "Cash", "Suspense A/c"',
          },
        },
        required: ['DATE', 'DESCRIPTION', 'CHEQUE_NO', 'Debit', 'Credit', 'Balance', 'LEDGER'],
        additionalProperties: false,
      },
    },
  },
  required: ['openingBalance', 'closingBalance', 'transactions'],
};

const bankStatementPrompt =
  'You are extracting every real monetary transaction from this bank statement page. ' +
  'Be exhaustive — extract every dated transaction row, do not skip any. ' +

  'RULE 1 — REAL TRANSACTIONS: A real transaction has a date, a narration, and a non-zero amount in ' +
  'exactly ONE of the Debit or Credit columns (never both). Extract every such row. ' +
  'Do NOT stop early — the last real transaction on a page often appears just above a "Page Total" block. ' +

  'RULE 2 — EXCLUDE THESE (never put them in transactions array): ' +
  '"Balance B/F" / "Brought Forward" / "Opening Balance" rows at the top of transaction table (not real transactions). ' +
  '"Balance C/F" / "Carried Forward" rows (not real transactions). ' +
  '"Page Total" / "Sub Total" / "Total" rows (subtotals, not transactions). ' +
  'Column header rows, blank rows. ' +

  'RULE 3 — DEBIT vs CREDIT vs BALANCE — THIS IS CRITICAL: ' +
  'Bank statements typically have these columns: Date | Description | Cheque No | [Withdrawl/Withdrawal/Dr] | [Deposit/Cr] | [Balance]. ' +
  'The Debit field in your output = the value from the WITHDRAWL / WITHDRAWAL / DR / DEBIT column only. ' +
  'The Credit field in your output = the value from the DEPOSIT / CR / CREDIT column only. ' +
  'The BALANCE column shows the running account balance after each transaction — this is a COMPLETELY SEPARATE column from Debit/Credit. ' +
  'NEVER put a Balance column value into Debit or Credit — it goes into its own separate Balance output field instead. ' +
  'If you see three numeric columns (Withdrawl, Deposit, Balance) — all three map to output fields, never merged together: ' +
  'Withdrawl → Debit. Deposit → Credit. Balance → Balance (never Debit or Credit). ' +

  'RULE 4 — AMOUNTS: Strip ₹, Rs., INR symbols and thousands-separator commas. ' +
  'Keep decimal point exactly as printed: "1,50,32,233.10" → "15032233.10". ' +
  '"25.05" stays "25.05" — never "2505". Blank cell → empty string "". ' +

  'RULE 5 — OPENING / CLOSING BALANCE: ' +
  'Many bank statements print a "Page Total" block at the bottom of every page showing: ' +
  '"Opening Bal", "Withdrawls", "Deposits", "Closing Bal". ' +
  'Use the "Opening Bal" value from this Page Total block for the openingBalance field. ' +
  'Use the "Closing Bal" value from this Page Total block for the closingBalance field. ' +
  'If this page has NO Page Total block and no separate statement-level balance label, leave both as "". ' +
  'Strip commas but preserve the decimal: "21,334.39" → "21334.39". ' +

  'RULE 6 — DATE: DD/MM/YYYY format. ' +

  'RULE 7 — LEDGER: Suggest a Tally ledger name for the counterparty.';

// ── Sales Invoice ─────────────────────────────────────────────────────────────
const salesInvoiceItems = {
  type: 'object',
  properties: {
    Date:          { type: 'string', description: 'Invoice date DD/MM/YYYY' },
    VoucherNo:     { type: 'string', description: 'Invoice / voucher number' },
    PartyLedger:   { type: 'string', description: 'Customer / buyer name' },
    PartyGSTIN:    { type: 'string', description: '15-character buyer GSTIN from "Bill To" section' },
    Item_Name:     { type: 'string', description: 'Product or service name' },
    HSNCode:       { type: 'string', description: 'HSN / SAC code' },
    Quantity:      { type: 'string', pattern: '^$|^\\d+(\\.\\d{1,2})?$', description: 'Quantity as a plain decimal number, decimal point preserved exactly as printed (e.g. "2.5" must stay "2.5", never "25")' },
    Unit:          { type: 'string', description: 'Unit of measurement e.g. NOS, KG, MTR' },
    Rate:          { type: 'string', pattern: '^$|^\\d+(\\.\\d{1,2})?$', description: 'Rate per unit as a plain decimal number, decimal point preserved exactly as printed (e.g. "25.05" must stay "25.05", never "2505")' },
    TaxableValue:  { type: 'string', pattern: '^$|^\\d+(\\.\\d{1,2})?$', description: 'Taxable value as a plain decimal number, decimal point preserved exactly as printed' },
    CGSTRate:      { type: 'string', description: 'CGST rate percentage e.g. 9' },
    CGSTAmount:    { type: 'string', pattern: '^$|^\\d+(\\.\\d{1,2})?$', description: 'CGST amount as a plain decimal number, decimal point preserved exactly as printed' },
    SGSTRate:      { type: 'string', description: 'SGST rate percentage e.g. 9' },
    SGSTAmount:    { type: 'string', pattern: '^$|^\\d+(\\.\\d{1,2})?$', description: 'SGST amount as a plain decimal number, decimal point preserved exactly as printed' },
    IGSTRate:      { type: 'string', description: 'IGST rate percentage, empty if not applicable' },
    IGSTAmount:    { type: 'string', pattern: '^$|^\\d+(\\.\\d{1,2})?$', description: 'IGST amount as a plain decimal number, decimal point preserved exactly as printed, empty if not applicable' },
  },
  required: [
    'Date', 'VoucherNo', 'PartyLedger', 'PartyGSTIN', 'Item_Name', 'HSNCode',
    'Quantity', 'Unit', 'Rate', 'TaxableValue', 'CGSTRate', 'CGSTAmount',
    'SGSTRate', 'SGSTAmount', 'IGSTRate', 'IGSTAmount',
  ],
  additionalProperties: false,
};

const salesInvoiceSchema = {
  type: 'object',
  properties: {
    transactions: { type: 'array', items: salesInvoiceItems },
    TotalCGSTAmount: { type: 'string', pattern: '^$|^\\d+(\\.\\d{1,2})?$', description: 'The total CGST amount printed at the bottom of the invoice, empty if not found' },
    TotalSGSTAmount: { type: 'string', pattern: '^$|^\\d+(\\.\\d{1,2})?$', description: 'The total SGST amount printed at the bottom of the invoice, empty if not found' },
    TotalIGSTAmount: { type: 'string', pattern: '^$|^\\d+(\\.\\d{1,2})?$', description: 'The total IGST amount printed at the bottom of the invoice, empty if not found' }
  },
  required: ['transactions'],
};

const salesInvoicePrompt =
  'Extract ALL line items from this GST sales invoice into the transactions array. ' +
  'Repeat invoice-level fields (Date, VoucherNo, PartyLedger, PartyGSTIN) in every row. ' +
  'PartyGSTIN is the BUYER\'s 15-character GSTIN from the "Bill To" section. ' +
  'Extract plain decimal numbers only: strip currency symbols and thousands-separator commas, but NEVER ' +
  'remove or shift the decimal point — an amount printed as 25.05 must be extracted as "25.05", never as ' +
  '"2505" or "25.5". ' +
  'If IGST is not applicable leave IGSTRate and IGSTAmount empty. ' +
  'CRITICAL RULE: DO NOT CALCULATE TAXES. Only extract exact amounts printed on the invoice. ' +
  'If tax amounts (CGST/SGST/IGST) are only shown as a grand total at the bottom of the invoice and NOT per-item, ' +
  'leave the item-level tax fields EMPTY for every row and put the totals in TotalCGSTAmount, TotalSGSTAmount, and TotalIGSTAmount at the root level.';

// ── Purchase Invoice ──────────────────────────────────────────────────────────
const purchaseInvoiceItems = {
  type: 'object',
  properties: {
    Date:           { type: 'string', description: 'Invoice date DD/MM/YYYY' },
    VoucherNo:      { type: 'string', description: 'Invoice / voucher number' },
    PartyLedger:    { type: 'string', description: 'Supplier / seller name' },
    PartyGSTIN:     { type: 'string', description: '15-character SUPPLIER/SELLER GSTIN from invoice header' },
    Item_Name:      { type: 'string', description: 'Product or service name' },
    HSNCode:        { type: 'string', description: 'HSN / SAC code' },
    Quantity:       { type: 'string', pattern: '^$|^\\d+(\\.\\d{1,2})?$', description: 'Quantity as a plain decimal number, decimal point preserved exactly as printed (e.g. "2.5" must stay "2.5", never "25")' },
    Unit:           { type: 'string', description: 'Unit of measurement e.g. NOS, KG, MTR' },
    Rate:           { type: 'string', pattern: '^$|^\\d+(\\.\\d{1,2})?$', description: 'Rate per unit as a plain decimal number, decimal point preserved exactly as printed (e.g. "25.05" must stay "25.05", never "2505")' },
    TaxableValue:   { type: 'string', pattern: '^$|^\\d+(\\.\\d{1,2})?$', description: 'Taxable value as a plain decimal number, decimal point preserved exactly as printed' },
    CGSTRate:       { type: 'string', description: 'CGST rate percentage e.g. 9' },
    CGSTAmount:     { type: 'string', pattern: '^$|^\\d+(\\.\\d{1,2})?$', description: 'CGST amount as a plain decimal number, decimal point preserved exactly as printed' },
    SGSTRate:       { type: 'string', description: 'SGST rate percentage e.g. 9' },
    SGSTAmount:     { type: 'string', pattern: '^$|^\\d+(\\.\\d{1,2})?$', description: 'SGST amount as a plain decimal number, decimal point preserved exactly as printed' },
    IGSTRate:       { type: 'string', description: 'IGST rate percentage, empty if not applicable' },
    IGSTAmount:     { type: 'string', pattern: '^$|^\\d+(\\.\\d{1,2})?$', description: 'IGST amount as a plain decimal number, decimal point preserved exactly as printed, empty if not applicable' },
  },
  required: [
    'Date', 'VoucherNo', 'PartyLedger', 'PartyGSTIN', 'Item_Name', 'HSNCode',
    'Quantity', 'Unit', 'Rate', 'TaxableValue', 'CGSTRate', 'CGSTAmount',
    'SGSTRate', 'SGSTAmount', 'IGSTRate', 'IGSTAmount',
  ],
  additionalProperties: false,
};

const purchaseInvoiceSchema = {
  type: 'object',
  properties: {
    transactions: { type: 'array', items: purchaseInvoiceItems },
    TotalCGSTAmount: { type: 'string', pattern: '^$|^\\d+(\\.\\d{1,2})?$', description: 'The total CGST amount printed at the bottom of the invoice, empty if not found' },
    TotalSGSTAmount: { type: 'string', pattern: '^$|^\\d+(\\.\\d{1,2})?$', description: 'The total SGST amount printed at the bottom of the invoice, empty if not found' },
    TotalIGSTAmount: { type: 'string', pattern: '^$|^\\d+(\\.\\d{1,2})?$', description: 'The total IGST amount printed at the bottom of the invoice, empty if not found' }
  },
  required: ['transactions'],
};

const purchaseInvoicePrompt =
  'Extract ALL line items from this GST purchase invoice into the transactions array. ' +
  'The PartyGSTIN MUST be the SUPPLIER/SELLER\'s 15-character GSTIN from the invoice header — NOT the buyer. ' +
  'Repeat invoice-level fields (Date, VoucherNo, PartyLedger, PartyGSTIN) in every row. ' +
  'Extract plain decimal numbers only: strip currency symbols and thousands-separator commas, but NEVER ' +
  'remove or shift the decimal point — an amount printed as 25.05 must be extracted as "25.05", never as ' +
  '"2505" or "25.5". ' +
  'If IGST is not applicable leave IGSTRate and IGSTAmount empty. ' +
  'CRITICAL RULE: DO NOT CALCULATE TAXES. Only extract exact amounts printed on the invoice. ' +
  'If tax amounts (CGST/SGST/IGST) are only shown as a grand total at the bottom of the invoice and NOT per-item, ' +
  'leave the item-level tax fields EMPTY for every row and put the totals in TotalCGSTAmount, TotalSGSTAmount, and TotalIGSTAmount at the root level.';

// ── Exports ───────────────────────────────────────────────────────────────────
export interface SchemaConfig {
  schema: object;
  prompt: string;
  columns: string[];
}

export const SCHEMAS: Record<DocumentType, SchemaConfig> = {
  BANK_STATEMENT: {
    schema: bankStatementSchema,
    prompt: bankStatementPrompt,
    columns: ['DATE', 'DESCRIPTION', 'CHEQUE_NO', 'Debit', 'Credit', 'Balance', 'LEDGER'],
  },
  SALES_INVOICE: {
    schema: salesInvoiceSchema,
    prompt: salesInvoicePrompt,
    columns: [
      'Date', 'VoucherNo', 'PartyLedger', 'PartyGSTIN', 'Item_Name', 'HSNCode',
      'Quantity', 'Unit', 'Rate', 'TaxableValue', 'CGSTRate', 'CGSTAmount',
      'SGSTRate', 'SGSTAmount', 'IGSTRate', 'IGSTAmount',
    ],
  },
  PURCHASE_INVOICE: {
    schema: purchaseInvoiceSchema,
    prompt: purchaseInvoicePrompt,
    columns: [
      'Date', 'VoucherNo', 'PartyLedger', 'PartyGSTIN', 'Item_Name', 'HSNCode',
      'Quantity', 'Unit', 'Rate', 'TaxableValue', 'CGSTRate', 'CGSTAmount',
      'SGSTRate', 'SGSTAmount', 'IGSTRate', 'IGSTAmount',
    ],
  },
};
