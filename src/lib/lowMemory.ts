// iPhone / iPad Safari (a telefony s malou heaps) zabíjí tab, když radar
// najednou drží desítky WebGL textur + 2D canvas. Na iOS deviceMemory chybí.

export function isLowMemoryClient(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { deviceMemory?: number };
  if (
    typeof nav.deviceMemory === "number" &&
    nav.deviceMemory > 0 &&
    nav.deviceMemory <= 4
  ) {
    return true;
  }
  const ua = nav.userAgent || "";
  return (
    /iP(hone|od|ad)/.test(ua) ||
    (nav.platform === "MacIntel" && nav.maxTouchPoints > 1)
  );
}

export function mapPixelRatio(): number {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  if (isLowMemoryClient()) return Math.min(1.5, dpr);
  return dpr;
}
