import type { DailyPoint, HourlyPoint } from "../types";
import { describeWeather } from "./weatherCodes";
import { getLang } from "./i18n";

// Přehledná věta o počasí vybraného dne, složená z dat (bez API). Cíl: na první
// pohled vědět, co čekat — obloha + teploty, časování srážek, výrazný vítr/jevy.

type PartKey = "morning" | "afternoon" | "evening" | "night";

const PART_ORDER: PartKey[] = ["night", "morning", "afternoon", "evening"];

function partOfDay(hour: number): PartKey {
  if (hour >= 5 && hour <= 10) return "morning";
  if (hour >= 11 && hour <= 16) return "afternoon";
  if (hour >= 17 && hour <= 21) return "evening";
  return "night";
}

function partLabel(p: PartKey, en: boolean): string {
  if (en)
    return {
      morning: "in the morning",
      afternoon: "in the afternoon",
      evening: "in the evening",
      night: "at night",
    }[p];
  return {
    morning: "ráno",
    afternoon: "odpoledne",
    evening: "večer",
    night: "v noci",
  }[p];
}

// Spojení navazujících částí dne do jednoho výrazu (ráno + odpoledne → „od rána
// do odpoledne"). Pro nesouvislé části vypíšeme jen tu nejvýraznější.
function joinParts(parts: PartKey[], en: boolean): string {
  const ordered = PART_ORDER.filter((p) => parts.includes(p));
  if (ordered.length === 0) return "";
  if (ordered.length === 1) return partLabel(ordered[0], en);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  return en
    ? `from the ${partLabel(first, en).replace("in the ", "").replace("at ", "")} to the ${partLabel(last, en).replace("in the ", "").replace("at ", "")}`
    : `${partLabel(first, en)} až ${partLabel(last, en)}`;
}

type PrecipType = "thunder" | "snow" | "sleet" | "showers" | "rain" | "drizzle";

function precipType(code: number): PrecipType | null {
  if ([95, 96, 99].includes(code)) return "thunder";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  if ([56, 57, 66, 67].includes(code)) return "sleet";
  if ([80, 81, 82].includes(code)) return "showers";
  if ([61, 63, 65].includes(code)) return "rain";
  if ([51, 53, 55].includes(code)) return "drizzle";
  return null;
}

function precipTypeLabel(t: PrecipType, en: boolean): string {
  if (en)
    return {
      thunder: "storms",
      snow: "snow",
      sleet: "freezing precip",
      showers: "showers",
      rain: "rain",
      drizzle: "drizzle",
    }[t];
  return {
    thunder: "bouřky",
    snow: "sněžení",
    sleet: "mrznoucí srážky",
    showers: "přeháňky",
    rain: "déšť",
    drizzle: "mrholení",
  }[t];
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function daySummary(
  day: DailyPoint,
  hours: HourlyPoint[],
  date: string,
): string {
  const en = getLang() === "en";
  const rows = hours.filter((h) => h.time.slice(0, 10) === date);
  const info = describeWeather(day.weatherCode);
  const min = Math.round(day.tempMin);
  const max = Math.round(day.tempMax);

  // 1) Obloha + teploty.
  const skyLabel = en ? enSky(day.weatherCode) : info.label.toLowerCase();
  const tempPhrase = en ? `${min} to ${max}°` : `${min} až ${max}°`;
  const sentence1 = en
    ? `${cap(skyLabel)}, ${tempPhrase}.`
    : `${cap(skyLabel)}, ${tempPhrase}.`;

  // 2) Časování srážek podle částí dne.
  const wetParts = new Map<PartKey, { count: number; type: PrecipType }>();
  let anyPrecip = false;
  for (const h of rows) {
    const wet =
      h.precipitation >= 0.1 ||
      (h.precipitationProbability >= 55 && h.precipitation >= 0.05);
    const t = precipType(h.weatherCode);
    if (wet && t) {
      anyPrecip = true;
      const p = partOfDay(new Date(h.time).getHours());
      const cur = wetParts.get(p);
      if (!cur) wetParts.set(p, { count: 1, type: t });
      else cur.count += 1;
    }
  }
  // Dominantní typ srážek přes mokré hodiny (priorita bouřky > sníh > … ).
  const typePriority: PrecipType[] = [
    "thunder",
    "snow",
    "sleet",
    "showers",
    "rain",
    "drizzle",
  ];
  let domType: PrecipType | null = null;
  for (const h of rows) {
    const t = precipType(h.weatherCode);
    if (
      t &&
      (h.precipitation >= 0.1 || h.precipitationProbability >= 55) &&
      (domType == null ||
        typePriority.indexOf(t) < typePriority.indexOf(domType))
    )
      domType = t;
  }

  let sentence2 = "";
  if (anyPrecip && domType) {
    const parts = [...wetParts.keys()];
    const when = joinParts(parts, en);
    const typeTxt = precipTypeLabel(domType, en);
    if (parts.length >= 3) {
      sentence2 = en
        ? `${cap(typeTxt)} on and off through the day.`
        : `${cap(typeTxt)} s přestávkami celý den.`;
    } else {
      sentence2 = en
        ? `${cap(typeTxt)} ${when}.`
        : `${cap(when)} ${typeTxt}.`;
    }
  } else if (day.precipitationProbabilityMax < 20) {
    sentence2 = en ? "Staying dry." : "Beze srážek.";
  }

  // 3) Nejvýraznější doplněk (vítr / mlha), bouřky už řeší typ srážek.
  let extra = "";
  const gust = day.windGustsMax ?? 0;
  const wind = day.windSpeedMax ?? 0;
  const fogMorning = rows.some(
    (h) =>
      [45, 48].includes(h.weatherCode) &&
      partOfDay(new Date(h.time).getHours()) === "morning",
  );
  if (gust >= 17 || wind >= 12) {
    extra = en
      ? `Windy, gusts up to ${Math.round(gust || wind)} m/s.`
      : `Větrno, nárazy až ${Math.round(gust || wind)} m/s.`;
  } else if (fogMorning) {
    extra = en ? "Morning fog." : "Ráno mlha.";
  }

  return [sentence1, sentence2, extra].filter(Boolean).join(" ");
}

// Anglické popisy oblohy (kód → text), aby věta nezněla jen počesku.
function enSky(code: number): string {
  const map: Record<number, string> = {
    0: "clear",
    1: "mostly clear",
    2: "partly cloudy",
    3: "overcast",
    45: "foggy",
    48: "freezing fog",
    51: "light drizzle",
    53: "drizzle",
    55: "heavy drizzle",
    56: "freezing drizzle",
    57: "freezing drizzle",
    61: "light rain",
    63: "rain",
    65: "heavy rain",
    66: "freezing rain",
    67: "freezing rain",
    71: "light snow",
    73: "snow",
    75: "heavy snow",
    77: "snow grains",
    80: "light showers",
    81: "showers",
    82: "heavy showers",
    85: "snow showers",
    86: "heavy snow showers",
    95: "thunderstorms",
    96: "thunderstorms with hail",
    99: "severe thunderstorms",
  };
  return map[code] ?? "changeable";
}
