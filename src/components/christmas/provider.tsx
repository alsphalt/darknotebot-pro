"use client";

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiGet } from "@/lib/client";
import {
  CHRISTMAS_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  isStandaloneLaunch,
  mergePrefs,
  parseStored,
  prefersReducedMotion,
  serializePrefs,
  storedMode,
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

/**
 * Lifts the pre-hydration boot shield (see `.xmas-boot` in globals.css). The
 * shield only renders for installed apps: it covers the console until the
 * introduction has taken over, so the dashboard never paints ahead of it.
 */
function releaseBootShield(): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.xmasBoot = "done";
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

  /**
   * Installed-app launch: the introduction plays every time the app is opened,
   * and it starts before the console is reachable. This runs on mount — not
   * after the policy request — so nothing is gated behind a network round trip.
   *
   * `introSeen` is deliberately ignored here: it only marks the browser's
   * first-run moment. Turning Christmas effects off, or asking for reduced
   * motion, still wins.
   */
  useEffect(() => {
    if (!isStandaloneLaunch()) {
      releaseBootShield();
      return;
    }
    if (prefersReducedMotion() || storedMode(readLocal(), DEFAULT_APPEARANCE) === "off") {
      releaseBootShield();
      return;
    }
    setIntroOpen(true);
  }, []);

  // The policy can still say the effects are off. The launch intro is decided
  // before that response arrives, so honour it here instead of showing a
  // festive intro on an app that has Christmas turned off.
  useEffect(() => {
    if (!introOpen || prefs.mode !== "off") return;
    setIntroOpen(false);
    setLeaving(false);
    releaseBootShield();
  }, [introOpen, prefs.mode]);

  // First-run introduction (browser tabs; installed launches are handled above).
  useEffect(() => {
    if (!ready) return;
    if (isStandaloneLaunch()) return;
    if (!prefs.intro || prefs.introSeen || prefs.mode === "off" || prefersReducedMotion()) {
      releaseBootShield();
      return;
    }
    setIntroOpen(true);
  }, [prefs.intro, prefs.introSeen, prefs.mode, ready]);

  useEffect(() => {
    if (!introOpen) return;
    timer.current = window.setTimeout(() => {
      setLeaving(true);
      // Reveal the console underneath while the intro fades out, not after it.
      releaseBootShield();
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
    releaseBootShield();
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
      {/* Installed apps paint this before hydration; it is display:none in a tab. */}
      <div className="xmas-boot" aria-hidden="true" />
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
