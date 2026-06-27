"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AlertTriangle } from "lucide-react";

/**
 * Promise-based confirmation dialog. Replaces the unstyled, inaccessible
 * browser confirm() with a branded modal.
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ message: "Delete this?", destructive: true }))) return;
 */
type ConfirmOpts = {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
};
type ConfirmFn = (opts: ConfirmOpts | string) => Promise<boolean>;

const ConfirmCtx = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) throw new Error("useConfirm must be used within <ConfirmProvider>");
  return ctx;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<{
    opts: ConfirmOpts;
    resolve: (v: boolean) => void;
  } | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    const normalized = typeof opts === "string" ? { message: opts } : opts;
    return new Promise<boolean>((resolve) =>
      setState({ opts: normalized, resolve })
    );
  }, []);

  const settle = useCallback(
    (result: boolean) => {
      setState((s) => {
        s?.resolve(result);
        return null;
      });
    },
    []
  );

  // Focus the confirm button + Esc-to-cancel while open.
  useEffect(() => {
    if (!state) return;
    confirmBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") settle(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, settle]);

  const opts = state?.opts;

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {state && opts && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
        >
          <div
            className="absolute inset-0 bg-ink/40 backdrop-blur-[1px]"
            onClick={() => settle(false)}
          />
          <div className="relative w-full max-w-md rounded-2xl border border-line bg-paper p-6 shadow-2xl">
            <div className="flex items-start gap-3">
              {opts.destructive && (
                <span className="mt-0.5 shrink-0 rounded-full bg-red-100 p-1.5">
                  <AlertTriangle className="w-5 h-5 text-red-600" />
                </span>
              )}
              <div className="flex-1">
                <h2
                  id="confirm-title"
                  className="serif text-lg text-ink"
                >
                  {opts.title ?? (opts.destructive ? "Are you sure?" : "Please confirm")}
                </h2>
                <p className="mt-1 text-sm text-muted leading-relaxed">
                  {opts.message}
                </p>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => settle(false)}
                className="px-4 py-2 rounded-lg border border-line text-sm text-muted hover:text-ink hover:border-ink transition-colors"
              >
                {opts.cancelText ?? "Cancel"}
              </button>
              <button
                ref={confirmBtnRef}
                onClick={() => settle(true)}
                className={
                  opts.destructive
                    ? "px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 transition-colors"
                    : "px-4 py-2 rounded-lg bg-ink text-canvas text-sm font-semibold hover:opacity-90 transition"
                }
              >
                {opts.confirmText ?? (opts.destructive ? "Delete" : "Confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  );
}
