import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@prisma/client",
    "prisma",
    "socket.io-client",
    "pdf-parse",
    "mammoth",
    "xlsx",
  ],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "oaidalleapiprodscus.blob.core.windows.net" },
      { protocol: "https", hostname: "**.openai.com" },
    ],
  },
  turbopack: {
    root: __dirname,
  },
  // WebContainers require the page to be cross-origin isolated. COEP
  // "credentialless" keeps cross-origin images (Pollinations/DALL-E) and CDN
  // assets (Monaco) working without needing CORP headers on them.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
    ];
  },
};

export default nextConfig;
