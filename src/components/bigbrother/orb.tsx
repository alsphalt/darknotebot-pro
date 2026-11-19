"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The floating BIGBROTHER icon — a drifting mist orb (🌫️), not a generic bot
 * glyph. Mounted in the app shell, so it survives navigation, and positioned
 * with the safe-area inset so it never sits on top of mobile controls.
 */
export function BigBrotherOrb({ hasProblems = false }: { hasProblems?: boolean }) {
  const pathname = usePathname();
  if (pathname?.startsWith("/bigbrother")) return null;

  return (
    <Link
      href="/bigbrother"
      aria-label="Open BIGBROTHER AI"
      title="BIGBROTHER — DARKNOTE assistant"
      className="group fixed right-4 z-40 flex items-center gap-2 rounded-full outline-none transition-transform hover:scale-[1.04] focus-visible:ring-2 focus-visible:ring-accent/60 active:scale-95 sm:right-6"
      style={{ bottom: "calc(1rem + env(safe-area-inset-bottom, 0px))" }}
    >
      <span className="pointer-events-none hidden max-w-0 overflow-hidden whitespace-nowrap rounded-full border border-accent/30 bg-ink-900/90 px-0 py-1.5 text-[11px] font-medium tracking-[0.14em] text-accent-soft opacity-0 transition-all duration-300 group-hover:max-w-[180px] group-hover:px-3 group-hover:opacity-100 md:inline-flex">
        BIGBROTHER
      </span>
      <span className="bb-orb">
        <span className="bb-orb-mist">
          <span />
          <span />
          <span />
        </span>
        <span className="relative z-10 text-[19px] leading-none drop-shadow-[0_1px_2px_rgba(0,0,0,0.4)]">🌫️</span>
        {hasProblems && (
          <span className="absolute -right-0.5 -top-0.5 z-20 h-2.5 w-2.5 rounded-full border-2 border-ink-950 bg-rose-400" />
        )}
      </span>
    </Link>
  );
}
