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
// na průhledný overlay: jasno zmizí, mraky jsou ocelově modré podle hustoty.
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
  // IR 10.8: teplý povrch tmavý, studené mraky světlé. Původní šedý JPEG na
  // světlé mapě splývá s terénem a slabý IR opar vypadá jako „všude zataženo".
  // Tvrdší práh + S-křivka nechá jasno úplně průhledné; mraky přebarvíme na
  // ocelově modrou, ať jsou poznat na světlé i tmavé podkladové mapě.
  const LO = 96;
  const HI = 176;
  for (let p = 0; p < d.length; p += 4) {
    const lum = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
    let t = (lum - LO) / (HI - LO);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    t = t * t * (3 - 2 * t);
    if (t < 0.05) {
      d[p + 3] = 0;
      continue;
    }
    d[p] = Math.round(118 + t * 110);
    d[p + 1] = Math.round(138 + t * 100);
    d[p + 2] = Math.round(175 + t * 80);
    d[p + 3] = Math.round(36 + t * 172);
  }
  ctx.putImageData(img, 0, 0);

  const out = canvas.toDataURL("image/png");
  cloudCache.set(url, out);
  return out;
}

const SAT_STEP_SEC = 15 * 60;

// Družice IR108 je po 15 min; radar má vlastní krok (10/30/60/120). Bereme
// stejná razítka jako radar a soubor zarovnáme na 15 min dolů – overlay se
// pak k radarovému času doreguluje posunem, ať krok ve slideru sedí 1:1.
export function buildChmiSatFrames(
  radarTimes: number[],
  product = "ir108",
  region = "cz",
): SatFrame[] {
  const snaps = new Set<number>();
  for (const t of radarTimes) {
    if (!Number.isFinite(t)) continue;
    snaps.add(Math.floor(t / SAT_STEP_SEC) * SAT_STEP_SEC);
  }
  return [...snaps]
    .sort((a, b) => a - b)
    .map((time) => ({
      time,
      url: chmiSatUrl(new Date(time * 1000), product, region),
    }));
}
