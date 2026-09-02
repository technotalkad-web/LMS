"use client";

import { Printer } from "lucide-react";

/** Browser-native print → the user saves a PDF; zero server cost. */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex items-center gap-2 px-5 py-2.5 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90 print:hidden"
    >
      <Printer className="w-4 h-4" /> Print / Save as PDF
    </button>
  );
}
