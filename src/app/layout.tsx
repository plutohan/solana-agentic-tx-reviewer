import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

// Prefer an explicit site URL, fall back to the Vercel deployment URL, then localhost.
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Solana Agentic Transaction Reviewer",
  description:
    "Review a Solana transaction in plain English with a deterministic risk report. Paste a confirmed signature, or an unsigned transaction to review before you sign.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
