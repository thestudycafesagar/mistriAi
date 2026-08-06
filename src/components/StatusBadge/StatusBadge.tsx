import styles from './StatusBadge.module.css';

export type Status = 'idle' | 'processing' | 'success' | 'error';

const LABELS: Record<Status, string> = {
  idle:       'Ready',
  processing: 'Processing',
  success:    'Extracted',
  error:      'Error',
};

interface StatusBadgeProps {
  status: Status;
  label?: string;
}

export default function StatusBadge({ status, label }: StatusBadgeProps) {
  return (
    <span className={`${styles.badge} ${styles[status]}`} role="status" aria-live="polite">
      <span className={styles.dot} aria-hidden="true" />
      {label ?? LABELS[status]}
    </span>
  );
}
