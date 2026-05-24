"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * MFA challenge for platform owners. The user already enrolled a
 * TOTP factor; we ask them for the current code to elevate the
 * session from AAL1 → AAL2.
 */
export function ChallengeClient() {
  const router = useRouter();
  const supabase = createClient();
  const [factorId, setFactorId] = useState<string | null>(null);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (!alive) return;
      if (error || !data) {
        setErr(error?.message ?? "Could not list factors");
        return;
      }
      const totp = (data.totp ?? []).find((f) => f.status === "verified");
      if (!totp) {
        router.push("/super-mfa/enroll");
        return;
      }
      setFactorId(totp.id);
      const ch = await supabase.auth.mfa.challenge({ factorId: totp.id });
      if (!alive) return;
      if (ch.error || !ch.data) {
        setErr(ch.error?.message ?? "Could not start challenge");
        return;
      }
      setChallengeId(ch.data.id);
    })();
    return () => {
      alive = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function verify() {
    if (!factorId || !challengeId) return;
    setBusy(true);
    setErr(null);
    const { error } = await supabase.auth.mfa.verify({
      factorId,
      challengeId,
      code,
    });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    router.push("/super/organizations");
    router.refresh();
  }

  return (
    <div>
      <h1 className="text-xl font-bold mb-2">Two-factor verification</h1>
      <p className="text-sm text-slate-400 mb-5">
        Enter the 6-digit code from your authenticator app to continue.
      </p>
      <div>
        <label className="text-xs text-slate-400">6-digit code</label>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="123456"
          inputMode="numeric"
          autoFocus
          className="w-full mt-1 bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-lg tracking-[0.4em] text-center font-mono"
        />
      </div>
      {err && <p className="text-sm text-red-400 mt-3">{err}</p>}
      <button
        onClick={verify}
        disabled={busy || code.length !== 6 || !challengeId}
        className="w-full mt-4 bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-bold rounded-md py-2.5 transition disabled:opacity-60"
      >
        {busy ? "Verifying…" : "Verify"}
      </button>
    </div>
  );
}
