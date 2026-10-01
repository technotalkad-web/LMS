"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * A small monospace chip that shows a system id with a one-click copy.
 * Admins need these ids (course, package, path, journey, version) to wire
 * integrations such as the Yoddha CRM, which keys everything on them.
 */
export function IdChip({
  label,
  value,
  className = "",
}: {
  label: string;
  value: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <span
      className={`inline-flex items-center gap-1.5 max-w-full rounded-md border border-line bg-canvas px-2 py-0.5 text-[11px] text-muted ${className}`}
      title={`${label}: ${value}`}
      data-testid="id-chip"
      data-id-label={label}
    >
      <span className="uppercase tracking-wide shrink-0">{label}</span>
      <code className="font-mono text-ink/80 truncate max-w-[200px] sm:max-w-[320px]">{value}</code>
      <button
        type="button"
        aria-label={`Copy ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard blocked (http, permissions): the id is still selectable */
          }
        }}
        className="p-0.5 rounded hover:text-ink shrink-0"
      >
        {copied ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
      </button>
    </span>
  );
}
