"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * TOTP enrollment for platform owners. Shows the otpauth QR + secret,
 * accepts the first 6-digit code, verifies it, then drops the user
 * into the challenge flow so the current session reaches AAL2.
 */
export function EnrollClient() {
  const router = useRouter();
  const supabase = createClient();
  const [step, setStep] = useState<"start" | "verify">("start");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `Platform owner – ${new Date().toLocaleDateString()}`,
      });
      if (!alive) return;
      if (error || !data) {
        setErr(error?.message ?? "Could not start enrollment");
        return;
      }
      setFactorId(data.id);
      setQr(data.totp.qr_code);
      setSecret(data.totp.secret);
      setStep("verify");
    })();
    return () => {
      alive = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function verify() {
    if (!factorId) return;
    setBusy(true);
    setErr(null);
    const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId });
    if (chErr || !ch) {
      setBusy(false);
      setErr(chErr?.message ?? "Could not request challenge");
      return;
    }
    const { error: vErr } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: ch.id,
      code,
    });
    setBusy(false);
    if (vErr) {
      setErr(vErr.message);
      return;
    }
    router.push("/super/organizations");
    router.refresh();
  }

  return (
    <div>
      <h1 className="text-xl font-bold mb-2">Set up two-factor authentication</h1>
      <p className="text-sm text-slate-400 mb-5">
        Platform-owner accounts require MFA. Scan this QR code with an authenticator app
        (Google Authenticator, 1Password, Authy), then enter the 6-digit code below.
      </p>

      {step === "start" && !err && (
        <p className="text-sm text-slate-500">Generating secret…</p>
      )}

      {step === "start" && err && (
        <div className="bg-red-900/40 border border-red-700/60 text-red-200 rounded-md p-3 text-sm">
          <p className="font-semibold mb-1">Couldn&apos;t start MFA enrollment</p>
          <p className="text-red-300/80 text-xs mb-2 font-mono break-all">{err}</p>
          <p className="text-xs">
            The most likely cause is that TOTP MFA is disabled in your Supabase
            project. Go to{" "}
            <span className="font-mono">
              Supabase Dashboard → Authentication → Sign In / Up → Multi-Factor
              Authentication
            </span>{" "}
            and enable TOTP, then reload this page.
          </p>
        </div>
      )}

      {step === "verify" && qr && (
        <div className="space-y-4">
          <div className="flex justify-center bg-white rounded-lg p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt="MFA QR code" className="w-44 h-44" />
          </div>
          {secret && (
            <div className="text-xs text-slate-400">
              <p>Or enter the secret manually:</p>
              <code className="block mt-1 bg-slate-800 px-2 py-1 rounded font-mono break-all text-slate-200">
                {secret}
              </code>
            </div>
          )}
          <div>
            <label className="text-xs text-slate-400">6-digit code</label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="123456"
              inputMode="numeric"
              className="w-full mt-1 bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-lg tracking-[0.4em] text-center font-mono"
            />
          </div>
          {err && <p className="text-sm text-red-400">{err}</p>}
          <button
            onClick={verify}
            disabled={busy || code.length !== 6}
            className="w-full bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-bold rounded-md py-2.5 transition disabled:opacity-60"
          >
            {busy ? "Verifying…" : "Verify & enable"}
          </button>
        </div>
      )}
    </div>
  );
}
