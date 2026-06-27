"use client";

import { ToastProvider } from "./toast";
import { ConfirmProvider } from "./confirm";

/**
 * App-wide UI providers (toasts + confirmation dialog). Mounted once at the
 * root layout so any client component can call useToast()/useConfirm().
 */
export function UiProviders({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <ConfirmProvider>{children}</ConfirmProvider>
    </ToastProvider>
  );
}
