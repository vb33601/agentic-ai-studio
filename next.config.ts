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
    // Server-only (Fly GitHub-secret encryption). Its ESM dist has a broken
    // ./libsodium.mjs ref that Turbopack can't resolve — keep it external so
    // Next requires the CJS build at runtime (traced into standalone output).
    "libsodium-wrappers",
    // Native/heavy browser automation used by the post-deploy frontend smoke
    // test — never bundle it; it's dynamically required only when a smoke run
    // happens, and skips gracefully where the Chromium binary is absent.
    "playwright-chromium",
    "playwright-core",
    "playwright",
    // Server-only ephemeral-sandbox SDK (pre-deploy build verification). Heavy +
    // node-only; loaded dynamically only when SANDBOX_VERIFY is enabled.
    "@vercel/sandbox",
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
