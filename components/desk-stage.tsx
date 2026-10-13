"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Fit the existing phone as a whole, preserving its internal layout. */
export function DeskStage({ children, splash = false }: { children: ReactNode; splash?: boolean }) {
  const stageRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const phone = stage?.querySelector<HTMLElement>(":scope > .phone-shell-wrap");
    if (!stage || !phone) return;
    const fit = () => {
      const scale = Math.min(1, Math.max(1, stage.clientWidth - 64) / Math.max(1, phone.offsetWidth), Math.max(1, stage.clientHeight - 64) / Math.max(1, phone.offsetHeight));
      stage.style.setProperty("--desk-phone-scale", String(scale));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    observer.observe(phone);
    window.addEventListener("resize", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);

  return <main ref={stageRef} className={`app-root desk-stage${splash ? " splash-root" : ""}`}>{children}</main>;
}
