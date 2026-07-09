import type { HourlyPoint } from "../types";
import type { LevelTier } from "./airQuality";

// Riziko bouřek pro daný den. Kombinujeme WMO kódy (95/96/99 = bouřka,
// s krupobitím 96/99) s energií konvekce CAPE (J/kg) a pravděpodobností srážek.
// CAPE dává „potenciál" i tam, kde model bouřku přímo netrefil do hodiny.

export type StormLevel = "none" | "low" | "moderate" | "high";

export interface StormInfo {
  level: StormLevel;
  tier: LevelTier;
  label: string; // klíč pro tr()
  hail: boolean;
  from: string | null; // ISO první bouřkové hodiny
  to: string | null; // ISO poslední bouřkové hodiny
  maxCape: number; // 0 když chybí
}

const TSTORM = new Set([95, 96, 99]);
const HAIL = new Set([96, 99]);

export function stormRiskForDate(
  hourly: HourlyPoint[],
  date: string,
): StormInfo {
  const rows = hourly.filter((h) => h.time.slice(0, 10) === date);

  let from: string | null = null;
  let to: string | null = null;
  let hail = false;
  let maxProb = 0;
  let maxCape = 0;
  let stormHours = 0;

  for (const h of rows) {
    if (Number.isFinite(h.cape)) maxCape = Math.max(maxCape, h.cape);
    if (TSTORM.has(h.weatherCode)) {
      stormHours += 1;
      if (!from) from = h.time;
      to = h.time;
      if (HAIL.has(h.weatherCode)) hail = true;
      if (Number.isFinite(h.precipitationProbability))
        maxProb = Math.max(maxProb, h.precipitationProbability);
    }
  }

  let level: StormLevel = "none";
  if (stormHours > 0) {
    if (hail || maxProb >= 60 || stormHours >= 3) level = "high";
    else level = "moderate";
  } else if (maxCape >= 1500) {
    level = "low";
  }

  const tier: Record<StormLevel, LevelTier> = {
    none: "good",
    low: "moderate",
    moderate: "poor",
    high: "verypoor",
  };

  let label: string;
  if (level === "high") label = hail ? "Bouřky s krupobitím" : "Silné bouřky";
  else if (level === "moderate") label = "Bouřky pravděpodobné";
  else if (level === "low") label = "Bouřky možné";
  else label = "Bez bouřek";

  return { level, tier: tier[level], label, hail, from, to, maxCape };
}
