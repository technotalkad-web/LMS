import type { Metadata } from "next";
import {
  Geist_Mono,
  Inter,
  Poppins,
  Plus_Jakarta_Sans,
  Roboto,
  Merriweather,
} from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";

// ----- Global default + approved org-level brand fonts -----
// Inter is the platform's absolute default. The four others below are
// the approved white-label overrides each tenant can pick in
// Settings → Workspace → Brand font. We expose them all as CSS
// variables so tenant code can swap them via `font-family`.

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  display: "swap",
  weight: ["300", "400", "500", "600", "700"],
});

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  display: "swap",
});

const roboto = Roboto({
  variable: "--font-roboto",
  subsets: ["latin"],
  display: "swap",
  weight: ["300", "400", "500", "700"],
});

const merriweather = Merriweather({
  variable: "--font-merriweather",
  subsets: ["latin"],
  display: "swap",
  weight: ["300", "400", "700"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "LMS",
  description: "Multi-tenant learning platform",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const themeCookie = cookieStore.get("theme")?.value;
  const theme = themeCookie === "dark" ? "dark" : "light";

  // Note: we apply Inter as the body font via the className AND the
  // CSS `--font-sans` variable in globals.css. That guarantees every
  // descendant inherits Inter unless an org-level wrapper overrides
  // `font-family` (which happens in /[org]/(admin) and /[org]/(learner)
  // layouts when brand_font is set).
  const fontVars = [
    inter.variable,
    poppins.variable,
    jakarta.variable,
    roboto.variable,
    merriweather.variable,
    geistMono.variable,
  ].join(" ");

  return (
    <html
      lang="en"
      data-theme={theme}
      className={`${fontVars} h-full`}
      suppressHydrationWarning
    >
      <body
        className="min-h-full bg-canvas text-ink font-sans"
        suppressHydrationWarning
        style={{ fontFamily: "var(--font-sans)" }}
      >
        {children}
      </body>
    </html>
  );
}
