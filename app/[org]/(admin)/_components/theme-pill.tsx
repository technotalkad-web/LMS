"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

export function ThemePill() {
  const [theme, setTheme] = useState<Theme>("light");
  useEffect(() => {
    const cur = (document.documentElement.dataset.theme as Theme | undefined) ?? "light";
    setTheme(cur);
  }, []);

  async function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setTheme(next);
    await fetch("/api/theme", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: next }),
    });
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className="text-[10px] uppercase tracking-wide px-2 py-0.5 border border-line rounded hover:border-ink"
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {theme === "dark" ? "☀ Light" : "☾ Dark"}
    </button>
  );
}
