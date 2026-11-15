"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, errorMessage } from "./client";

export function useApi<T>(url: string | null, options: { refreshMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!url) return;
    try {
      const result = await apiGet<T>(url);
      if (mounted.current) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (mounted.current) setError(errorMessage(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    setLoading(Boolean(url));
    void refresh();
  }, [refresh, url]);

  useEffect(() => {
    if (!options.refreshMs || !url) return;
    const timer = setInterval(() => void refresh(), options.refreshMs);
    return () => clearInterval(timer);
  }, [options.refreshMs, refresh, url]);

  return { data, error, loading, refresh, setData };
}
