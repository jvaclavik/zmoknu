import type { LevelTier } from "./airQuality";

// Riziko povodní na základě modelu GloFAS (Open-Meteo Flood API) – denní průtok
// řek (river discharge, m³/s) pro nejbližší povodí. Absolutní m³/s samo o sobě
// nic neřekne, proto ho porovnáváme s historickým rozdělením průtoku v témže
// místě (percentily z posledních let) → z toho určíme, jak neobvyklý průtok je.

export interface FloodThresholds {
  p90: number;
  p95: number;
  p99: number;
  histMax: number;
}

export interface FloodData {
  byDate: Map<string, number>;
  thresholds: FloodThresholds;
  peakDate: string;
  peakValue: number;
}

export interface FloodRisk {
  tier: LevelTier;
  label: string;
  alert: boolean;
}

const HIST_YEARS = 5;
const cache = new Map<string, Promise<FloodData | null>>();

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function loadFlood(lat: number, lon: number): Promise<FloodData | null> {
  const base = "https://flood-api.open-meteo.com/v1/flood";
  const common = `latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&daily=river_discharge`;
  const forecastUrl = `${base}?${common}&forecast_days=30`;
  const histUrl = `${base}?${common}&start_date=${isoDaysAgo(HIST_YEARS * 365)}&end_date=${isoDaysAgo(1)}`;

  try {
    const [fRes, hRes] = await Promise.all([
      fetch(forecastUrl),
      fetch(histUrl),
    ]);
    if (!fRes.ok || !hRes.ok) return null;
    const fJson = await fRes.json();
    const hJson = await hRes.json();

    const times: string[] = fJson?.daily?.time ?? [];
    const values: (number | null)[] = fJson?.daily?.river_discharge ?? [];
    const byDate = new Map<string, number>();
    let peakDate = "";
    let peakValue = -Infinity;
    times.forEach((t, i) => {
      const v = values[i];
      if (typeof v === "number") {
        byDate.set(t, v);
        if (v > peakValue) {
          peakValue = v;
          peakDate = t;
        }
      }
    });
    if (byDate.size === 0) return null;

    const hist = (hJson?.daily?.river_discharge ?? [])
      .filter((v: number | null): v is number => typeof v === "number")
      .sort((a: number, b: number) => a - b);
    if (hist.length < 30) return null;

    const thresholds: FloodThresholds = {
      p90: quantile(hist, 0.9),
      p95: quantile(hist, 0.95),
      p99: quantile(hist, 0.99),
      histMax: hist[hist.length - 1],
    };

    return { byDate, thresholds, peakDate, peakValue };
  } catch {
    return null;
  }
}

export function fetchFlood(lat: number, lon: number): Promise<FloodData | null> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  let p = cache.get(key);
  if (!p) {
    p = loadFlood(lat, lon);
    cache.set(key, p);
  }
  return p;
}

// Zařazení průtoku do stupně rizika podle percentilů historického rozdělení.
export function floodRisk(q: number, t: FloodThresholds): FloodRisk {
  if (q >= t.p99)
    return { tier: "verypoor", label: "vysoké", alert: true };
  if (q >= t.p95) return { tier: "poor", label: "zvýšené", alert: true };
  if (q >= t.p90)
    return { tier: "moderate", label: "mírně zvýšené", alert: false };
  return { tier: "good", label: "normální", alert: false };
}
