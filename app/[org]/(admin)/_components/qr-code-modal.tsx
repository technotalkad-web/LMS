"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Copy, Check, Download, X, QrCode as QrIcon } from "lucide-react";

/**
 * Admin "Share via QR" modal for a course or learning path.
 *
 * The QR simply encodes the item's canonical URL — no tokens, nothing stored.
 * Scanning it walks the normal flow: middleware bounces signed-out learners to
 * this org's branded login with ?next=<the page>, every auth mode (password /
 * magic link / SSO) returns them to that exact page, and the page's live
 * entitlement check admits assigned (or org-public) learners and bounces the
 * rest to the dashboard with a "not assigned — contact your admin" banner.
 * Because access is checked at scan time, un-assigning someone later revokes
 * a printed QR automatically; the code itself never expires.
 */
export function QrCodeModal({
  title,
  path,
  kind,
  onClose,
}: {
  title: string;
  /** App-relative path the QR should open, e.g. /acme/courses/<id> */
  path: string;
  kind: "course" | "learning path";
  onClose: () => void;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const url = typeof window === "undefined" ? path : `${window.location.origin}${path}`;

  useEffect(() => {
    let cancelled = false;
    // Error correction M + generous size scans reliably from print and screens.
    QRCode.toDataURL(url, { width: 640, margin: 2, errorCorrectionLevel: "M" })
      .then((d) => {
        if (!cancelled) setDataUrl(d);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the URL is still visible to select manually */
    }
  }

  const fileName = `qr-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60) || kind}.png`;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`QR code for ${title}`}
    >
      <div
        className="bg-paper rounded-2xl border border-line shadow-xl max-w-sm w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="font-bold text-ink flex items-center gap-2">
              <QrIcon className="w-4 h-4" /> Share via QR code
            </h2>
            <p className="text-xs text-muted mt-1 line-clamp-2">{title}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:text-ink p-1 -m-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="bg-white rounded-xl border border-line p-4 flex items-center justify-center">
          {dataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={dataUrl} alt={`QR code opening ${title}`} className="w-56 h-56" />
          ) : (
            <div className="w-56 h-56 flex items-center justify-center text-xs text-muted">
              Generating…
            </div>
          )}
        </div>

        <p className="mt-2 text-[11px] text-muted break-all font-mono">{url}</p>

        <div className="mt-4 flex gap-2">
          <a
            href={dataUrl ?? "#"}
            download={fileName}
            aria-disabled={!dataUrl}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold ${
              dataUrl
                ? "bg-ink text-canvas hover:opacity-90"
                : "bg-canvas text-muted cursor-not-allowed"
            }`}
          >
            <Download className="w-4 h-4" /> Download PNG
          </a>
          <button
            type="button"
            onClick={copyLink}
            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold border border-line hover:bg-canvas"
          >
            {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>

        <p className="mt-3 text-xs text-muted">
          Learners scan → sign in with their company email → land on this {kind}. Only
          learners you&apos;ve assigned (or everyone, if it&apos;s org-public) can open it;
          others see “not assigned — contact your admin”. Un-assigning someone revokes
          their access instantly — no need to reprint.
        </p>
      </div>
    </div>
  );
}
