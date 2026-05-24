"use client";

export type CsvCell = string | number | null | undefined;

export function CsvButton({
  filename,
  header,
  rows,
  label = "Download CSV",
}: {
  filename: string;
  header: string[];
  rows: CsvCell[][];
  label?: string;
}) {
  function download() {
    const lines = [header, ...rows].map((row) =>
      row.map((c) => escapeCell(c)).join(",")
    );
    const csv = "﻿" + lines.join("\n") + "\n"; // BOM for Excel
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  return (
    <button
      type="button"
      onClick={download}
      disabled={rows.length === 0}
      className="text-xs px-3 py-1.5 border border-line rounded hover:border-ink disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function escapeCell(v: CsvCell): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
