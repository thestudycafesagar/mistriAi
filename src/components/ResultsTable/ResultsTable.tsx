'use client';

import { useState, useMemo } from 'react';
import type { DocumentType, BankStatementSummary } from '../UploadForm/UploadForm';
import styles from './ResultsTable.module.css';

// Columns that should be right-aligned (number-like)
const NUMBER_COLS = new Set([
  'Debit', 'Credit', 'Balance', 'Quantity', 'Rate', 'TaxableValue',
  'CGSTRate', 'CGSTAmount', 'SGSTRate', 'SGSTAmount',
  'IGSTRate', 'IGSTAmount',
]);

// Columns to apply Debit/Credit colour coding
const DEBIT_COL  = 'Debit';
const CREDIT_COL = 'Credit';

const DOC_LABELS: Record<DocumentType, string> = {
  BANK_STATEMENT:    'Bank Statement',
  SALES_INVOICE:     'Sales Invoice',
  PURCHASE_INVOICE:  'Purchase Invoice',
};

interface ResultsTableProps {
  columns: string[];
  rows: Record<string, string>[];
  docType: DocumentType;
  rowCount: number;
  elapsedTime?: number;
  bankSummary?: BankStatementSummary;
}

function formatINR(value: string | undefined): string {
  const num = parseFloat(value ?? '');
  if (Number.isNaN(num)) return '—';
  return `₹${num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

type SortDir = 'asc' | 'desc';

function escapeCsv(val: string): string {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function downloadCsv(columns: string[], rows: Record<string, string>[], docType: DocumentType) {
  const header = columns.join(',');
  const body = rows.map((row) => columns.map((c) => escapeCsv(row[c] ?? '')).join(',')).join('\n');
  const csv = `${header}\n${body}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${docType.toLowerCase()}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function copyJson(rows: Record<string, string>[]) {
  navigator.clipboard.writeText(JSON.stringify(rows, null, 2)).catch(() => {});
}

export default function ResultsTable({ columns, rows, docType, rowCount, elapsedTime, bankSummary }: ResultsTableProps) {
  const [activeTab, setActiveTab] = useState<'table' | 'json'>('table');
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [copied, setCopied] = useState(false);

  // If the rows are in the new nested Tally JSON format (for invoices), flatten them just for the table view
  const displayRows = useMemo(() => {
    if (!rows || rows.length === 0) return rows;
    if ('mappedRow' in rows[0]) {
      return rows.flatMap((tally: any) => {
        const mapped = tally.mappedRow;
        if (!mapped || !mapped.items) return [];
        return mapped.items.map((item: any) => ({
          Date: mapped.SupplierInvoiceDate,
          VoucherNo: mapped.SupplierInvoiceNo,
          PartyLedger: mapped.PartyLedger,
          PartyGSTIN: mapped.PartyGSTIN,
          Item_Name: item.ItemName,
          HSNCode: item.HSNCode,
          Quantity: item.Quantity?.toString() ?? '',
          Unit: item.Per,
          Rate: item.Rate?.toString() ?? '',
          TaxableValue: item.ExtractedAmount?.toString() ?? '',
          IGSTAmount: mapped['IGST Amount']?.toString() ?? '',
          CGSTAmount: mapped['CGST Amount']?.toString() ?? '',
          SGSTAmount: mapped['SGST Amount']?.toString() ?? '',
        }));
      });
    }
    return rows;
  }, [rows]);

  // Filter
  const filtered = useMemo(() => {
    if (!search.trim()) return displayRows;
    const q = search.trim().toLowerCase();
    return displayRows.filter((row) =>
      columns.some((c) => (row[c] ?? '').toString().toLowerCase().includes(q)),
    );
  }, [displayRows, columns, search]);

  // Sort
  const sorted = useMemo(() => {
    if (!sortCol) return filtered;
    return [...filtered].sort((a, b) => {
      const va = a[sortCol] ?? '';
      const vb = b[sortCol] ?? '';
      // Numeric sort if both look like numbers
      const na = parseFloat(va.replace(/,/g, ''));
      const nb = parseFloat(vb.replace(/,/g, ''));
      const cmp = !isNaN(na) && !isNaN(nb) ? na - nb : va.localeCompare(vb);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sortCol, sortDir]);

  const handleSort = (col: string) => {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  };

  const handleCopy = () => {
    copyJson(rows);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const sortArrow = (col: string) => {
    if (sortCol !== col) return '↕';
    return sortDir === 'asc' ? '↑' : '↓';
  };

  return (
    <div className={styles.wrapper} id="results-section">
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.tabs} role="tablist">
            <button
              role="tab"
              aria-selected={activeTab === 'table'}
              className={`${styles.tabBtn} ${activeTab === 'table' ? styles.active : ''}`}
              onClick={() => setActiveTab('table')}
            >
              Table View
            </button>
            <button
              role="tab"
              aria-selected={activeTab === 'json'}
              className={`${styles.tabBtn} ${activeTab === 'json' ? styles.active : ''}`}
              onClick={() => setActiveTab('json')}
            >
              JSON View
            </button>
          </div>
          <span className={styles.rowBadge}>{rowCount} rows</span>
          {typeof elapsedTime === 'number' && (
            <span className={styles.rowBadge} title="Total time taken to parse this document">
              ⏱ {elapsedTime}s
            </span>
          )}
          {docType === 'BANK_STATEMENT' && bankSummary && (
            <>
              <span className={`${styles.rowBadge} ${styles.headerDebit}`} title="Total of all extracted Debit amounts">
                Dr {formatINR(bankSummary.totalDebit)}
              </span>
              <span className={`${styles.rowBadge} ${styles.headerCredit}`} title="Total of all extracted Credit amounts">
                Cr {formatINR(bankSummary.totalCredit)}
              </span>
            </>
          )}
        </div>
        <div className={styles.actions}>
          {activeTab === 'json' ? (
            <button
              id="copy-json-btn"
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={handleCopy}
              title="Copy JSON"
            >
              {copied ? '✅ Copied' : '📋 Copy JSON'}
            </button>
          ) : (
            <button
              id="export-csv-btn"
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={() => downloadCsv(columns, displayRows, docType)}
              title="Download CSV"
            >
              ⬇ Export CSV
            </button>
          )}
        </div>
      </div>

      {/* Bank statement totals + reconciliation against the statement's own printed balances */}
      {docType === 'BANK_STATEMENT' && bankSummary && (
        <div className={styles.summaryBar}>
          <div className={styles.summaryStat}>
            <span className={styles.summaryLabel}>Total Debit</span>
            <span className={`${styles.summaryValue} ${styles.summaryDebit}`}>{formatINR(bankSummary.totalDebit)}</span>
          </div>
          <div className={styles.summaryStat}>
            <span className={styles.summaryLabel}>Total Credit</span>
            <span className={`${styles.summaryValue} ${styles.summaryCredit}`}>{formatINR(bankSummary.totalCredit)}</span>
          </div>

          {bankSummary.reconciled === true && (
            <div
              className={`${styles.reconcileBadge} ${styles.reconcileOk}`}
              title={`Opening balance ${formatINR(bankSummary.openingBalance)} + net movement from extracted transactions = closing balance ${formatINR(bankSummary.closingBalance)}, as printed on the statement.`}
            >
              ✓ Matches statement balance
            </div>
          )}
          {bankSummary.reconciled === false && (
            <div
              className={`${styles.reconcileBadge} ${styles.reconcileMismatch}`}
              title={`Statement's opening (${formatINR(bankSummary.openingBalance)}) and closing (${formatINR(bankSummary.closingBalance)}) balances imply a net change of ${formatINR(bankSummary.expectedNetChange)}, but the extracted transactions sum to a net change of ${formatINR(bankSummary.actualNetChange)}. Please review — some rows may still be missing or misread.`}
            >
              ⚠ Mismatch vs. statement balance ({formatINR(bankSummary.discrepancy)} difference)
            </div>
          )}
          {bankSummary.reconciled === null && (
            <span
              className={styles.reconcileUnknown}
              title="The statement's opening/closing balance wasn't visible on the scanned pages, so the totals above couldn't be cross-checked against it."
            >
              ℹ Not verified against statement balance
            </span>
          )}
        </div>
      )}

      {activeTab === 'json' ? (
        <pre className={styles.jsonView}>
          {JSON.stringify(rows, null, 2)}
        </pre>
      ) : (
        <>
          {/* Search */}
          <div className={styles.filterRow}>
            <div className={styles.searchWrap}>
              <span className={styles.searchIcon}>🔍</span>
              <input
                id="table-search"
                type="search"
                className={styles.searchInput}
                placeholder="Search extracted data…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search results"
              />
            </div>
            {search && (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {filtered.length} / {displayRows.length} rows
              </span>
            )}
          </div>

          {/* Table */}
          <div className={styles.tableContainer} role="region" aria-label="Extraction results table">
            {sorted.length === 0 ? (
              <div className={styles.empty}>
                <span className={styles.emptyIcon}>{search ? '🔍' : '📭'}</span>
                <span className={styles.emptyText}>
                  {search
                    ? 'No rows match your search.'
                    : 'No data was extracted. The document may not contain recognisable transactions.'}
                </span>
              </div>
            ) : (
              <table className={styles.table} aria-label="Extracted transactions">
                <thead>
                  <tr>
                    <th className={styles.rowNum} aria-label="Row number">#</th>
                    {columns.map((col) => (
                      <th
                        key={col}
                        onClick={() => handleSort(col)}
                        className={sortCol === col ? styles.sorted : ''}
                        aria-sort={
                          sortCol === col
                            ? sortDir === 'asc' ? 'ascending' : 'descending'
                            : 'none'
                        }
                        title={`Sort by ${col}`}
                      >
                        {col}
                        <i className={styles.sortIcon}>{sortArrow(col)}</i>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((row, idx) => (
                    <tr key={idx}>
                      <td className={`${styles.rowNum} ${styles.numCell}`}>{idx + 1}</td>
                      {columns.map((col) => {
                        const val = row[col] ?? '';
                        const isDebit  = col === DEBIT_COL  && val !== '';
                        const isCredit = col === CREDIT_COL && val !== '';
                        const isNum    = NUMBER_COLS.has(col);
                        return (
                          <td
                            key={col}
                            className={[
                              isDebit  ? styles.debit  : '',
                              isCredit ? styles.credit : '',
                              isNum    ? styles.numCell : '',
                            ].filter(Boolean).join(' ')}
                            title={val}
                          >
                            {val || <span style={{ opacity: 0.3 }}>—</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* Footer */}
      <div className={styles.footer}>
        <span>
          Showing {activeTab === 'table' ? sorted.length : rows.length} of {activeTab === 'table' ? displayRows.length : rows.length} rows
          {activeTab === 'table' && sortCol ? ` · Sorted by ${sortCol} (${sortDir})` : ''}
        </span>
        <span>Extracted in {elapsedTime}s via Mistri OCR</span>
      </div>
    </div>
  );
}
