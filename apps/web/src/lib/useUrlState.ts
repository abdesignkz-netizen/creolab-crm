import { useCallback, useEffect, useRef, type SetStateAction } from "react";
import { useSearchParams } from "react-router-dom";

/** Filters survive reload/back and can be linked from dashboard metrics. */
export function useUrlState<T extends string>(key: string, fallback: T, allowed?: readonly T[]) {
  const [params, setParams] = useSearchParams();
  const raw = params.get(key);
  const value = raw !== null && (!allowed || allowed.includes(raw as T)) ? raw as T : fallback;
  const setValue = useCallback((next: SetStateAction<T>) => {
    setParams((previous) => {
      const result = new URLSearchParams(previous);
      const current = (previous.get(key) || fallback) as T;
      const resolved = typeof next === "function" ? next(current) : next;
      if (resolved === fallback) result.delete(key);
      else result.set(key, resolved);
      return result;
    }, { replace: true });
  }, [key, fallback, setParams]);
  return [value, setValue] as const;
}

/** Responses from a previous selection must never replace the current screen. */
export function useRequestVersion() {
  const version = useRef(0);
  useEffect(() => () => { version.current += 1; }, []);
  return version;
}
