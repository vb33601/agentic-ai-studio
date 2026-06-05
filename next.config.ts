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
  // Cross-origin isolation enables WebContainers' in-browser Node/dev-server
  // preview (Run app). COEP "credentialless" still lets cross-origin assets
  // (Monaco CDN, etc.) load. Image generation is a same-origin /api/image proxy
  // so it's unaffected. (Puter was removed, so no popup constraint remains.)
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
