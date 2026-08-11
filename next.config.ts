import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Mark Mistral SDK as server-only external package (correct Next.js 15+ key)
  serverExternalPackages: ['@mistralai/mistralai'],
  // Only relevant when running `next dev` (which a VPS deployment shouldn't
  // be doing — see the "npm run build && npm start" note in AGENTS.md).
  // `next dev` blocks cross-origin requests to its own dev-only static/HMR
  // assets by default; this allowlists specific hosts so those warnings
  // stop, but it does NOT make `next dev` appropriate for production
  // traffic — `next start` has no such restriction because it doesn't serve
  // those dev-only resources at all. There's no wildcard-IP/CIDR support in
  // allowedDevOrigins (only exact hostnames or wildcard subdomains), so each
  // new device that accesses the dev server has to be added here by hand —
  // '72.61.250.183' is the VPS, '192.168.23.226' is a LAN device.
  allowedDevOrigins: ['72.61.250.183', '192.168.23.226'],
  experimental: {
    // src/proxy.ts (CORS headers) matches every /api/:path* route, and
    // Next.js 16 automatically clones + buffers the body of any request a
    // proxy matches, capped at 10MB by default — silently truncating
    // anything larger with no error to the caller (see
    // node_modules/next/dist/docs/.../proxyClientMaxBodySize.md). This app
    // accepts PDFs up to MAX_PDF_SIZE_BYTES (200MB, extractHandler.ts), so
    // the proxy's own cap has to match or every extraction above 10MB gets
    // silently truncated before extractHandler.ts ever sees it.
    proxyClientMaxBodySize: '200mb',
  },
};

export default nextConfig;
