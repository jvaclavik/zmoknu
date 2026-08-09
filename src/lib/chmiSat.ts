// Družicové kompozity ČHMÚ (Meteosat/SEVIRI) z opendata.chmi.cz. Snímky jsou
// JPEG po 15 min v surové geostacionární projekci, takže je na web-mercator
// mapu umisťujeme jen PŘIBLIŽNĚ (rohy odhadnuté, viz CHMI_SAT_CZ_BOUNDS).
// ČHMÚ neposílá CORS hlavičky → obrázky tahá MapLibre přes proxy na vlastním
// originu (/chmi-sat → …/satellite/geo; viz vercel.json a vite.config.ts).
const BASE = "/chmi-sat";

// Přibližné hranice výřezu „_cz" (GEOS projekce → orientační rámec).
// Střed ~ (15° E, 49.8° N) ≈ ČR, poměr stran ladí s obrázkem 1160×800.
export const CHMI_SAT_CZ_BOUNDS = { w: 8.25, e: 21.75, n: 52.8, s: 46.8 };

// Rohy pro MapLibre image source jako [lon, lat]: TL, TR, BR, BL.
export const CHMI_SAT_CZ_COORDS: [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
] = [
  [CHMI_SAT_CZ_BOUNDS.w, CHMI_SAT_CZ_BOUNDS.n],
  [CHMI_SAT_CZ_BOUNDS.e, CHMI_SAT_CZ_BOUNDS.n],
  [CHMI_SAT_CZ_BOUNDS.e, CHMI_SAT_CZ_BOUNDS.s],
  [CHMI_SAT_CZ_BOUNDS.w, CHMI_SAT_CZ_BOUNDS.s],
];

export interface SatFrame {
  time: number; // unix sekundy (UTC)
  url: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function chmiSatUrl(
  d: Date,
  product = "ir108",
  region = "cz",
): string {
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  return `${BASE}/${product}/${stamp}_geo_${product}_${region}.jpg`;
}

// Družicový IR snímek (šedotón: mraky světlé, čistá obloha tmavá) přepočítáme
// tak, aby průhlednost odpovídala jasu – čistá obloha zprůhlední, zůstanou jen
// mraky, takže overlay nezakrývá celou mapu. Výsledkem je PNG data URL.
// Kešujeme podle URL, ať se to nepočítá znovu při přepínání času / vrstvy.
const cloudCache = new Map<string, string>();

export async function cloudMaskUrl(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const cached = cloudCache.get(url);
  if (cached) return cached;

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`sat ${res.status}`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);

  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bmp.close?.();
    throw new Error("no 2d ctx");
  }
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  // Práh jasu → alfa. Pod LO (čistá obloha, tmavá) plně průhledné, nad HI plné
  // mraky. Křivku umocníme (ease-in), ať slabý IR šum / opar nedělá „mlhu".
  const LO = 45;
  const HI = 150;
  const MAX_A = 255; // husté mraky téměř plné, ať jsou dobře vidět
  for (let p = 0; p < d.length; p += 4) {
    const lum = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
    let a = (lum - LO) / (HI - LO);
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    // Mírný ease-in (jen odfiltruje slabý IR opar), jinak už lineárně sílí.
    a = Math.pow(a, 0.7);
    d[p + 3] = Math.round(a * MAX_A);
  }
  ctx.putImageData(img, 0, 0);

  const out = canvas.toDataURL("image/png");
  cloudCache.set(url, out);
  return out;
}

// Snímky po 15 min za posledních `hours` hodin (ČHMÚ drží nedávné snímky).
export function buildChmiSatFrames(
  hours = 6,
  product = "ir108",
  region = "cz",
): SatFrame[] {
  const step = 15 * 60 * 1000;
  // Nejnovější snímek zarovnaný na 15 min, s rezervou 20 min (data mají zpoždění).
  const latest = Math.floor((Date.now() - 20 * 60 * 1000) / step) * step;
  const start = latest - hours * 60 * 60 * 1000;
  const frames: SatFrame[] = [];
  for (let t = start; t <= latest; t += step) {
    frames.push({
      time: Math.floor(t / 1000),
      url: chmiSatUrl(new Date(t), product, region),
    });
  }
  return frames;
}
