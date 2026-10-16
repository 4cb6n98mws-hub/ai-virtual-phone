"use client";

import { useEffect } from "react";

export function PWARegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    // Deploy previews are used for visual QA. A cache-first service worker can
    // otherwise keep an iPad on the previous CSS bundle even after Netlify has
    // finished a successful deploy. Keep the production PWA cache intact, but
    // make preview hosts self-cleaning and reload once without the old worker.
    if (window.location.hostname.startsWith("deploy-preview-")) {
      const cleanupPreviewCache = async () => {
        const registrations = await navigator.serviceWorker.getRegistrations();
        const hadRegistration = registrations.length > 0;
        await Promise.all(registrations.map((registration) => registration.unregister()));

        if ("caches" in window) {
          const keys = await caches.keys();
          await Promise.all(
            keys
              .filter((key) => key.startsWith("ai-phone-pwa-"))
              .map((key) => caches.delete(key))
          );
        }

        const reloadKey = "ai-phone-preview-cache-cleared-v1";
        if (hadRegistration && sessionStorage.getItem(reloadKey) !== "1") {
          sessionStorage.setItem(reloadKey, "1");
          window.location.reload();
        }
      };

      void cleanupPreviewCache().catch((error) => {
        console.warn("[PWA] Preview cache cleanup failed:", error);
      });
      return;
    }

    let cancelled = false;
    const register = () => {
      if (cancelled) return;
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error) => {
        console.warn("[PWA] Service worker registration failed:", error);
      });
    };

    if (document.readyState === "complete") {
      register();
      return () => {
        cancelled = true;
      };
    }

    window.addEventListener("load", register, { once: true });
    return () => {
      cancelled = true;
      window.removeEventListener("load", register);
    };
  }, []);

  return null;
}
