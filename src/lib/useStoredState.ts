import { useCallback, useEffect, useRef, useState } from "react";

// Stejný klíč může číst víc instancí najednou (např. obal meteogramu a jeho
// tělo). Bez sběrnice by si každá držela vlastní React stav a změna v jedné
// by se v druhé projevila až po reloadu.
const bus = new EventTarget();

export function useStoredState<T>(
  key: string,
  initial: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) return JSON.parse(raw) as T;
    } catch {
      /* ignore */
    }
    return initial;
  });
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    const onStore = (e: Event) => {
      const d = (e as CustomEvent<{ key: string; value: unknown }>).detail;
      if (d.key !== key) return;
      valueRef.current = d.value as T;
      setValue(d.value as T);
    };
    bus.addEventListener("store", onStore);
    return () => bus.removeEventListener("store", onStore);
  }, [key]);

  const set = useCallback((next: T | ((prev: T) => T)) => {
    const resolved =
      typeof next === "function"
        ? (next as (prev: T) => T)(valueRef.current)
        : next;
    valueRef.current = resolved;
    setValue(resolved);
    try {
      localStorage.setItem(key, JSON.stringify(resolved));
    } catch {
      /* ignore */
    }
    bus.dispatchEvent(
      new CustomEvent("store", { detail: { key, value: resolved } }),
    );
  }, [key]);

  return [value, set];
}
