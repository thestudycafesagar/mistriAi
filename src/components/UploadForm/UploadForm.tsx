'use client';

import { useState, useRef, useCallback, DragEvent, ChangeEvent } from 'react';
import styles from './UploadForm.module.css';

export type DocumentType = 'BANK_STATEMENT' | 'SALES_INVOICE' | 'PURCHASE_INVOICE';

// Mirrors BankStatementSummary in src/lib/mistral.ts (kept as a local type
// rather than importing from that server-only module, consistent with
// DocumentType above). Only present in the API response for BANK_STATEMENT.
export interface BankStatementSummary {
  totalDebit: string;
  totalCredit: string;
  openingBalance: string;
  closingBalance: string;
  actualNetChange: string;
  expectedNetChange?: string;
  reconciled: boolean | null;
  discrepancy?: string;
}

const DOC_TYPES: {
  id: DocumentType;
  icon: string;
  title: string;
  desc: string;
}[] = [
  {
    id: 'BANK_STATEMENT',
    icon: '🏦',
    title: 'Bank Statement',
    desc: 'Extract all transactions',
  },
  {
    id: 'SALES_INVOICE',
    icon: '📤',
    title: 'Sales Invoice',
    desc: 'Line items + GST details',
  },
  {
    id: 'PURCHASE_INVOICE',
    icon: '📥',
    title: 'Purchase Invoice',
    desc: 'Supplier items + GST',
  },
];

const ACCEPTED = '.pdf,.jpg,.jpeg,.png,.webp,.tiff,.tif,.gif';
// PDFs are chunked server-side (5 pages/chunk), so a much larger original
// file is fine — this just mirrors the server's safety-net cap in
// src/app/api/extract/route.ts. Images aren't chunked, so keep that tight.
const MAX_PDF_MB = 200;
const MAX_IMAGE_MB = 25;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function getFileIcon(file: File): string {
  if (file.type === 'application/pdf') return '📄';
  if (file.type.startsWith('image/')) return '🖼️';
  return '📎';
}

interface UploadFormProps {
  docType: DocumentType;
  setDocType: (type: DocumentType) => void;
  file: File | null;
  setFile: (file: File | null) => void;
  onResult: (data: {
    columns: string[];
    rows: Record<string, string>[];
    docType: DocumentType;
    rowCount: number;
    bankSummary?: BankStatementSummary;
  }) => void;
  onError: (msg: string) => void;
  onLoading: (loading: boolean) => void;
  elapsedTime?: number;
}

export default function UploadForm({
  docType,
  setDocType,
  file,
  setFile,
  onResult,
  onError,
  onLoading,
  elapsedTime = 0,
}: UploadFormProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const setLoadingState = (v: boolean) => {
    setLoading(v);
    onLoading(v);
  };

  const handleFile = useCallback((incoming: File) => {
    const maxMb = incoming.type === 'application/pdf' ? MAX_PDF_MB : MAX_IMAGE_MB;
    if (incoming.size > maxMb * 1024 * 1024) {
      onError(`File is too large (${formatBytes(incoming.size)}). Maximum is ${maxMb} MB.`);
      return;
    }
    setFile(incoming);
    onError('');
  }, [onError]);

  const onDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) handleFile(dropped);
  }, [handleFile]);

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(true);
  };
  const onDragLeave = () => setIsDragOver(false);

  const onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    if (picked) handleFile(picked);
  };

  const clearFile = () => {
    setFile(null);
    if (inputRef.current) inputRef.current.value = '';
    onError('');
  };

  const handleSubmit = async () => {
    if (!file) { onError('Please select a file to upload.'); return; }

    setLoadingState(true);
    onError('');

    try {
      const form = new FormData();
      form.append('file', file);
      form.append('docType', docType);

      const res = await fetch('/api/extract', { method: 'POST', body: form });
      const json = await res.json();

      if (!res.ok || !json.success) {
        throw new Error(json.error ?? `Server error: ${res.status}`);
      }

      onResult({
        columns: json.columns,
        rows: json.data,
        docType: json.docType,
        rowCount: json.rowCount,
        bankSummary: json.bankSummary,
      });
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      setLoadingState(false);
    }
  };

  const canSubmit = !!file && !loading;

  return (
    <div className={styles.form}>
      {/* Document Type Selector */}
      <div>
        <span className={styles.typeLabel}>Document Type</span>
        <div className={styles.typeGrid}>
          {DOC_TYPES.map((dt) => (
            <button
              key={dt.id}
              type="button"
              id={`doc-type-${dt.id.toLowerCase()}`}
              className={`${styles.typeButton} ${docType === dt.id ? styles.active : ''}`}
              onClick={() => setDocType(dt.id)}
              disabled={loading}
              aria-pressed={docType === dt.id}
            >
              <span className={styles.typeIcon}>{dt.icon}</span>
              <span className={styles.typeTitle}>{dt.title}</span>
              <span className={styles.typeDesc}>{dt.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Drop Zone */}
      <div
        id="upload-drop-zone"
        className={`${styles.dropZone} ${isDragOver ? styles.dragOver : ''} ${file ? styles.hasFile : ''}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        role="button"
        tabIndex={0}
        aria-label="Upload file drop zone"
        onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          className={styles.fileInput}
          type="file"
          id="file-input"
          accept={ACCEPTED}
          onChange={onInputChange}
          disabled={loading}
          aria-label="Select file for upload"
        />
        {file ? (
          <>
            <span className={styles.dropIcon}>✅</span>
            <span className={styles.dropTitle}>File ready to extract</span>
            <span className={styles.dropSubtitle}>Click &ldquo;Extract Data&rdquo; to process</span>
          </>
        ) : (
          <>
            <span className={styles.dropIcon}>{isDragOver ? '📂' : '📁'}</span>
            <span className={styles.dropTitle}>
              {isDragOver ? 'Drop it here!' : 'Drop your file here or click to browse'}
            </span>
            <span className={styles.dropSubtitle}>PDF up to {MAX_PDF_MB} MB, images up to {MAX_IMAGE_MB} MB</span>
            <div className={styles.dropFormats}>
              {['PDF', 'JPEG', 'PNG', 'WEBP', 'TIFF'].map((f) => (
                <span key={f} className={styles.formatPill}>{f}</span>
              ))}
            </div>
          </>
        )}
      </div>

      {/* File Preview */}
      {file && (
        <div className={styles.filePreview}>
          <span className={styles.fileIcon}>{getFileIcon(file)}</span>
          <div className={styles.fileInfo}>
            <div className={styles.fileName}>{file.name}</div>
            <div className={styles.fileMeta}>
              {formatBytes(file.size)} · {file.type || 'unknown type'}
            </div>
          </div>
          <button
            type="button"
            className={styles.clearBtn}
            onClick={clearFile}
            disabled={loading}
            aria-label="Remove selected file"
            title="Remove file"
          >
            ✕
          </button>
        </div>
      )}

      {/* Queue note when processing */}
      {loading && (
        <div className={styles.queueNote}>
          <span className={styles.queueDot} />
          Your document is queued and being processed. Time elapsed: {elapsedTime}s
        </div>
      )}

      {/* Submit */}
      <button
        id="extract-btn"
        type="button"
        className={styles.submitBtn}
        onClick={handleSubmit}
        disabled={!canSubmit}
        aria-busy={loading}
      >
        {loading ? (
          <>
            <span className={styles.spinner} aria-hidden="true" />
            Extracting…
          </>
        ) : (
          <>
            <span aria-hidden="true">⚡</span>
            Extract Data
          </>
        )}
      </button>
    </div>
  );
}
