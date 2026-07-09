import type { Forecast, GeoLocation } from "../types";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const REVERSE_URL = "https://api.bigdatacloud.net/data/reverse-geocode-client";

// Open-Meteo u některých modelů (např. ČHMÚ ALADIN bez dat pro danou lokalitu)
// vrací nevalidní JSON s literály „nan“/„Infinity“. Před parsováním je nahradíme
// za null, ať fetch nespadne a projeví se to jako chybějící data.
async function fetchOmJson<T>(url: string, errMsg: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(errMsg);
  const text = await res.text();
  const clean = text.replace(/\bNaN\b/gi, "null").replace(/-?Infinity/gi, "null");
  return JSON.parse(clean) as T;
}

interface RawForecast {
  timezone: string;
  utc_offset_seconds: number;
  current: Record<string, number | string>;
  hourly: Record<string, (number | string)[]>;
  daily: Record<string, (number | string)[]>;
}

export async function fetchForecast(
  lat: number,
  lon: number,
  pastDays = 1,
  model = "best_match",
): Promise<Forecast> {
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    current: [
      "temperature_2m",
      "relative_humidity_2m",
      "apparent_temperature",
      "is_day",
      "precipitation",
      "weather_code",
      "wind_speed_10m",
      "wind_direction_10m",
      "wind_gusts_10m",
      "pressure_msl",
      "cloud_cover",
    ].join(","),
    hourly: [
      "temperature_2m",
      "apparent_temperature",
      "precipitation",
      "precipitation_probability",
      "weather_code",
      "wind_speed_10m",
      "wind_gusts_10m",
      "wind_direction_10m",
      "relative_humidity_2m",
      "dew_point_2m",
      "surface_pressure",
      "cloud_cover",
      "cloud_cover_low",
      "cloud_cover_mid",
      "cloud_cover_high",
      "is_day",
    ].join(","),
    daily: [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "precipitation_probability_max",
      "wind_speed_10m_max",
      "wind_gusts_10m_max",
      "sunrise",
      "sunset",
      "uv_index_max",
    ].join(","),
    timezone: "auto",
    forecast_days: "16",
    past_days: String(Math.min(92, Math.max(1, pastDays))),
    wind_speed_unit: "ms",
  });

  // Zvolený konkrétní model se pošle jako models=… (jeden model → proměnné
  // zůstávají bez přípony, takže mapování níže funguje beze změny).
  const useModel = model && model !== "best_match";
  if (useModel) params.set("models", model);

  const data = await fetchOmJson<RawForecast>(
    `${FORECAST_URL}?${params.toString()}`,
    "Nepodařilo se načíst předpověď.",
  );

  const c = data.current;
  const hourly = mapHourly(data.hourly);

  // Zvolený model nemusí mít pro danou lokalitu/čas data (např. ČHMÚ ALADIN
  // pokrývá jen ČR a má krátké rolling okno, občas i výpadek → samé null).
  // POZOR: Number(null) === 0 (je „finite"), takže nelze kontrolovat mapovaná
  // data – null hodnoty by prošly jako nuly. Kontrolujeme proto surové pole.
  if (useModel) {
    const rawTemps = (data.hourly?.temperature_2m ?? []) as (
      | number
      | string
      | null
    )[];
    const hasData = rawTemps.some(
      (v) => v != null && Number.isFinite(Number(v)),
    );
    if (!hasData) {
      throw new Error(
        "Zvolený model nemá pro tuto lokalitu aktuálně data. Zkuste jiný model (např. Automaticky).",
      );
    }
  }
  // S past_days=1 obsahuje denní pole i včerejšek – necháme ho,
  // aby šlo přepnout i na „Včera“ (denní přehled si dnešek ořízne sám).
  const daily = mapDaily(data.daily);

  // Úhrny srážek (mm) bereme z hodinových modelů s vysokým rozlišením:
  // ICON-D2 (~2 km, ~2 dny, střední Evropa) → ICON-EU (~7 km, ~5 dní) →
  // ECMWF (po 3 h, ale až 16 dní) jako fallback pro vzdálenější dny.
  // best_match (pro ČR ICON) u konvektivních dnů nadhání, proto ho nepoužíváme.
  // Ostatní hodnoty (pravděpodobnost, teploty, oblačnost, UV) jsou z best_match.
  // Při ručně zvoleném modelu ale respektujeme jeho vlastní srážky (nepřepisujeme).
  if (!useModel) {
    try {
      await applyHourlyPrecip(lat, lon, pastDays, hourly, daily);
    } catch {
      // Když přepis selže, ponecháme úhrny z best_match.
    }
  }

  return {
    timezone: data.timezone,
    current: {
      time: String(c.time),
      temperature: Number(c.temperature_2m),
      apparentTemperature: Number(c.apparent_temperature),
      isDay: Number(c.is_day) === 1,
      precipitation: Number(c.precipitation),
      weatherCode: Number(c.weather_code),
      windSpeed: Number(c.wind_speed_10m),
      windDirection: Number(c.wind_direction_10m),
      windGusts: Number(c.wind_gusts_10m),
      humidity: Number(c.relative_humidity_2m),
      pressure: Number(c.pressure_msl),
      cloudCover: Number(c.cloud_cover),
    },
    hourly,
    daily,
  };
}

// Pořadí preference modelů pro úhrny srážek (od nejdetailnějšího hodinového).
const PRECIP_MODELS = ["icon_d2", "icon_eu", "ecmwf_ifs025"] as const;

// Vybere první ne-null hodnotu pro daný index podle pořadí PRECIP_MODELS.
function pickByPriority(
  src: Record<string, (number | null)[] | undefined>,
  suffix: string,
  i: number,
): number | null {
  for (const m of PRECIP_MODELS) {
    const arr = src[`${suffix}_${m}`];
    const v = arr?.[i];
    if (v != null && !Number.isNaN(Number(v))) return Number(v);
  }
  return null;
}

// Přepíše hodinové i denní úhrny srážek hodnotami z hodinových modelů
// (ICON-D2 → ICON-EU → ECMWF). Vše stáhneme jedním requestem (více modelů),
// Open-Meteo přidá k názvům proměnných příponu modelu. Co žádný model nemá,
// zůstane z best_match.
async function applyHourlyPrecip(
  lat: number,
  lon: number,
  pastDays: number,
  hourly: ReturnType<typeof mapHourly>,
  daily: ReturnType<typeof mapDaily>,
): Promise<void> {
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    hourly: "precipitation",
    daily: "precipitation_sum",
    timezone: "auto",
    forecast_days: "16",
    past_days: String(Math.min(92, Math.max(1, pastDays))),
    models: PRECIP_MODELS.join(","),
  });
  let d: {
    hourly?: Record<string, (number | null)[] | string[] | undefined> & {
      time?: string[];
    };
    daily?: Record<string, (number | null)[] | string[] | undefined> & {
      time?: string[];
    };
  };
  try {
    d = await fetchOmJson(`${FORECAST_URL}?${params.toString()}`, "precip");
  } catch {
    return;
  }

  const hTimes = (d.hourly?.time as string[]) ?? [];
  const hSrc = (d.hourly ?? {}) as Record<string, (number | null)[]>;
  const hMap = new Map<string, number>();
  for (let i = 0; i < hTimes.length; i++) {
    const v = pickByPriority(hSrc, "precipitation", i);
    if (v != null) hMap.set(hTimes[i], v);
  }
  for (const p of hourly) {
    const v = hMap.get(p.time);
    if (v != null) p.precipitation = v;
  }

  const dTimes = (d.daily?.time as string[]) ?? [];
  const dSrc = (d.daily ?? {}) as Record<string, (number | null)[]>;
  const dMap = new Map<string, number>();
  for (let i = 0; i < dTimes.length; i++) {
    const v = pickByPriority(dSrc, "precipitation_sum", i);
    if (v != null) dMap.set(dTimes[i], v);
  }
  for (const day of daily) {
    const v = dMap.get(day.time);
    if (v != null) day.precipitationSum = v;
  }
}

// Hodinová data jedné veličiny z více modelů najednou (pro multimód
// v meteogramu). Vrací pro každý model mapu čas → hodnota.
export interface ModelSeries {
  model: string;
  byTime: Map<string, number>;
}

export async function fetchModelSeries(
  lat: number,
  lon: number,
  hourlyVar: string,
  models: string[],
  pastDays = 1,
): Promise<ModelSeries[]> {
  if (!models.length) return [];
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    hourly: hourlyVar,
    timezone: "auto",
    forecast_days: "16",
    past_days: String(Math.min(92, Math.max(1, pastDays))),
    wind_speed_unit: "ms",
    models: models.join(","),
  });
  const data = await fetchOmJson<{
    hourly?: Record<string, (number | null)[] | string[] | undefined> & {
      time?: string[];
    };
  }>(`${FORECAST_URL}?${params.toString()}`, "Nepodařilo se načíst modely.");
  const times = (data.hourly?.time as string[]) ?? [];
  const src = (data.hourly ?? {}) as Record<string, (number | null)[]>;

  return models.map((m) => {
    const byTime = new Map<string, number>();
    // Při jednom modelu Open-Meteo příponu nepřidá; při více ano.
    const arr =
      (src[`${hourlyVar}_${m}`] as (number | null)[] | undefined) ??
      (models.length === 1 ? (src[hourlyVar] as (number | null)[]) : undefined);
    if (arr) {
      for (let i = 0; i < times.length; i++) {
        const v = arr[i];
        if (v != null && !Number.isNaN(Number(v))) byTime.set(times[i], Number(v));
      }
    }
    return { model: m, byTime };
  });
}

function mapHourly(h: RawForecast["hourly"]) {
  const out = [];
  for (let i = 0; i < h.time.length; i++) {
    out.push({
      time: String(h.time[i]),
      temperature: Number(h.temperature_2m[i]),
      apparentTemperature: Number(h.apparent_temperature[i]),
      precipitation: Number(h.precipitation[i]),
      precipitationProbability: Number(h.precipitation_probability[i]),
      weatherCode: Number(h.weather_code[i]),
      windSpeed: Number(h.wind_speed_10m[i]),
      windGusts: Number(h.wind_gusts_10m[i]),
      windDirection: Number(h.wind_direction_10m[i]),
      humidity: Number(h.relative_humidity_2m[i]),
      dewPoint: Number(h.dew_point_2m[i]),
      pressure: Number(h.surface_pressure[i]),
      cloudCover: Number(h.cloud_cover[i]),
      cloudLow: Number(h.cloud_cover_low[i]),
      cloudMid: Number(h.cloud_cover_mid[i]),
      cloudHigh: Number(h.cloud_cover_high[i]),
      isDay: Number(h.is_day[i]) === 1,
    });
  }
  return out;
}

function mapDaily(d: RawForecast["daily"]) {
  const out = [];
  for (let i = 0; i < d.time.length; i++) {
    out.push({
      time: String(d.time[i]),
      weatherCode: Number(d.weather_code[i]),
      tempMax: Number(d.temperature_2m_max[i]),
      tempMin: Number(d.temperature_2m_min[i]),
      precipitationSum: Number(d.precipitation_sum[i]),
      precipitationProbabilityMax: Number(d.precipitation_probability_max[i]),
      windSpeedMax: Number(d.wind_speed_10m_max[i]),
      windGustsMax: Number(d.wind_gusts_10m_max[i]),
      sunrise: String(d.sunrise[i]),
      sunset: String(d.sunset[i]),
      uvIndexMax: Number(d.uv_index_max[i]),
    });
  }
  return out;
}

interface RawGeo {
  results?: {
    id: number;
    name: string;
    latitude: number;
    longitude: number;
    country?: string;
    admin1?: string;
  }[];
}

export async function searchLocations(query: string): Promise<GeoLocation[]> {
  if (query.trim().length < 2) return [];
  const params = new URLSearchParams({
    name: query.trim(),
    count: "8",
    language: "cs",
    format: "json",
  });
  const res = await fetch(`${GEOCODE_URL}?${params.toString()}`);
  if (!res.ok) throw new Error("Hledání lokace selhalo.");
  const data = (await res.json()) as RawGeo;
  return (data.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    country: r.country,
    admin1: r.admin1,
  }));
}

// ---- Klimatologický normál (historický průměr) ----------------------------
// Denní index v roce (0–364), nepřestupný; 29. 2. sloučíme do 28. 2.
const CUM_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
export function normalDoy(iso: string): number {
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  if (m === 2 && d === 29) return 58; // 28. 2.
  const idx = CUM_DAYS[m - 1] + (d - 1);
  return Math.max(0, Math.min(364, idx));
}

// Průměrná teplota (a min/max) pro každý den v roce z reanalýzy ERA5.
export interface ClimateNormals {
  mean: (number | null)[]; // délka 365, °C
  max: (number | null)[];
  min: (number | null)[];
}

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const NORMAL_START = "1995-01-01";
const NORMAL_END = "2024-12-31";
const normalsCache = new Map<string, Promise<ClimateNormals>>();

// Kruhové vyhlazení průměrů oknem ±win dní (klimatologie bývá po dnech zašuměná).
function smoothCircular(arr: (number | null)[], win: number): (number | null)[] {
  const n = arr.length;
  return arr.map((_, i) => {
    let sum = 0;
    let cnt = 0;
    for (let k = -win; k <= win; k++) {
      const v = arr[(i + k + n) % n];
      if (v != null && Number.isFinite(v)) {
        sum += v;
        cnt++;
      }
    }
    return cnt ? sum / cnt : null;
  });
}

export function fetchClimateNormals(
  lat: number,
  lon: number,
): Promise<ClimateNormals> {
  // Zaokrouhlíme na ~0,25°, ať sdílíme cache i mezi blízkými body.
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = normalsCache.get(key);
  if (cached) return cached;

  const p = (async (): Promise<ClimateNormals> => {
    const params = new URLSearchParams({
      latitude: lat.toString(),
      longitude: lon.toString(),
      start_date: NORMAL_START,
      end_date: NORMAL_END,
      daily: "temperature_2m_mean,temperature_2m_max,temperature_2m_min",
      timezone: "auto",
    });
    const data = await fetchOmJson<{
      daily?: {
        time?: string[];
        temperature_2m_mean?: (number | null)[];
        temperature_2m_max?: (number | null)[];
        temperature_2m_min?: (number | null)[];
      };
    }>(`${ARCHIVE_URL}?${params.toString()}`, "Nepodařilo se načíst normál.");

    const time = data.daily?.time ?? [];
    const src = {
      mean: data.daily?.temperature_2m_mean ?? [],
      max: data.daily?.temperature_2m_max ?? [],
      min: data.daily?.temperature_2m_min ?? [],
    };

    const build = (values: (number | null)[]): (number | null)[] => {
      const sum = new Array(365).fill(0);
      const cnt = new Array(365).fill(0);
      for (let i = 0; i < time.length; i++) {
        const v = values[i];
        if (v == null || !Number.isFinite(v)) continue;
        const doy = normalDoy(time[i]);
        sum[doy] += v;
        cnt[doy] += 1;
      }
      const out = sum.map((s, i) => (cnt[i] ? s / cnt[i] : null));
      return smoothCircular(out, 7);
    };

    return { mean: build(src.mean), max: build(src.max), min: build(src.min) };
  })();

  normalsCache.set(key, p);
  p.catch(() => normalsCache.delete(key)); // ať jde po chybě zkusit znovu
  return p;
}

// Reverzní geokódování pro pojmenování polohy z GPS.
export async function reverseGeocode(
  lat: number,
  lon: number,
): Promise<string> {
  try {
    const params = new URLSearchParams({
      latitude: lat.toString(),
      longitude: lon.toString(),
      localityLanguage: "cs",
    });
    const res = await fetch(`${REVERSE_URL}?${params.toString()}`);
    if (!res.ok) throw new Error();
    const data = (await res.json()) as {
      city?: string;
      locality?: string;
      principalSubdivision?: string;
    };
    return data.city || data.locality || data.principalSubdivision || "Moje poloha";
  } catch {
    return "Moje poloha";
  }
}
