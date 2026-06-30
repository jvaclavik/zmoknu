import type { Forecast, GeoLocation } from "../types";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const REVERSE_URL = "https://api.bigdatacloud.net/data/reverse-geocode-client";

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

  const res = await fetch(`${FORECAST_URL}?${params.toString()}`);
  if (!res.ok) throw new Error("Nepodařilo se načíst předpověď.");
  const data = (await res.json()) as RawForecast;

  const c = data.current;
  const hourly = mapHourly(data.hourly);
  // S past_days=1 obsahuje denní pole i včerejšek – necháme ho,
  // aby šlo přepnout i na „Včera“ (denní přehled si dnešek ořízne sám).
  const daily = mapDaily(data.daily);

  // Úhrny srážek (mm) bereme z hodinových modelů s vysokým rozlišením:
  // ICON-D2 (~2 km, ~2 dny, střední Evropa) → ICON-EU (~7 km, ~5 dní) →
  // ECMWF (po 3 h, ale až 16 dní) jako fallback pro vzdálenější dny.
  // best_match (pro ČR ICON) u konvektivních dnů nadhání, proto ho nepoužíváme.
  // Ostatní hodnoty (pravděpodobnost, teploty, oblačnost, UV) jsou z best_match.
  try {
    await applyHourlyPrecip(lat, lon, pastDays, hourly, daily);
  } catch {
    // Když přepis selže, ponecháme úhrny z best_match.
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
  const res = await fetch(`${FORECAST_URL}?${params.toString()}`);
  if (!res.ok) return;
  const d = (await res.json()) as {
    hourly?: Record<string, (number | null)[] | string[] | undefined> & {
      time?: string[];
    };
    daily?: Record<string, (number | null)[] | string[] | undefined> & {
      time?: string[];
    };
  };

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
