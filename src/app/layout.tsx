import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Binance Alpha - Premium Crypto Dashboard",
  description: "Real-time tracker and chart visualizer for early-stage Web3 project tokens from the Binance Alpha Trading hub.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
