"use client";

import { useEffect, useRef } from "react";

/**
 * Shared polling loop for the live panels.
 *
 * - Ticks every `intervalMs`, but never overlaps: a tick is skipped while
 *   the previous run is still in flight.
 * - Pauses while the tab is hidden, and refreshes immediately when the
 *   tab becomes visible again so the user never stares at stale data.
 * - Keeps calling the latest callback without resetting the timer.
 */
export function usePolling(callback: () => Promise<void> | void, intervalMs: number) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const runningRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      if (cancelled || runningRef.current || document.hidden) return;
      runningRef.current = true;
      try {
        await callbackRef.current();
      } catch {
        // Callers surface their own errors; a polling failure must not
        // become an unhandled rejection or kill the loop.
      } finally {
        runningRef.current = false;
      }
    };

    const timer = window.setInterval(() => { void tick(); }, intervalMs);
    const onVisibilityChange = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs]);
}
