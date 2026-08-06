import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Mark Mistral SDK as server-only external package (correct Next.js 15+ key)
  serverExternalPackages: ['@mistralai/mistralai'],
};

export default nextConfig;
