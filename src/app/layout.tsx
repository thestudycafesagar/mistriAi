import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Mistri AI — Bank & Invoice OCR Powered by Mistral',
  description:
    'Instantly extract structured data from Bank Statements, Sales Invoices, and Purchase Invoices using Mistral OCR AI. Export to CSV for Tally or any accounting software.',
  keywords: 'bank statement OCR, invoice data extraction, Mistral AI, GST invoice parser, Tally import, PDF to Excel',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
