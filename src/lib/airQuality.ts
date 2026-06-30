const AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";

export interface PollenInfo {
  kind: "alder" | "birch" | "grass" | "ragweed";
  label: string;
  value: number; // zrnka/m³ (dnešní maximum)
}

export interface AirQuality {
  aqi: number; // European AQI (denní maximum)
  pm25: number; // denní průměr
  pm10: number; // denní průměr
  pollen: PollenInfo[]; // jen druhy s daty > 0 (denní maximum)
}

// Kvalita ovzduší po dnech, klíč = "YYYY-MM-DD".
export type AirByDate = Record<string, AirQuality>;

const POLLEN_LABELS: Record<PollenInfo["kind"], string> = {
  alder: "Olše",
  birch: "Bříza",
  grass: "Trávy",
  ragweed: "Ambrózie",
};

// Šestistupňová škála kvality (barvy sdílené v UI přes .lvl-{tier}).
export type LevelTier =
  | "good"
  | "fair"
  | "moderate"
  | "poor"
  | "verypoor"
  | "extreme";

const TIER_ORDER: LevelTier[] = [
  "good",
  "fair",
  "moderate",
  "poor",
  "verypoor",
  "extreme",
];

// Slovní popis evropského AQI (0–100+).
export function aqiLabel(aqi: number): { text: string; tier: LevelTier } {
  if (aqi <= 20) return { text: "Výborné", tier: "good" };
  if (aqi <= 40) return { text: "Dobré", tier: "fair" };
  if (aqi <= 60) return { text: "Zhoršené", tier: "moderate" };
  if (aqi <= 80) return { text: "Špatné", tier: "poor" };
  if (aqi <= 100) return { text: "Velmi špatné", tier: "verypoor" };
  return { text: "Extrémní", tier: "extreme" };
}

// Úroveň prachu podle horší z hodnot PM2.5 / PM10 (µg/m³) dle pásem EU AQI.
export function pmLevel(
  pm25: number,
  pm10: number,
): { text: string; tier: LevelTier } {
  const t25: LevelTier =
    pm25 <= 10
      ? "good"
      : pm25 <= 20
        ? "fair"
        : pm25 <= 25
          ? "moderate"
          : pm25 <= 50
            ? "poor"
            : pm25 <= 75
              ? "verypoor"
              : "extreme";
  const t10: LevelTier =
    pm10 <= 20
      ? "good"
      : pm10 <= 40
        ? "fair"
        : pm10 <= 50
          ? "moderate"
          : pm10 <= 100
            ? "poor"
            : pm10 <= 150
              ? "verypoor"
              : "extreme";
  const tier =
    TIER_ORDER[Math.max(TIER_ORDER.indexOf(t25), TIER_ORDER.indexOf(t10))];
  const LABEL: Record<LevelTier, string> = {
    good: "nízký",
    fair: "mírný",
    moderate: "zvýšený",
    poor: "vysoký",
    verypoor: "velmi vysoký",
    extreme: "extrémní",
  };
  return { text: LABEL[tier], tier };
}

// Slovní popis intenzity pylu (zrnka/m³) – orientačně dle obvyklých prahů.
export function pollenLevel(
  kind: PollenInfo["kind"],
  v: number,
): { text: string; tier: LevelTier } {
  // Trávy mají nižší prahy než stromy/ambrózie.
  const low = kind === "grass" ? 5 : 10;
  const mid = kind === "grass" ? 20 : 50;
  const high = kind === "grass" ? 50 : 100;
  if (v < low) return { text: "nízká", tier: "good" };
  if (v < mid) return { text: "střední", tier: "moderate" };
  if (v < high) return { text: "vysoká", tier: "poor" };
  return { text: "velmi vysoká", tier: "verypoor" };
}

const POLLEN_KINDS: PollenInfo["kind"][] = [
  "alder",
  "birch",
  "grass",
  "ragweed",
];

// Stáhne hodinovou předpověď kvality ovzduší a pylu a zagreguje ji po dnech
// (AQI a pyl = denní maximum, prach PM = denní průměr). Vrací mapu den → data.
export async function fetchAirQuality(
  lat: number,
  lon: number,
): Promise<AirByDate> {
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    hourly: [
      "european_aqi",
      "pm2_5",
      "pm10",
      "alder_pollen",
      "birch_pollen",
      "grass_pollen",
      "ragweed_pollen",
    ].join(","),
    timezone: "auto",
    forecast_days: "7",
    past_days: "1",
  });
  const res = await fetch(`${AIR_URL}?${params.toString()}`);
  if (!res.ok) return {};
  const d = (await res.json()) as {
    hourly?: Record<string, (number | null)[] | string[]>;
  };
  const times = (d.hourly?.time as string[]) ?? [];
  if (!times.length) return {};

  const num = (key: string) => (d.hourly?.[key] as (number | null)[]) ?? [];
  const aqiH = num("european_aqi");
  const pm25H = num("pm2_5");
  const pm10H = num("pm10");
  const pollenH: Record<string, (number | null)[]> = {};
  for (const k of POLLEN_KINDS) pollenH[k] = num(`${k}_pollen`);

  // Akumulace po dnech.
  type Acc = {
    aqi: number;
    pm25Sum: number;
    pm25N: number;
    pm10Sum: number;
    pm10N: number;
    pollen: Record<string, number>;
  };
  const byDate = new Map<string, Acc>();
  for (let i = 0; i < times.length; i++) {
    const date = times[i].slice(0, 10);
    let a = byDate.get(date);
    if (!a) {
      a = { aqi: 0, pm25Sum: 0, pm25N: 0, pm10Sum: 0, pm10N: 0, pollen: {} };
      byDate.set(date, a);
    }
    const aqi = aqiH[i];
    if (aqi != null) a.aqi = Math.max(a.aqi, Number(aqi));
    const pm25 = pm25H[i];
    if (pm25 != null) {
      a.pm25Sum += Number(pm25);
      a.pm25N++;
    }
    const pm10 = pm10H[i];
    if (pm10 != null) {
      a.pm10Sum += Number(pm10);
      a.pm10N++;
    }
    for (const k of POLLEN_KINDS) {
      const v = pollenH[k][i];
      if (v != null) a.pollen[k] = Math.max(a.pollen[k] ?? 0, Number(v));
    }
  }

  const out: AirByDate = {};
  for (const [date, a] of byDate) {
    const pollen: PollenInfo[] = [];
    for (const k of POLLEN_KINDS) {
      const v = a.pollen[k] ?? 0;
      if (v > 0) {
        pollen.push({ kind: k, label: POLLEN_LABELS[k], value: Math.round(v) });
      }
    }
    out[date] = {
      aqi: Math.round(a.aqi),
      pm25: a.pm25N ? Math.round((a.pm25Sum / a.pm25N) * 10) / 10 : 0,
      pm10: a.pm10N ? Math.round((a.pm10Sum / a.pm10N) * 10) / 10 : 0,
      pollen,
    };
  }
  return out;
}
