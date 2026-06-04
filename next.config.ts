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
  // NOTE: We use "same-origin-allow-popups" (not "same-origin") so Puter.js's
  // OAuth login popup can post its result back to the app. This means the page
  // is NOT cross-origin isolated, so WebContainers' Node live-preview is
  // disabled (static HTML preview still works) — a deliberate trade-off to keep
  // free AI image generation (Puter + Pollinations) working without friction.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" }],
      },
    ];
  },
};

export default nextConfig;
