import { systemText } from "@creolab/contracts";
import { useLocale } from "../lib/session";
import { lazy, Suspense, useEffect, useState } from "react";

const PaywallContent = lazy(() => import("./PaywallContent"));

export type PaywallDetail = { message?: string; feature?: string };

export function PaywallDialog() {
  const locale = useLocale();
  const [open, setOpen] = useState<PaywallDetail | null>(null);

  useEffect(() => {
    function onPaywall(event: Event) {
      const detail = (event as CustomEvent<PaywallDetail>).detail || {};
      setOpen({
        message: detail.message || systemText(locale, "Эта функция доступна после подключения тарифа."),
        feature: detail.feature,
      });
    }
    window.addEventListener("basqar:paywall", onPaywall);
    return () => window.removeEventListener("basqar:paywall", onPaywall);
  }, []);

  if (!open) return null;
  return <Suspense fallback={null}><PaywallContent open={open} onClose={() => setOpen(null)} /></Suspense>;
}

export function openPaywall(message?: string) {
  window.dispatchEvent(
    new CustomEvent("basqar:paywall", {
      detail: { message: message || "Эта функция доступна после подключения тарифа." },
    }),
  );
}
