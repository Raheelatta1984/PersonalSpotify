import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PlayerProvider } from "@/components/PlayerProvider";

export const metadata: Metadata = {
  title: "SongHub — your personal Spotify, with AI ears",
  description:
    "A complete music streaming platform: AI-powered song search that understands plain language, listen-and-identify audio fingerprinting, an in-app web browser, and temporary downloads you can play offline.",
  applicationName: "SongHub",
};

export const viewport: Viewport = {
  themeColor: "#07080c",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <PlayerProvider>{children}</PlayerProvider>
      </body>
    </html>
  );
}
