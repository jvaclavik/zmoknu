// Gridová předpověď srážek z Open-Meteo (model ICON) pro „předpovědní radar".
// Kolem lokality vytvoříme čtvercovou mřížku bodů a stáhneme hodinové srážky,
// z nichž pak v mapě skládáme heatmapu očekávaného vývoje na nejbližší hodiny.
export interface OmForecastGrid {
  times: number[]; // unix sekundy (UTC) pro budoucí okno
  lats: number[]; // souřadnice bodů mřížky
  lons: number[];
  values: number[][]; // [index času][index bodu] – srážky v mm/h
}

// Rozměr mřížky (N×N bodů) a její záběr v zeměpisné šířce (stupně).
// Hustší a menší mřížka (~10 km rozteč) = ostřejší, míň „skákavé" pole srážek.
// Pod tím je ICON‑D2 (~2 km, nativní 15min srážky) v centrální Evropě.
const N = 21;
const LAT_SPAN = 2.0;
// Kolik budoucích 15min kroků nejvýše zobrazit (96 × 15 min = 24 h).
const MAX_STEPS = 96;

export async function fetchOmForecastGrid(
  lat: number,
  lon: number,
): Promise<OmForecastGrid> {
  // Poledníky se s rostoucí šířkou sbíhají – roztáhneme záběr na délku, aby
  // mřížka pokrývala zhruba čtvercové území v km.
  const cos = Math.max(0.3, Math.cos((lat * Math.PI) / 180));
  const lonSpan = Math.min(8, LAT_SPAN / cos);

  const lats: number[] = [];
  const lons: number[] = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      lats.push(+(lat - LAT_SPAN / 2 + (LAT_SPAN * i) / (N - 1)).toFixed(3));
      lons.push(+(lon - lonSpan / 2 + (lonSpan * j) / (N - 1)).toFixed(3));
    }
  }

  // 15min kroky (minutely_15) místo hodinových → jemnější časová osa.
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lats.join(",")}` +
    `&longitude=${lons.join(",")}` +
    "&minutely_15=precipitation&forecast_days=2&timeformat=unixtime";

  const res = await fetch(url);
  if (!res.ok) throw new Error("Nepodařilo se načíst předpověď srážek.");
  const data = (await res.json()) as {
    minutely_15: { time: number[]; precipitation: (number | null)[] };
  }[];
  if (!Array.isArray(data) || !data.length) {
    throw new Error("Předpověď srážek není k dispozici.");
  }

  const allTimes = data[0].minutely_15.time;
  const now = Date.now() / 1000;
  // Začni na aktuálním 15min kroku (s malou rezervou dozadu).
  let start = allTimes.findIndex((t) => t >= now - 900);
  if (start < 0) start = 0;
  const end = Math.min(allTimes.length, start + MAX_STEPS);
  const times = allTimes.slice(start, end);

  // minutely_15 udává srážky za 15 min (mm); pro shodnou škálu s heatmapou
  // (kalibrovanou na mm/h) přepočítáme na intenzitu ×4.
  const values: number[][] = times.map((_, k) =>
    data.map((pt) => {
      const v = pt.minutely_15.precipitation[start + k];
      return v == null || !Number.isFinite(v) ? 0 : v * 4;
    }),
  );

  return { times, lats, lons, values };
}

// Úhrn (akumulace) srážek za zvolené období – jedno číslo (mm) na bod mřížky.
export interface OmAccumGrid {
  lats: number[];
  lons: number[];
  values: number[]; // úhrn v mm za období na daném bodu
}

// Denní úhrny pro celé okno (minulost i budoucnost) – stáhnou se jedním
// dotazem a jednotlivá období z nich počítáme lokálně (bez dalších requestů,
// ať nenarazíme na minutový limit Open-Meteo).
export interface OmAccumDaily {
  lats: number[];
  lons: number[];
  days: number[]; // unixové začátky dní (lokální půlnoc)
  daily: number[][]; // [bod][den] – denní úhrn v mm
}

// Menší mřížka pro úhrn – šetří „váhu" API dotazu (méně bodů = méně 429).
const ACC_N = 13;
// Kolik dní stáhnout do minulosti (kryje všechna období). +1 den do budoucna
// kvůli dnešku.
const ACC_PAST_DAYS = 8;
const ACC_FORECAST_DAYS = 1;

// Definice období úhrnu (do minulosti od „teď"). `hours` řídí ČHMÚ MERGE
// (radar), `days` fallback z Open-Meteo mimo pokrytí ČHMÚ.
export interface AccumPeriod {
  id: string;
  label: string; // český popisek (klíč pro i18n)
  hours: number;
}

export const ACCUM_PERIODS: AccumPeriod[] = [
  { id: "h24", label: "24 h", hours: 24 },
  { id: "h48", label: "48 h", hours: 48 },
  { id: "h72", label: "3 dny", hours: 72 },
  { id: "h168", label: "7 dní", hours: 168 },
];

// Stáhne denní úhrny pro celé okno JEDNÍM dotazem (pro danou lokalitu).
export async function fetchOmAccumDaily(
  lat: number,
  lon: number,
): Promise<OmAccumDaily> {
  const cos = Math.max(0.3, Math.cos((lat * Math.PI) / 180));
  const lonSpan = Math.min(8, LAT_SPAN / cos);

  const lats: number[] = [];
  const lons: number[] = [];
  for (let i = 0; i < ACC_N; i++) {
    for (let j = 0; j < ACC_N; j++) {
      lats.push(+(lat - LAT_SPAN / 2 + (LAT_SPAN * i) / (ACC_N - 1)).toFixed(3));
      lons.push(+(lon - lonSpan / 2 + (lonSpan * j) / (ACC_N - 1)).toFixed(3));
    }
  }

  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lats.join(",")}` +
    `&longitude=${lons.join(",")}` +
    "&daily=precipitation_sum" +
    `&past_days=${ACC_PAST_DAYS}&forecast_days=${ACC_FORECAST_DAYS}` +
    "&timezone=auto&timeformat=unixtime";

  const res = await fetch(url);
  if (!res.ok) throw new Error("Nepodařilo se načíst úhrn srážek.");
  const data = (await res.json()) as {
    daily: { time: number[]; precipitation_sum: (number | null)[] };
  }[];
  if (!Array.isArray(data) || !data.length) {
    throw new Error("Úhrn srážek není k dispozici.");
  }

  const days = data[0].daily?.time ?? [];
  const daily = data.map((pt) => {
    const arr = pt.daily?.precipitation_sum ?? [];
    return arr.map((v) => (v != null && Number.isFinite(v) ? v : 0));
  });

  return { lats, lons, days, daily };
}

// Z denních úhrnů spočítá součet za posledních N dní (bez síťového dotazu).
export function sumAccumPeriod(raw: OmAccumDaily, hours: number): OmAccumGrid {
  const days = Math.max(1, Math.round(hours / 24));
  const now = Date.now() / 1000;
  // Index dneška = poslední den, jehož začátek už nastal.
  let todayIdx = 0;
  for (let i = 0; i < raw.days.length; i++) {
    if (raw.days[i] <= now) todayIdx = i;
  }

  const lo = Math.max(0, todayIdx - (days - 1));
  const hi = todayIdx;

  const values = raw.daily.map((arr) => {
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += arr[k] ?? 0;
    return +sum.toFixed(1);
  });

  return { lats: raw.lats, lons: raw.lons, values };
}
