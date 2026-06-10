import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained .next/standalone server (server.js + traced
  // node_modules) so the Docker image stays small and runs without a full
  // `npm install` at runtime. Required for the Render/Docker deploy.
  output: "standalone",
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
