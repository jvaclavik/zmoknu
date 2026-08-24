import type { HourlyPoint } from "../types";
import type { AirQuality, LevelTier } from "./airQuality";
import { pollenLevel } from "./airQuality";

// Biometeorologická zátěž podle modelu ČHMÚ BMP IIIc (index biotropie).
// https://www.chmi.cz/predpoved-pocasi/bio-predpoved/vice-informaci-o-biopredpovedi-a-modelu
// Oficiální BMP je regionální (7 oblastí ČR + synoptika meteorologů); zde
// aplikujeme stejná pravidla a bodování na hodinovou předpověď pro místo.

export type BioLoad = "mild" | "moderate" | "high";

export interface BioFactor {
  id: string;
  group: string;
  points: number;
  label: string;
}

export type ThermalKind =
  | "none"
  | "cold"
  | "frost"
  | "heat"
  | "strong_heat";

export interface BioForecast {
  points: number;
  load: BioLoad;
  tier: LevelTier;
  label: string;
  factors: BioFactor[];
  region: number | null;
  thermal: {
    kind: ThermalKind;
    tier: LevelTier;
    label: string;
    note: string;
  };
  pollenNote: { label: string; level: string; tier: LevelTier } | null;
}

const TSTORM = new Set([95, 96, 99]);
const SO2_LIMIT = 350; // µg/m³ – limit skupiny E-a
const INVERSION_MIN_H = 18;
const INVERSION_DELTA = 1.5; // °C (T850 − T2m)

const BIO_REGIONS: { id: number; lat: number; lon: number }[] = [
  { id: 1, lat: 50.45, lon: 13.2 },
  { id: 2, lat: 49.05, lon: 14.1 },
  { id: 3, lat: 50.05, lon: 14.4 },
  { id: 4, lat: 50.55, lon: 15.5 },
  { id: 5, lat: 49.55, lon: 15.9 },
  { id: 6, lat: 49.2, lon: 16.65 },
  { id: 7, lat: 49.85, lon: 17.85 },
];

function loadFromPoints(points: number): {
  load: BioLoad;
  tier: LevelTier;
  label: string;
} {
  if (points >= 6)
    return { load: "high", tier: "verypoor", label: "vysoká zátěž" };
  if (points >= 3)
    return { load: "moderate", tier: "moderate", label: "střední zátěž" };
  return { load: "mild", tier: "good", label: "mírná zátěž" };
}

export function chmiBioRegion(lat: number, lon: number): number | null {
  if (lat < 48.55 || lat > 51.06 || lon < 12.09 || lon > 18.88) return null;
  let best = BIO_REGIONS[0];
  let bestD = Infinity;
  for (const r of BIO_REGIONS) {
    const d = (lat - r.lat) ** 2 + (lon - r.lon) ** 2;
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best.id;
}

function hoursOnDate(hourly: HourlyPoint[], date: string): HourlyPoint[] {
  return hourly.filter((h) => h.time.slice(0, 10) === date);
}

function hoursWindow(hourly: HourlyPoint[], date: string): HourlyPoint[] {
  const pad = 12 * 3_600_000;
  const start = new Date(`${date}T00:00:00`).getTime() - pad;
  const end = new Date(`${date}T23:59:59`).getTime() + pad;
  return hourly.filter((h) => {
    const t = new Date(h.time).getTime();
    return t >= start && t <= end;
  });
}

function windDirDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function maxPressureDrop12h(rows: HourlyPoint[]): number {
  let max = 0;
  for (let i = 0; i < rows.length; i++) {
    const p0 = rows[i].pressure;
    if (!Number.isFinite(p0)) continue;
    const t0 = new Date(rows[i].time).getTime();
    for (let j = i + 1; j < rows.length; j++) {
      const dt = (new Date(rows[j].time).getTime() - t0) / 3_600_000;
      if (dt > 12) break;
      const p1 = rows[j].pressure;
      if (!Number.isFinite(p1)) continue;
      max = Math.max(max, p0 - p1);
    }
  }
  return max;
}

function maxTempRise12h850(rows: HourlyPoint[]): number {
  let max = 0;
  for (let i = 0; i < rows.length; i++) {
    const t0 = rows[i].temperature850 ?? NaN;
    if (!Number.isFinite(t0)) continue;
    const ts0 = new Date(rows[i].time).getTime();
    for (let j = i + 1; j < rows.length; j++) {
      const dt = (new Date(rows[j].time).getTime() - ts0) / 3_600_000;
      if (dt > 12) break;
      const t1 = rows[j].temperature850 ?? NaN;
      if (!Number.isFinite(t1)) continue;
      max = Math.max(max, t1 - t0);
    }
  }
  return max;
}

function detectFrontPassage(rows: HourlyPoint[]): boolean {
  for (let i = 0; i < rows.length; i++) {
    const t0 = new Date(rows[i].time).getTime();
    for (let j = i + 1; j < rows.length; j++) {
      const dt = (new Date(rows[j].time).getTime() - t0) / 3_600_000;
      if (dt > 12) break;
      const p0 = rows[i].pressure;
      const p1 = rows[j].pressure;
      const temp0 = rows[i].temperature;
      const temp1 = rows[j].temperature;
      if (
        !Number.isFinite(p0) ||
        !Number.isFinite(p1) ||
        !Number.isFinite(temp0) ||
        !Number.isFinite(temp1)
      )
        continue;
      const wdd = windDirDelta(rows[i].windDirection, rows[j].windDirection);
      const dp = Math.abs(p0 - p1);
      const dtemp = Math.abs(temp1 - temp0);
      if (wdd >= 90 && dp >= 4 && dtemp >= 4) return true;
    }
  }
  return false;
}

function maxInversionHours(rows: HourlyPoint[]): number {
  let streak = 0;
  let max = 0;
  for (const h of rows) {
    const t2 = h.temperature;
    const t850 = h.temperature850 ?? NaN;
    if (
      Number.isFinite(t2) &&
      Number.isFinite(t850) &&
      t850 - t2 >= INVERSION_DELTA
    ) {
      streak++;
      max = Math.max(max, streak);
    } else {
      streak = 0;
    }
  }
  return max;
}

function thermalFromDay(
  tempMax: number,
  tempMin: number,
): BioForecast["thermal"] {
  if (Number.isFinite(tempMax) && tempMax >= 33) {
    return {
      kind: "strong_heat",
      tier: "verypoor",
      label: "silné vedro",
      note: "Skupina B5 modelu BMP – vysoká tepelná zátěž.",
    };
  }
  if (Number.isFinite(tempMax) && tempMax >= 29) {
    return {
      kind: "heat",
      tier: "poor",
      label: "vedro",
      note: "Skupina B4 modelu BMP – zvýšená tepelná zátěž.",
    };
  }
  if (Number.isFinite(tempMin) && tempMin <= -11) {
    return {
      kind: "frost",
      tier: "verypoor",
      label: "silný mráz",
      note: "Skupina B1-d modelu BMP.",
    };
  }
  if (Number.isFinite(tempMin) && tempMin < 0) {
    return {
      kind: "cold",
      tier: "moderate",
      label: "chladno až mráz",
      note: "Chladné podmínky – skupiny B2/B3 modelu BMP.",
    };
  }
  return {
    kind: "none",
    tier: "good",
    label: "bez výrazné tepelné zátěže",
    note: "Teplotní kritéria BMP nejsou splněna.",
  };
}

function addFactor(
  factors: BioFactor[],
  seen: Set<string>,
  factor: BioFactor,
): void {
  if (seen.has(factor.id)) return;
  seen.add(factor.id);
  factors.push(factor);
}

export function bioForecastForDate(
  hourly: HourlyPoint[],
  date: string,
  air?: AirQuality | null,
  lat?: number,
  lon?: number,
): BioForecast {
  const rows = hoursOnDate(hourly, date);
  const window = hoursWindow(hourly, date);
  const factors: BioFactor[] = [];
  const seen = new Set<string>();
  const region =
    lat != null && lon != null ? chmiBioRegion(lat, lon) : null;

  if (!rows.length) {
    const empty = loadFromPoints(0);
    return {
      points: 0,
      ...empty,
      factors: [],
      region,
      thermal: thermalFromDay(NaN, NaN),
      pollenNote: null,
    };
  }

  const temps = rows
    .map((h) => h.temperature)
    .filter((v) => Number.isFinite(v));
  const hums = rows.map((h) => h.humidity).filter((v) => Number.isFinite(v));
  const gusts = rows.map((h) => h.windGusts).filter((v) => Number.isFinite(v));

  const tempMax = temps.length ? Math.max(...temps) : NaN;
  const tempMin = temps.length ? Math.min(...temps) : NaN;
  const tempAvg = temps.length
    ? temps.reduce((s, v) => s + v, 0) / temps.length
    : NaN;
  const humMin = hums.length ? Math.min(...hums) : NaN;
  const humMax = hums.length ? Math.max(...hums) : NaN;
  const gustMax = gusts.length ? Math.max(...gusts) : 0;

  // Skupina A
  if (detectFrontPassage(window)) {
    addFactor(factors, seen, {
      id: "A-a",
      group: "A",
      points: 2,
      label: "Výměna vzduchové hmoty (fronta)",
    });
  }
  if (maxPressureDrop12h(window) >= 10) {
    addFactor(factors, seen, {
      id: "A-b",
      group: "A",
      points: 2,
      label: "Pokles tlaku ≥ 10 hPa / 12 h",
    });
  }

  // Skupina B1
  if (
    Number.isFinite(tempMax) &&
    Number.isFinite(tempMin) &&
    tempMax - tempMin >= 24
  ) {
    addFactor(factors, seen, {
      id: "B1-a",
      group: "B1",
      points: 1,
      label: "Teplotní amplituda ≥ 24 °C",
    });
  }
  if (Number.isFinite(humMin) && humMin <= 20) {
    addFactor(factors, seen, {
      id: "B1-b",
      group: "B1",
      points: 1,
      label: "Min. relativní vlhkost ≤ 20 %",
    });
  }
  if (Number.isFinite(humMax) && humMax <= 50) {
    addFactor(factors, seen, {
      id: "B1-c",
      group: "B1",
      points: 1,
      label: "Max. relativní vlhkost ≤ 50 %",
    });
  }
  if (Number.isFinite(tempMin) && tempMin <= -11) {
    addFactor(factors, seen, {
      id: "B1-d",
      group: "B1",
      points: 1,
      label: "Min. teplota ≤ −11 °C",
    });
  }
  if (maxTempRise12h850(window) >= 5) {
    addFactor(factors, seen, {
      id: "B1-e",
      group: "B1",
      points: 1,
      label: "Vzestup teploty v 850 hPa ≥ 5 °C / 12 h",
    });
  }

  // Skupiny B2–B5
  if (Number.isFinite(tempAvg) && tempAvg <= 13 && Number.isFinite(tempMin)) {
    if (tempMin < 0) {
      addFactor(factors, seen, {
        id: "B2-a",
        group: "B2",
        points: 3,
        label: "Chladný den s mrazem (ØT ≤ 13 °C, Tmin < 0 °C)",
      });
    } else {
      addFactor(factors, seen, {
        id: "B3-a",
        group: "B3",
        points: 2,
        label: "Chladný den bez mrazu (ØT ≤ 13 °C, Tmin ≥ 0 °C)",
      });
    }
  }
  if (Number.isFinite(tempMax) && tempMax >= 29) {
    addFactor(factors, seen, {
      id: "B4-a",
      group: "B4",
      points: 4,
      label: "Vedro (Tmax ≥ 29 °C)",
    });
  }
  if (Number.isFinite(tempMax) && tempMax >= 33) {
    addFactor(factors, seen, {
      id: "B5-a",
      group: "B5",
      points: 6,
      label: "Silné vedro (Tmax ≥ 33 °C)",
    });
  }

  // Skupina C
  if (rows.some((h) => TSTORM.has(h.weatherCode))) {
    addFactor(factors, seen, {
      id: "C-a",
      group: "C",
      points: 1,
      label: "Bouřky",
    });
  }
  if (gustMax >= 25) {
    addFactor(factors, seen, {
      id: "C-b",
      group: "C",
      points: 1,
      label: "Nárazy větru ≥ 25 m/s",
    });
  }

  // Skupina E
  if (air && Number.isFinite(air.so2Max) && air.so2Max >= SO2_LIMIT) {
    addFactor(factors, seen, {
      id: "E-a",
      group: "E",
      points: 1,
      label: "Překročení limitu SO₂ (350 µg/m³)",
    });
  }
  if (maxInversionHours(window) >= INVERSION_MIN_H) {
    addFactor(factors, seen, {
      id: "E-b",
      group: "E",
      points: 3,
      label: "Teplotní inverze ≥ 18 h",
    });
  }

  const points = factors.reduce((s, f) => s + f.points, 0);
  const { load, tier, label } = loadFromPoints(points);
  const thermal = thermalFromDay(tempMax, tempMin);

  let pollenNote: BioForecast["pollenNote"] = null;
  if (air?.pollen?.length) {
    let worst: BioForecast["pollenNote"] = null;
    const order: LevelTier[] = [
      "good",
      "fair",
      "moderate",
      "poor",
      "verypoor",
      "extreme",
    ];
    for (const p of air.pollen) {
      const lvl = pollenLevel(p.kind, p.value);
      if (
        !worst ||
        order.indexOf(lvl.tier) > order.indexOf(worst.tier)
      ) {
        worst = { label: p.label, level: lvl.text, tier: lvl.tier };
      }
    }
    if (worst && worst.tier !== "good" && worst.tier !== "fair") {
      pollenNote = worst;
    }
  }

  return {
    points,
    load,
    tier,
    label,
    factors: factors.sort((a, b) => b.points - a.points),
    region,
    thermal,
    pollenNote,
  };
}
