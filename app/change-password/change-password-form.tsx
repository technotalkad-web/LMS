"use client";

import { useState } from "react";
import { Eye, EyeOff, Lock, CheckCircle2 } from "lucide-react";

export function ChangePasswordForm() {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const strength = strengthOf(pw);
  const match = pw.length > 0 && pw === confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!match) {
      setErr("Passwords don't match.");
      return;
    }
    setBusy(true);
    const res = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ new_password: pw }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(j.error ?? "Could not change password");
      return;
    }
    setDone(true);
    // Full nav so all server gates re-evaluate with the cleared flag.
    setTimeout(() => {
      window.location.href = "/select-org";
    }, 800);
  }

  if (done) {
    return (
      <div className="bg-paper border border-line rounded-lg p-6 text-center">
        <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-3" />
        <p className="serif text-2xl mb-1">Password updated</p>
        <p className="text-muted text-sm">Taking you to your dashboard…</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="bg-paper border border-line rounded-lg p-6 space-y-4">
      <div>
        <label className="block text-sm font-semibold mb-1">New password</label>
        <div className="relative">
          <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input
            type={show ? "text" : "password"}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            required
            minLength={10}
            autoFocus
            className="w-full pl-9 pr-10 py-2 border border-line rounded-md text-sm bg-canvas"
            placeholder="Minimum 10 characters"
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-ink"
            tabIndex={-1}
          >
            {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        <StrengthBar value={strength} />
      </div>

      <div>
        <label className="block text-sm font-semibold mb-1">Confirm new password</label>
        <div className="relative">
          <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input
            type={show ? "text" : "password"}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            className="w-full pl-9 pr-3 py-2 border border-line rounded-md text-sm bg-canvas"
            placeholder="Repeat your new password"
          />
        </div>
        {confirm.length > 0 && !match && (
          <p className="text-xs text-red-600 mt-1">Passwords don&apos;t match.</p>
        )}
      </div>

      {err && (
        <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-md p-3">
          {err}
        </div>
      )}

      <button
        type="submit"
        disabled={busy || !match || strength < 2}
        className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold rounded-md py-2.5 transition"
      >
        {busy ? "Updating…" : "Save new password"}
      </button>
    </form>
  );
}

function strengthOf(pw: string): number {
  if (pw.length < 10) return 0;
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/[0-9]/.test(pw)) classes++;
  if (/[^A-Za-z0-9]/.test(pw)) classes++;
  if (classes >= 4 && pw.length >= 14) return 4;
  if (classes >= 3) return 3;
  if (classes >= 2) return 2;
  return 1;
}

function StrengthBar({ value }: { value: number }) {
  const labels = ["Too short", "Weak", "Fair", "Good", "Strong"];
  const colors = [
    "bg-slate-200",
    "bg-red-400",
    "bg-amber-400",
    "bg-emerald-400",
    "bg-emerald-600",
  ];
  return (
    <div className="mt-2">
      <div className="flex gap-1 h-1.5">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`flex-1 rounded ${i < value ? colors[value] : "bg-slate-200"}`}
          />
        ))}
      </div>
      <p className="text-xs text-muted mt-1">{labels[value]}</p>
    </div>
  );
}
