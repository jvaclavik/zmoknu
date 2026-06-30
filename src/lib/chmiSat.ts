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
