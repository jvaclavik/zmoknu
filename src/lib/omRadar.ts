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
const N = 17;
const LAT_SPAN = 3.0;
// Kolik budoucích hodin nejvýše zobrazit (ICON-D2 dává rozumnou předpověď).
const MAX_HOURS = 24;

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

  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lats.join(",")}` +
    `&longitude=${lons.join(",")}` +
    "&hourly=precipitation&forecast_days=2&timeformat=unixtime";

  const res = await fetch(url);
  if (!res.ok) throw new Error("Nepodařilo se načíst předpověď srážek.");
  const data = (await res.json()) as {
    hourly: { time: number[]; precipitation: (number | null)[] };
  }[];
  if (!Array.isArray(data) || !data.length) {
    throw new Error("Předpověď srážek není k dispozici.");
  }

  const allTimes = data[0].hourly.time;
  const now = Date.now() / 1000;
  let start = allTimes.findIndex((t) => t >= now - 1800);
  if (start < 0) start = 0;
  const end = Math.min(allTimes.length, start + MAX_HOURS);
  const times = allTimes.slice(start, end);

  const values: number[][] = times.map((_, k) =>
    data.map((pt) => {
      const v = pt.hourly.precipitation[start + k];
      return v == null || !Number.isFinite(v) ? 0 : v;
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
// Kolik dní stáhnout do minulosti / budoucnosti (kryje všechna období).
const ACC_PAST_DAYS = 30;
const ACC_FORECAST_DAYS = 7;

// Definice období: počet dní a směr (minulost/budoucnost) od „teď". Úhrn
// počítáme z denních součtů srážek (precipitation_sum), aby přenos zůstal malý
// i pro delší okna (30 dní).
export interface AccumPeriod {
  id: string;
  label: string; // český popisek (klíč pro i18n)
  days: number;
  future: boolean;
  scaleMax: number; // horní hranice barevné škály (mm)
}

export const ACCUM_PERIODS: AccumPeriod[] = [
  { id: "past2", label: "Poslední 2 dny", days: 2, future: false, scaleMax: 40 },
  { id: "past3", label: "Poslední 3 dny", days: 3, future: false, scaleMax: 60 },
  { id: "past7", label: "Posledních 7 dní", days: 7, future: false, scaleMax: 100 },
  { id: "past30", label: "Posledních 30 dní", days: 30, future: false, scaleMax: 250 },
  { id: "next7", label: "Příštích 7 dní", days: 7, future: true, scaleMax: 100 },
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

// Z denních úhrnů spočítá součet za zvolené období (bez síťového dotazu).
export function sumAccumPeriod(
  raw: OmAccumDaily,
  period: AccumPeriod,
): OmAccumGrid {
  const now = Date.now() / 1000;
  // Index dneška = poslední den, jehož začátek už nastal.
  let todayIdx = 0;
  for (let i = 0; i < raw.days.length; i++) {
    if (raw.days[i] <= now) todayIdx = i;
  }

  const [from, to] = period.future
    ? [todayIdx, todayIdx + period.days - 1]
    : [todayIdx - (period.days - 1), todayIdx];
  const lo = Math.max(0, from);
  const hi = Math.min(raw.daily[0]?.length ? raw.daily[0].length - 1 : 0, to);

  const values = raw.daily.map((arr) => {
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += arr[k] ?? 0;
    return +sum.toFixed(1);
  });

  return { lats: raw.lats, lons: raw.lons, values };
}
