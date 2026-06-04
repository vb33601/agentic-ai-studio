import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Platform — Agentic AI Application Builder",
  description: "Build complete apps, research topics, write code, create games with AI. Powered by Vercel AI SDK supporting GPT-4o, Claude, Gemini, and more.",
  keywords: ["AI", "code generation", "app builder", "LLM", "Next.js", "Claude", "GPT-4o"],
  openGraph: {
    title: "AI Platform",
    description: "Your autonomous AI operating system",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="h-full overflow-hidden bg-zinc-950 text-zinc-50 antialiased">
        {/* Puter.js — free, keyless AI image generation (puter.ai.txt2img). */}
        <Script src="https://js.puter.com/v2/" strategy="afterInteractive" />
        {children}
      </body>
    </html>
  );
}
