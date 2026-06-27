"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

/**
 * App-wide toast notifications. Replaces transient inline messages and
 * browser alert() with consistent, accessible, auto-dismissing toasts.
 *
 *   const toast = useToast();
 *   toast.success("Saved"); toast.error("Failed"); toast.info("Heads up");
 */
type ToastType = "success" | "error" | "info";
type ToastItem = { id: number; type: ToastType; message: string };

type ToastApi = {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
};

const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

const STYLES: Record<
  ToastType,
  { ring: string; icon: React.ReactNode; live: "polite" | "assertive" }
> = {
  success: {
    ring: "border-emerald-300 bg-emerald-50 text-emerald-900",
    icon: <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />,
    live: "polite",
  },
  error: {
    ring: "border-red-300 bg-red-50 text-red-900",
    icon: <AlertCircle className="w-5 h-5 text-red-600 shrink-0" />,
    live: "assertive",
  },
  info: {
    ring: "border-line bg-paper text-ink",
    icon: <Info className="w-5 h-5 text-accent shrink-0" />,
    live: "polite",
  },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const remove = useCallback(
    (id: number) => setToasts((t) => t.filter((x) => x.id !== id)),
    []
  );

  const push = useCallback(
    (type: ToastType, message: string) => {
      const id = (idRef.current += 1);
      setToasts((t) => [...t, { id, type, message }]);
      // auto-dismiss; errors linger a little longer
      setTimeout(() => remove(id), type === "error" ? 7000 : 4500);
    },
    [remove]
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push("success", m),
      error: (m) => push("error", m),
      info: (m) => push("info", m),
    }),
    [push]
  );

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div
        className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-[min(92vw,22rem)] pointer-events-none"
        aria-live="polite"
      >
        {toasts.map((t) => {
          const s = STYLES[t.type];
          return (
            <div
              key={t.id}
              role={t.type === "error" ? "alert" : "status"}
              className={`pointer-events-auto flex items-start gap-3 rounded-xl border ${s.ring} px-4 py-3 shadow-lg text-sm`}
            >
              {s.icon}
              <p className="flex-1 leading-snug">{t.message}</p>
              <button
                onClick={() => remove(t.id)}
                aria-label="Dismiss notification"
                className="shrink-0 opacity-60 hover:opacity-100 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}
