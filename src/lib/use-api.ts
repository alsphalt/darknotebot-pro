"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, errorMessage } from "./client";

/**
 * Cached, de-duplicated GET hook.
 *
 * Every page used to fire its own request on mount, so navigating back and forth
 * re-fetched identical payloads and made the console feel slower than it is.
 * This keeps a small in-memory cache:
 *
 *  - a fresh entry (default 4 s) is served immediately with no network call;
 *  - a stale entry renders immediately and revalidates in the background, so a
 *    page never shows a spinner for data it already has;
 *  - concurrent callers of the same URL share one request;
 *  - the returned identity is stable, so a parent re-render does not restart it.
 *
 * `refresh()` always bypasses the cache — that is what the explicit Refresh
 * buttons call.
 */

interface Entry {
  data: unknown;
  at: number;
}

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<unknown>>();

/** Keep the cache small: this is a convenience layer, not a data store. */
const MAX_ENTRIES = 60;

function remember(url: string, data: unknown): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(url, { data, at: Date.now() });
}

/** Drop cached responses (used after a write that is known to change them). */
export function invalidateApi(prefix?: string): void {
  if (!prefix) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

export function useApi<T>(
  url: string | null,
  options: { refreshMs?: number; staleMs?: number; skipCache?: boolean } = {},
) {
  const { refreshMs, skipCache = false } = options;
  const staleMs = options.staleMs ?? 4000;

  const cachedValue = url && !skipCache ? (cache.get(url)?.data as T | undefined) : undefined;
  const [data, setData] = useState<T | null>(cachedValue ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(url) && cachedValue === undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (force: boolean) => {
      if (!url) return;
      if (!force && !skipCache) {
        const entry = cache.get(url);
        if (entry && Date.now() - entry.at < staleMs) {
          if (mounted.current) {
            setData(entry.data as T);
            setLoading(false);
            setError(null);
          }
          return;
        }
      }

      try {
        let request = inFlight.get(url);
        if (!request) {
          request = apiGet<T>(url).finally(() => inFlight.delete(url));
          inFlight.set(url, request);
        }
        const result = (await request) as T;
        remember(url, result);
        if (mounted.current) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (mounted.current) setError(errorMessage(err));
      } finally {
        if (mounted.current) setLoading(false);
      }
    },
    [skipCache, staleMs, url],
  );

  const refresh = useCallback(async () => {
    await load(true);
  }, [load]);

  useEffect(() => {
    if (!url) {
      setLoading(false);
      return;
    }
    // Serve what we have, then revalidate — one render, no spinner flash.
    const entry = skipCache ? undefined : cache.get(url);
    if (entry) {
      setData(entry.data as T);
      setLoading(false);
    } else {
      setLoading(true);
    }
    void load(false);
  }, [load, skipCache, url]);

  useEffect(() => {
    if (!options.refreshMs || !url) return;
    const timer = setInterval(() => void load(true), options.refreshMs);
    return () => clearInterval(timer);
  }, [load, options.refreshMs, url]);

  return { data, error, loading, refresh, setData };
}
