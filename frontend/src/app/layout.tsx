import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import Navbar from "@/components/layout/Navbar";
import Footer from "@/components/layout/Footer";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-heading",
  display: "swap",
});

export const metadata: Metadata = {
  title: "iPredict — Prediction Market on Stellar",
  description:
    "Predict. Win or Lose — You Always Earn. Decentralized prediction market on Stellar with near-zero fees and 5-second finality.",
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL || "https://ipredict-stellar.vercel.app"
  ),
  icons: {
    icon: "/favicon.svg",
  },
  openGraph: {
    title: "iPredict — Prediction Market on Stellar",
    description:
      "Predict. Win or Lose — You Always Earn. Decentralized prediction market with near-zero fees.",
    images: ["/og-image.svg"],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "iPredict — Prediction Market on Stellar",
    description:
      "Predict. Win or Lose — You Always Earn. Decentralized prediction market with near-zero fees.",
    images: ["/og-image.svg"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`dark ${inter.variable} ${spaceGrotesk.variable}`}>
      <body className="min-h-screen flex flex-col bg-surface text-slate-100 antialiased">
        <Providers>
          <Navbar />
          <main className="flex-1">{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
