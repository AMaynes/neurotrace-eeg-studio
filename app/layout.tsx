/*
Purpose: Defines NeuroTrace document metadata, viewport policy, and root HTML shell.
File Dependencies: app/globals.css.
*/


import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

/** Builds page and sharing metadata from the forwarded request origin. */
export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "neurotrace.local";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const image = new URL("/og.png", origin).toString();
  const title = "NeuroTrace — Clinical EEG Studio";
  const description = "A browser-based workspace for reviewing and annotating EDF and MAT EEG recordings.";
  return {
    title,
    description,
    applicationName: "NeuroTrace",
    keywords: ["EEG", "SEEG", "EDF", "electrophysiology", "annotation", "seizure forecasting"],
    alternates: { canonical: "https://amaynes.github.io/neurotrace-eeg-studio/" },
    other: { "neurotrace-release": "public-v3" },
    openGraph: { title, description, type: "website", images: [{ url: image, width: 1731, height: 909, alt: "NeuroTrace clinical EEG annotation workspace" }] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#071014",
  width: "device-width",
  initialScale: 1,
};

/** Renders the root layout controls and their current state. */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
