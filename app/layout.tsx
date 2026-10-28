import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const font = Geist({ variable: "--font-main", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "questions",
  description: "unlimited trivia. every question is asked once.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${font.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
