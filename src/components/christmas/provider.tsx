"use client";

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiGet } from "@/lib/client";
import {
  CHRISTMAS_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  mergePrefs,
  parseStored,
  prefersReducedMotion,
  serializePrefs,
  type ChristmasMode,
  type ChristmasPrefs,
  type ServerAppearance,
} from "./prefs";

/**
 * Christmas edition controller.
 *
 * - Applies the appearance defaults from the server, then the device choice.
 * - Sets `data-christmas` / `data-motion` on <html>, which is all the CSS needs.
 * - Shows the introduction once per device (never again unless replayed) and only
 *   when the user has not asked for reduced motion.
 *
 * The snow canvas is loaded lazily: it is decorative, so it must never delay the
 * first paint or the hydration of the console.
 */
const SnowLayer = dynamic(() => import("./snow").then((module) => module.SnowLayer), { ssr: false });

interface ChristmasContextValue {
  prefs: ChristmasPrefs;
  ready: boolean;
  setMode: (mode: ChristmasMode) => void;
  setIntro: (enabled: boolean) => void;
  setSnow: (enabled: boolean) => void;
  replayIntro: () => void;
  dismissIntro: () => void;
}

const ChristmasContext = createContext<ChristmasContextValue | null>(null);

function readLocal(): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  try {
    return parseStored(window.localStorage.getItem(CHRISTMAS_STORAGE_KEY));
  } catch {
    return {};
  }
}

function persist(prefs: ChristmasPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHRISTMAS_STORAGE_KEY, serializePrefs(prefs));
  } catch {
    /* storage can be full or blocked; the session still behaves */
  }
}

export function ChristmasProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<ChristmasPrefs>(() => mergePrefs(DEFAULT_APPEARANCE, null));
  const [ready, setReady] = useState(false);
  const [introOpen, setIntroOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<number | null>(null);

  // Defaults from the server, overridden by this device's choice.
  useEffect(() => {
    let cancelled = false;
    const local = readLocal();
    setPrefs(mergePrefs(DEFAULT_APPEARANCE, local));

    apiGet<{ appearance: ServerAppearance }>("/api/auth/policy")
      .then((policy) => {
        if (cancelled) return;
        setPrefs(mergePrefs(policy.appearance ?? DEFAULT_APPEARANCE, local));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // One attribute pair drives every festive style.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.dataset.christmas = prefs.mode;
    root.dataset.motion = prefs.mode === "reduced" ? "reduced" : "full";
  }, [prefs.mode]);

  // First-run introduction.
  useEffect(() => {
    if (!ready) return;
    if (!prefs.intro || prefs.introSeen || prefs.mode === "off") return;
    if (prefersReducedMotion()) return;
    setIntroOpen(true);
  }, [prefs.intro, prefs.introSeen, prefs.mode, ready]);

  useEffect(() => {
    if (!introOpen) return;
    timer.current = window.setTimeout(() => {
      setLeaving(true);
      timer.current = window.setTimeout(() => {
        setIntroOpen(false);
        setLeaving(false);
        setPrefs((current) => {
          const next = { ...current, introSeen: true };
          persist(next);
          return next;
        });
      }, 620);
    }, 4200);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [introOpen]);

  const dismissIntro = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    setLeaving(true);
    window.setTimeout(() => {
      setIntroOpen(false);
      setLeaving(false);
      setPrefs((current) => {
        const next = { ...current, introSeen: true };
        persist(next);
        return next;
      });
    }, 420);
  }, []);

  const update = useCallback((patch: Partial<ChristmasPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      if (next.mode === "reduced") next.snow = false;
      persist(next);
      return next;
    });
  }, []);

  const value = useMemo<ChristmasContextValue>(
    () => ({
      prefs,
      ready,
      setMode: (mode) => update({ mode }),
      setIntro: (intro) => update({ intro }),
      setSnow: (snow) => update({ snow }),
      replayIntro: () => {
        update({ intro: true, introSeen: false });
        setIntroOpen(true);
      },
      dismissIntro,
    }),
    [dismissIntro, prefs, ready, update],
  );

  return (
    <ChristmasContext.Provider value={value}>
      {children}
      {prefs.mode !== "off" && prefs.snow && prefs.mode !== "reduced" ? <SnowLayer /> : null}
      {introOpen ? <ChristmasIntro leaving={leaving} onSkip={dismissIntro} /> : null}
    </ChristmasContext.Provider>
  );
}

export function useChristmas(): ChristmasContextValue {
  const context = useContext(ChristmasContext);
  if (!context) throw new Error("useChristmas must be used inside ChristmasProvider");
  return context;
}

/**
 * The introduction: dark screen, lights, snow, the glowing wordmark, the credit,
 * then a smooth exit into the dashboard. Content is static text — nothing here
 * fetches, so it costs one paint.
 */
function ChristmasIntro({ leaving, onSkip }: { leaving: boolean; onSkip: () => void }) {
  return (
    <div className="xmas-intro" data-leaving={leaving ? "true" : "false"} role="presentation">
      <div className="xmas-halo" aria-hidden="true" />
      <div className="xmas-lights" aria-hidden="true">
        {Array.from({ length: 14 }, (_, index) => (
          <i key={index} />
        ))}
      </div>

      <div className="relative z-10 px-6 text-center">
        <h1 className="xmas-brand">
          <span>DARKNOTE</span>
        </h1>
        <p className="xmas-credit">POWERED BY JIMMY M, TECH</p>
        <div className="xmas-ribbon mx-auto mt-8 h-px w-40 rounded-full opacity-70" aria-hidden="true" />
      </div>

      <button type="button" className="xmas-skip" onClick={onSkip}>
        Skip intro
      </button>
    </div>
  );
}
