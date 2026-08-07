import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Mark Mistral SDK as server-only external package (correct Next.js 15+ key)
  serverExternalPackages: ['@mistralai/mistralai'],
  // Only relevant when running `next dev` (which a VPS deployment shouldn't
  // be doing — see the "npm run build && npm start" note in AGENTS.md).
  // `next dev` blocks cross-origin requests to its own dev-only static/HMR
  // assets by default; this allowlists the VPS's IP so those specific
  // warnings stop, but it does NOT make `next dev` appropriate for
  // production traffic — `next start` has no such restriction because it
  // doesn't serve those dev-only resources at all.
  allowedDevOrigins: ['72.61.250.183'],
};

export default nextConfig;
