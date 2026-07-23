import type { Forecast, GeoLocation } from "../types";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const REVERSE_URL = "https://api.bigdatacloud.net/data/reverse-geocode-client";

// Open-Meteo u některých modelů (např. ČHMÚ ALADIN bez dat pro danou lokalitu)
// vrací nevalidní JSON s literály „nan“/„Infinity“. Před parsováním je nahradíme
// za null, ať fetch nespadne a projeví se to jako chybějící data.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchOmJson<T>(
  url: string,
  errMsg: string,
  retries = 2,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        // 429 (rate limit) a 5xx jsou přechodné – při hlubší historii/více
        // požadavcích se občas objeví. Zkusíme to znovu s krátkou pauzou.
        const transient = res.status === 429 || res.status >= 500;
        if (transient && attempt < retries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        throw new Error(errMsg);
      }
      const text = await res.text();
      const clean = text
        .replace(/\bNaN\b/gi, "null")
        .replace(/-?Infinity/gi, "null");
      return JSON.parse(clean) as T;
    } catch (e) {
      lastErr = e;
      // Síťový výpadek (TypeError) je také přechodný → retry. Trvalé chyby
      // (např. 4xx přeložené na Error(errMsg)) rovnou propustíme dál.
      if (e instanceof TypeError && attempt < retries) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(errMsg);
}

interface RawForecast {
  timezone: string;
  utc_offset_seconds: number;
  current: Record<string, number | string>;
  hourly: Record<string, (number | string)[]>;
  daily: Record<string, (number | string)[]>;
  minutely_15?: Record<string, (number | string)[]>;
}

// Krátká cache předpovědí (klíč = místo+historie+model), ať je přepínání mezi
// oblíbenými okamžité (viz prefetchForecast) a opětovné otevření nestahuje znovu.
const forecastCache = new Map<string, { at: number; data: Forecast }>();
const FORECAST_TTL = 10 * 60 * 1000;
function fcKey(lat: number, lon: number, pastDays: number, model: string) {
  return `${lat.toFixed(3)},${lon.toFixed(3)},${pastDays},${model}`;
}

// Offline úložiště předpovědí (víc míst): oblíbená + posledních N navštívených.
// Na rozdíl od forecastCache (jen v paměti) přežije reload i restart prohlížeče
// a umožní přepínat mezi místy i bez sítě.
const OFFLINE_KEY = "zmoknu.offlineForecasts";
// Kolik nechat nefavoritních (naposledy navštívených) a favoritních záznamů.
const OFFLINE_RECENTS = 5;
const OFFLINE_FAVS = 8;

export interface SavedForecast {
  at: number;
  location: GeoLocation;
  pastDays: number;
  model: string;
  forecast: Forecast;
}

type OfflineStore = Record<string, SavedForecast>;

function offlineKey(lat: number, lon: number): string {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

export function loadOfflineStore(): OfflineStore {
  try {
    const raw = localStorage.getItem(OFFLINE_KEY);
    if (raw) return JSON.parse(raw) as OfflineStore;
  } catch {
    /* ignore */
  }
  return {};
}

// Zápis s ořezem podle priority (favority + nejnovější navštívená) a s fallbackem
// při překročení kvóty localStorage (postupně zahazujeme nejméně důležité).
function persistOfflineStore(store: OfflineStore, favKeys: Set<string>): void {
  const entries = Object.entries(store);
  const byAtDesc = (a: [string, SavedForecast], b: [string, SavedForecast]) =>
    b[1].at - a[1].at;
  const favs = entries.filter(([k]) => favKeys.has(k)).sort(byAtDesc);
  const rest = entries.filter(([k]) => !favKeys.has(k)).sort(byAtDesc);
  // Priorita: nejnovější favority, pak nejnovější navštívená (na konci = první
  // kandidáti na zahození při nedostatku místa).
  let keep = [...favs.slice(0, OFFLINE_FAVS), ...rest.slice(0, OFFLINE_RECENTS)];
  while (keep.length > 0) {
    try {
      localStorage.setItem(OFFLINE_KEY, JSON.stringify(Object.fromEntries(keep)));
      return;
    } catch {
      keep = keep.slice(0, -1); // odeber nejméně důležitý a zkus znovu
    }
  }
  try {
    localStorage.removeItem(OFFLINE_KEY);
  } catch {
    /* ignore */
  }
}

// Ulož předpověď pro dané místo do offline úložiště. `favorites` slouží k tomu,
// aby se při ořezu zachovaly předpovědi oblíbených míst.
export function saveOfflineForecast(
  location: GeoLocation,
  pastDays: number,
  model: string,
  forecast: Forecast,
  favorites: GeoLocation[] = [],
): void {
  const store = loadOfflineStore();
  store[offlineKey(location.latitude, location.longitude)] = {
    at: Date.now(),
    location,
    pastDays,
    model,
    forecast,
  };
  const favKeys = new Set(
    favorites.map((f) => offlineKey(f.latitude, f.longitude)),
  );
  persistOfflineStore(store, favKeys);
}

// Vrátí uloženou předpověď pro dané místo (nebo null).
export function getOfflineForecast(
  lat: number,
  lon: number,
): SavedForecast | null {
  return loadOfflineStore()[offlineKey(lat, lon)] ?? null;
}

// Přednačte předpověď do cache (pro oblíbená místa). Chyby ignoruje.
export function prefetchForecast(
  lat: number,
  lon: number,
  model = "best_match",
): void {
  const key = fcKey(lat, lon, 1, model);
  const c = forecastCache.get(key);
  if (c && Date.now() - c.at < FORECAST_TTL) return;
  fetchForecast(lat, lon, 1, model).catch(() => {});
}

export async function fetchForecast(
  lat: number,
  lon: number,
  pastDays = 1,
  model = "best_match",
  opts?: { force?: boolean },
): Promise<Forecast> {
  const cacheKey = fcKey(lat, lon, pastDays, model);
  if (!opts?.force) {
    const c = forecastCache.get(cacheKey);
    if (c && Date.now() - c.at < FORECAST_TTL) return c.data;
  }
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
      "cape",
      "uv_index",
      "uv_index_clear_sky",
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
    minutely_15: "precipitation",
    forecast_minutely_15: "48",
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

  const minutely15 = mapMinutely15(data.minutely_15);

  const result: Forecast = {
    timezone: data.timezone,
    minutely15,
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
  forecastCache.set(cacheKey, { at: Date.now(), data: result });
  return result;
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

// Chybějící (null) hodnota → NaN, ať se nezaměňuje s platnou 0. Number(null)
// je totiž 0, takže by se dny bez dat (např. ČHMÚ mimo horizont) tvářily jako
// „teplota 0 °C". NaN pak umožní čáru nekreslit a psát „?".
const num = (v: number | string | null | undefined): number =>
  v == null ? NaN : Number(v);

function mapHourly(h: RawForecast["hourly"]) {
  const out = [];
  for (let i = 0; i < h.time.length; i++) {
    out.push({
      time: String(h.time[i]),
      temperature: num(h.temperature_2m[i]),
      apparentTemperature: num(h.apparent_temperature[i]),
      precipitation: Number(h.precipitation[i]),
      precipitationProbability: Number(h.precipitation_probability[i]),
      weatherCode: num(h.weather_code[i]),
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
      cape: h.cape ? Number(h.cape[i]) : NaN,
      uvIndex: h.uv_index ? Number(h.uv_index[i]) : NaN,
      uvIndexClearSky: h.uv_index_clear_sky
        ? Number(h.uv_index_clear_sky[i])
        : NaN,
      isDay: Number(h.is_day[i]) === 1,
    });
  }
  return out;
}

function mapMinutely15(
  m: RawForecast["minutely_15"],
): { time: string[]; precipitation: number[] } | undefined {
  const time = m?.time as string[] | undefined;
  const precip = m?.precipitation as (number | string | null)[] | undefined;
  if (!time || !precip || !time.length) return undefined;
  return {
    time: time.map(String),
    precipitation: precip.map((v) => (v == null ? 0 : Number(v))),
  };
}

function mapDaily(d: RawForecast["daily"]) {
  const out = [];
  for (let i = 0; i < d.time.length; i++) {
    out.push({
      time: String(d.time[i]),
      weatherCode: num(d.weather_code[i]),
      tempMax: num(d.temperature_2m_max[i]),
      tempMin: num(d.temperature_2m_min[i]),
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

// Hledání místa. Primárně MapTiler geocoding (umí i ulice/adresy a čtvrti,
// např. „Šlikova 9 Praha“ nebo „Praha Břevnov“); když není klíč nebo nic
// nevrátí, spadneme na Open-Meteo (názvy měst/obcí).
export async function searchLocations(query: string): Promise<GeoLocation[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const key = import.meta.env.VITE_MAPTILER_KEY as string | undefined;
  if (key) {
    try {
      const res = await geocodeMapTiler(q, key);
      if (res.length) return res;
    } catch {
      /* spadneme na Open-Meteo */
    }
  }
  return geocodeOpenMeteo(q);
}

interface MapTilerFeature {
  text?: string;
  place_name?: string;
  center?: [number, number]; // [lon, lat]
}

async function geocodeMapTiler(
  query: string,
  key: string,
): Promise<GeoLocation[]> {
  const url =
    `https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json` +
    `?key=${key}&language=cs&limit=8`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Hledání lokace selhalo.");
  const data = (await res.json()) as { features?: MapTilerFeature[] };
  return (data.features ?? [])
    .map((f): GeoLocation | null => {
      if (!f.center || f.center.length < 2) return null;
      const [lon, lat] = f.center;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const full = f.place_name ?? f.text ?? "";
      // Zbytek adresy za první částí bereme jako popis (PSČ, obec, země).
      const rest = full
        .split(",")
        .slice(1)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(", ");
      return {
        name: f.text || full,
        latitude: lat,
        longitude: lon,
        admin1: rest || undefined,
      };
    })
    .filter((g): g is GeoLocation => g !== null);
}

async function geocodeOpenMeteo(query: string): Promise<GeoLocation[]> {
  const params = new URLSearchParams({
    name: query,
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
// Preferované úrovně názvu pro „moji polohu“ – od nejjemnější (čtvrť/část)
// po hrubší (obec, okres). Adresu s číslem popisným ani PSČ nechceme.
const REVERSE_PREF = [
  "neighbourhood",
  "suburb",
  "quarter",
  "place",
  "locality",
  "village",
  "town",
  "city",
  "municipality",
  "municipal_district",
  "subregion",
  "region",
];

async function reverseMapTiler(
  lat: number,
  lon: number,
  key: string,
): Promise<string | null> {
  const url =
    `https://api.maptiler.com/geocoding/${lon},${lat}.json` +
    `?key=${key}&language=cs`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    features?: { text?: string; place_type?: string[] }[];
  };
  let best: { text: string; rank: number } | null = null;
  for (const f of data.features ?? []) {
    const type = f.place_type?.[0];
    if (!type || !f.text) continue;
    const rank = REVERSE_PREF.indexOf(type);
    if (rank === -1) continue;
    if (!best || rank < best.rank) best = { text: f.text, rank };
  }
  return best?.text ?? null;
}

export async function reverseGeocode(
  lat: number,
  lon: number,
): Promise<string> {
  // Nejdřív MapTiler – umí čtvrti/části města (např. „Břevnov“ místo „Praha“).
  const key = import.meta.env.VITE_MAPTILER_KEY as string | undefined;
  if (key) {
    try {
      const name = await reverseMapTiler(lat, lon, key);
      if (name) return name;
    } catch {
      /* spadneme na BigDataCloud */
    }
  }
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
