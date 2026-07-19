import type { HourlyPoint } from "../types";

// „Acme Labs" pro zmoknu: odhad kvality barev při východu/západu slunce a šance
// na duhu. Vše čistě z hodinových dat (oblačnost po patrech, srážky) – žádné
// další API. Jde o orientační heuristiku, ne o měření.

export type SkyKind = "sunrise" | "sunset";

export interface SkyQuality {
  kind: SkyKind;
  timeISO: string;
  score: number; // 0–100
  label: string; // mdlé / obyčejné / pěkné / parádní
  rainbow: number; // 0–1 šance na duhu kolem té doby
}

function gaussian(x: number, mu: number, sigma: number): number {
  const d = x - mu;
  return Math.exp(-(d * d) / (2 * sigma * sigma));
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// Průměr veličiny přes hodiny v okně ±windowH kolem cílového času.
function avgAround(
  hourly: HourlyPoint[],
  targetMs: number,
  windowH: number,
): { low: number; mid: number; high: number; precipProb: number } | null {
  let low = 0,
    mid = 0,
    high = 0,
    prob = 0,
    n = 0;
  for (const p of hourly) {
    const t = new Date(p.time).getTime();
    if (Math.abs(t - targetMs) <= windowH * 3_600_000) {
      low += p.cloudLow;
      mid += p.cloudMid;
      high += p.cloudHigh;
      prob += p.precipitationProbability;
      n++;
    }
  }
  if (!n) return null;
  return { low: low / n, mid: mid / n, high: high / n, precipProb: prob / n };
}

// Kvalita barev: potřebujeme mraky ve vyšších patrech (odrážejí barvy), ale
// čistý obzor (nízká oblačnost blízko obzoru barvy „ukousne"). Zataženo = mdlé.
function colorScore(low: number, mid: number, high: number): number {
  const aloft = Math.max(gaussian(high, 50, 26), 0.65 * gaussian(mid, 45, 26));
  const lowBlock = clamp01(low / 100);
  const clearSky = high < 12 && mid < 12 && low < 12;
  if (clearSky) return 45; // čistá obloha: hezké, ale bez dramatu
  const s = aloft * (1 - 0.85 * lowBlock);
  return Math.round(clamp01(s) * 100);
}

function qualityLabel(score: number): string {
  if (score < 35) return "mdlé";
  if (score < 55) return "obyčejné";
  if (score < 75) return "pěkné";
  return "parádní";
}

// Duha: potřeba přeháňky (srážky poblíž) + slunce nízko nad obzorem (což při
// východu/západu platí) svítící pod mraky → nízká oblačnost nesmí být souvislá.
function rainbowChance(low: number, precipProb: number): number {
  const showers = clamp01(precipProb / 100);
  const sunGetsThrough = 1 - clamp01((low - 55) / 45);
  return clamp01(showers * sunGetsThrough);
}

function evalEvent(
  hourly: HourlyPoint[],
  iso: string,
  kind: SkyKind,
): SkyQuality | null {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  const c = avgAround(hourly, ms, 1);
  if (!c) return null;
  const score = colorScore(c.low, c.mid, c.high);
  return {
    kind,
    timeISO: iso,
    score,
    label: qualityLabel(score),
    rainbow: rainbowChance(c.low, c.precipProb),
  };
}

export function skyQuality(
  hourly: HourlyPoint[],
  sunriseISO: string,
  sunsetISO: string,
): { sunrise: SkyQuality | null; sunset: SkyQuality | null } {
  return {
    sunrise: evalEvent(hourly, sunriseISO, "sunrise"),
    sunset: evalEvent(hourly, sunsetISO, "sunset"),
  };
}
