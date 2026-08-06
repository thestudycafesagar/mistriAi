'use client';

import { useState, useEffect, useRef } from 'react';
import UploadForm, { type DocumentType, type BankStatementSummary } from '@/components/UploadForm/UploadForm';
import ResultsTable from '@/components/ResultsTable/ResultsTable';
import StatusBadge from '@/components/StatusBadge/StatusBadge';
import type { Status } from '@/components/StatusBadge/StatusBadge';
import styles from './page.module.css';

const SCHEMA_FIELDS: Record<DocumentType, string[]> = {
  BANK_STATEMENT: ['DATE', 'DESCRIPTION', 'CHEQUE_NO', 'Debit', 'Credit', 'LEDGER'],
  SALES_INVOICE: [
    'Date', 'VoucherNo', 'PartyLedger', 'PartyGSTIN', 'Item_Name', 'HSNCode',
    'Quantity', 'Unit', 'Rate', 'TaxableValue', 'CGSTRate', 'CGSTAmount',
    'SGSTRate', 'SGSTAmount', 'IGSTRate', 'IGSTAmount', 'SalesLedger',
  ],
  PURCHASE_INVOICE: [
    'Date', 'VoucherNo', 'PartyLedger', 'PartyGSTIN', 'Item_Name', 'HSNCode',
    'Quantity', 'Unit', 'Rate', 'TaxableValue', 'CGSTRate', 'CGSTAmount',
    'SGSTRate', 'SGSTAmount', 'IGSTRate', 'IGSTAmount', 'PurchaseLedger',
  ],
};

interface ExtractionResult {
  columns: string[];
  rows: Record<string, string>[];
  docType: DocumentType;
  rowCount: number;
  bankSummary?: BankStatementSummary;
}

export default function Home() {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string>('');
  const [result, setResult] = useState<ExtractionResult | null>(null);

  // Lifted state
  const [activeDocType, setActiveDocType] = useState<DocumentType>('BANK_STATEMENT');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [elapsedTime, setElapsedTime] = useState<number>(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const startTimer = () => {
    setElapsedTime(0);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setElapsedTime((prev) => prev + 1);
    }, 1000);
  };

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    if (file) {
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setPreviewUrl(null);
    }
  }, [file]);

  const handleResult = (data: ExtractionResult) => {
    setResult(data);
    setStatus('success');
    setError('');
  };

  const handleError = (msg: string) => {
    if (msg) {
      setError(msg);
      setStatus('error');
    } else {
      setError('');
      if (status === 'error') setStatus('idle');
    }
  };

  const handleLoading = (loading: boolean) => {
    if (loading) {
      setStatus('processing');
      setResult(null);
      startTimer();
    } else {
      stopTimer();
    }
  };

  const resetFlow = () => {
    setFile(null);
    setResult(null);
    setStatus('idle');
    setError('');
    setElapsedTime(0);
    stopTimer();
  };

  return (
    <div className={styles.page}>
      {/* ── Hero ─────────────────────────────────────────────────────────────── */}
      <header>
        <div className={styles.hero}>
          <div className={styles.logoMark} aria-hidden="true">🔍</div>
          <h1 className={styles.heroTitle}>Mistri AI</h1>
          <p className={styles.heroSubtitle}>
            Extract structured data from Bank Statements, Sales &amp; Purchase Invoices in seconds.
            Powered by <strong>Mistri OCR</strong> — ready for Tally import.
          </p>
          <div className={styles.heroBadges}>
            {[
              { icon: '⚡', label: 'Mistri OCR' },
              { icon: '🔒', label: 'Queued & throttled' },
              { icon: '📊', label: 'CSV export' },
              { icon: '🏷️', label: 'GST-aware' },
            ].map(({ icon, label }) => (
              <span key={label} className={styles.heroBadge}>
                {icon} {label}
              </span>
            ))}
          </div>
        </div>
      </header>

      {/* ── Main ─────────────────────────────────────────────────────────────── */}
      <main className={styles.main}>
        {/* If no result, show centered upload flow. Otherwise, split view. */}
        <div className={!result ? styles.uploadLayout : styles.splitLayout}>

          {!result ? (
            // --- UPLOAD MODE ---
            <>
              <div className={`glass-card ${styles.card}`}>
                <div className={styles.cardTitle}>
                  <span>📤</span>
                  Upload Document
                  <StatusBadge status={status} />
                </div>

                <UploadForm
                  docType={activeDocType}
                  setDocType={setActiveDocType}
                  file={file}
                  setFile={setFile}
                  onResult={handleResult}
                  onError={handleError}
                  onLoading={handleLoading}
                  elapsedTime={elapsedTime}
                />
              </div>

              {error && (
                <div className={styles.errorAlert} role="alert" aria-live="assertive">
                  <span className={styles.errorIcon}>⚠️</span>
                  <span className={styles.errorMsg}>{error}</span>
                </div>
              )}
            </>
          ) : (
            // --- SPLIT VIEW MODE ---
            <>
              {/* Left: Document Preview */}
              <aside className={styles.previewPanel}>
                <div className={styles.cardTitle}>
                  <span>📄</span>
                  Document Preview
                  <button
                    onClick={resetFlow}
                    style={{ marginLeft: 'auto', fontSize: '12px', padding: '4px 8px', borderRadius: '4px', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)', cursor: 'pointer' }}
                  >
                    Extract Another
                  </button>
                </div>

                <div className={styles.pdfPreview}>
                  {previewUrl && file?.type.startsWith('image/') ? (
                    <img src={previewUrl} alt="Document Preview" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                  ) : previewUrl ? (
                    <iframe src={`${previewUrl}#toolbar=0&view=FitH`} className={styles.pdfObject} title="Document Preview" />
                  ) : null}
                </div>
              </aside>

              {/* Right: Results */}
              <section className={styles.rightPanel} aria-label="Extraction results">
                <ResultsTable
                  columns={result.columns}
                  rows={result.rows}
                  docType={result.docType}
                  rowCount={result.rowCount}
                  elapsedTime={elapsedTime}
                  bankSummary={result.bankSummary}
                />
              </section>
            </>
          )}
        </div>
      </main>

      {/* ── Footer ───────────────────────────────────────────────────────────── */}
      <footer className={styles.footer}>
        <span>Mistri AI</span>
        <span className={styles.footerDot} />
        <span>Powered by Mistri OCR</span>
        <span className={styles.footerDot} />
        <span>Queue: p-queue · concurrency 4</span>
      </footer>
    </div>
  );
}
