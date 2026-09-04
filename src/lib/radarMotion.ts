import type { RadarFrame } from "../types";
import { CHMI_BOUNDS } from "./chmi";

// Odhad posunu srážkového pole ze dvou po sobě jdoucích snímků radaru ČHMÚ.
// Snímky jdou přes vlastní origin (/chmi-radar), takže je lze číst z canvasu
// bez CORS omezení. Výsledný vektor používá RadarMap na extrapolaci (predikci)
// posledního snímku – klasická „Lagrangeovská perzistence": pole se nemění,
// jen se posouvá.

// Stupnice odrazivosti CZRAD (od nejslabší po nejsilnější). Snímek obsahuje i
// statickou grafiku (rámeček, obrysy hranic) – ta je v obou snímcích shodná a
// táhla by korelaci k nulovému posunu, proto bereme jen tyhle barvy.
const ECHO_COLORS: [number, number, number][] = [
  [56, 0, 112],
  [48, 0, 168],
  [0, 0, 252],
  [0, 108, 192],
  [0, 160, 0],
  [0, 188, 0],
  [52, 216, 0],
  [156, 220, 0],
  [224, 220, 0],
  [252, 176, 0],
  [252, 132, 0],
  [252, 88, 0],
  [252, 0, 0],
  [160, 0, 0],
];

const ECHO_WEIGHT = new Map<number, number>(
  ECHO_COLORS.map(([r, g, b], i) => [(r << 16) | (g << 8) | b, i + 1]),
);

export interface RadarMotion {
  // Posun pole v pixelech snímku za `stepSec` (x doprava, y dolů).
  dxPx: number;
  dyPx: number;
  // Týž posun jako podíl šířky/výšky snímku – použitelný bez znalosti rozlišení.
  dxFrac: number;
  dyFrac: number;
  stepSec: number;
  // Shoda po posunu (normalizovaná křížová korelace, 0–1) = spolehlivost.
  score: number;
  speedKmh: number;
  // Směr, kterým se pole posouvá (0 = na sever, 90 = na východ).
  dirDeg: number;
}

interface Field {
  w: number;
  h: number;
  data: Float32Array;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`radar frame failed: ${url}`));
    img.src = url;
  });
}

function readPixels(img: HTMLImageElement): ImageData | null {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  try {
    return ctx.getImageData(0, 0, w, h);
  } catch {
    return null; // tainted canvas (snímek zvenčí bez CORS)
  }
}

// Snímek jen se srážkami – bez rámečku, hlavičky s časem a obrysů hranic.
// Posunutá (predikovaná) vrstva by jinak vezla statickou grafiku s sebou a
// přes mapu by se táhl posunutý rámeček i druhý časový údaj.
export async function echoOnlyImage(url: string): Promise<string | null> {
  let px: ImageData | null = null;
  try {
    px = readPixels(await loadImage(url));
  } catch {
    return null;
  }
  if (!px) return null;
  const d = px.data;
  for (let o = 0; o < d.length; o += 4) {
    if (d[o + 3] < 128) continue;
    const key = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
    if (!ECHO_WEIGHT.has(key)) d[o + 3] = 0;
  }
  const canvas = document.createElement("canvas");
  canvas.width = px.width;
  canvas.height = px.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.putImageData(px, 0, 0);
  return canvas.toDataURL();
}

// Převede snímek na hrubší mřížku intenzit – průměr vah odrazivosti v bloku
// `scale`×`scale` px. Hrubší mřížka je rychlejší a odolnější vůči šumu.
function toField(px: ImageData, scale: number): Field {
  const w = Math.floor(px.width / scale);
  const h = Math.floor(px.height / scale);
  const data = new Float32Array(w * h);
  const d = px.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let j = 0; j < scale; j++) {
        const row = (y * scale + j) * px.width;
        for (let i = 0; i < scale; i++) {
          const o = (row + x * scale + i) * 4;
          if (d[o + 3] < 128) continue;
          const key = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
          sum += ECHO_WEIGHT.get(key) ?? 0;
        }
      }
      data[y * w + x] = sum / (scale * scale);
    }
  }
  return { w, h, data };
}

function coverage(f: Field): number {
  let n = 0;
  for (let i = 0; i < f.data.length; i++) if (f.data[i] > 0) n++;
  return n / f.data.length;
}

// Normalizovaná křížová korelace pole `a` posunutého o (dx, dy) proti `b`.
function ncc(a: Field, b: Field, dx: number, dy: number): number {
  const x0 = Math.max(0, -dx);
  const x1 = Math.min(a.w, a.w - dx);
  const y0 = Math.max(0, -dy);
  const y1 = Math.min(a.h, a.h - dy);
  if (x1 - x0 < 8 || y1 - y0 < 8) return 0;

  let sa = 0;
  let sb = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    const ra = y * a.w;
    const rb = (y + dy) * b.w + dx;
    for (let x = x0; x < x1; x++) {
      sa += a.data[ra + x];
      sb += b.data[rb + x];
      n++;
    }
  }
  if (!n) return 0;
  const ma = sa / n;
  const mb = sb / n;

  let num = 0;
  let da = 0;
  let db = 0;
  for (let y = y0; y < y1; y++) {
    const ra = y * a.w;
    const rb = (y + dy) * b.w + dx;
    for (let x = x0; x < x1; x++) {
      const va = a.data[ra + x] - ma;
      const vb = b.data[rb + x] - mb;
      num += va * vb;
      da += va * va;
      db += vb * vb;
    }
  }
  if (da <= 0 || db <= 0) return 0;
  return num / Math.sqrt(da * db);
}

interface Shift {
  dx: number;
  dy: number;
  score: number;
  onEdge: boolean;
}

// Prohledá okolí (cx, cy) do poloměru r a vrátí posun s nejvyšší korelací.
function bestShift(
  a: Field,
  b: Field,
  cx: number,
  cy: number,
  r: number,
): Shift {
  let best: Shift = { dx: cx, dy: cy, score: -1, onEdge: false };
  for (let dy = cy - r; dy <= cy + r; dy++) {
    for (let dx = cx - r; dx <= cx + r; dx++) {
      const score = ncc(a, b, dx, dy);
      if (score > best.score) {
        best = {
          dx,
          dy,
          score,
          onEdge: Math.abs(dx - cx) === r || Math.abs(dy - cy) === r,
        };
      }
    }
  }
  return best;
}

// Subpixelové doladění parabolou přes tři sousední hodnoty korelace.
function refine(a: Field, b: Field, s: Shift): { dx: number; dy: number } {
  const peak = (m: number, c: number, p: number) => {
    const den = m - 2 * c + p;
    if (!den) return 0;
    const off = (0.5 * (m - p)) / den;
    return Math.abs(off) <= 1 ? off : 0;
  };
  const cx = peak(
    ncc(a, b, s.dx - 1, s.dy),
    s.score,
    ncc(a, b, s.dx + 1, s.dy),
  );
  const cy = peak(
    ncc(a, b, s.dx, s.dy - 1),
    s.score,
    ncc(a, b, s.dx, s.dy + 1),
  );
  return { dx: s.dx + cx, dy: s.dy + cy };
}

// Hrubá mřížka pro první průchod (≈4 km/buňka) a jemná pro doladění (≈2 km).
const COARSE = 4;
const FINE = 2;
// Rozsah hledání na hrubé mřížce: ±6 buněk ≈ ±24 km za 10 min ≈ 145 km/h.
const COARSE_RADIUS = 6;
const MIN_COVERAGE = 0.002; // pod 0,2 % zasažené plochy nemá korelace smysl
const MIN_SCORE = 0.35;

function estimateFromPixels(
  older: ImageData,
  newer: ImageData,
  stepSec: number,
): RadarMotion | null {
  const a4 = toField(older, COARSE);
  const b4 = toField(newer, COARSE);
  if (coverage(a4) < MIN_COVERAGE || coverage(b4) < MIN_COVERAGE) return null;

  const coarse = bestShift(a4, b4, 0, 0, COARSE_RADIUS);
  // Posun na okraji prohledávaného okna = pravděpodobně mimo rozsah, neriskuj.
  if (coarse.onEdge || coarse.score < MIN_SCORE) return null;

  const a2 = toField(older, FINE);
  const b2 = toField(newer, FINE);
  const ratio = COARSE / FINE;
  const fine = bestShift(a2, b2, coarse.dx * ratio, coarse.dy * ratio, ratio);
  if (fine.score < MIN_SCORE) return null;
  const { dx, dy } = refine(a2, b2, fine);

  const dxPx = dx * FINE;
  const dyPx = dy * FINE;

  const [[latS, lonW], [latN, lonE]] = CHMI_BOUNDS;
  const midLat = ((latS + latN) / 2) * (Math.PI / 180);
  const kmPerPxX =
    ((lonE - lonW) * 111.32 * Math.cos(midLat)) / older.width;
  const kmPerPxY = ((latN - latS) * 110.57) / older.height;
  const km = Math.hypot(dxPx * kmPerPxX, dyPx * kmPerPxY);

  return {
    dxPx,
    dyPx,
    dxFrac: dxPx / older.width,
    dyFrac: dyPx / older.height,
    stepSec,
    score: fine.score,
    speedKmh: (km / stepSec) * 3600,
    // Obrazové y roste dolů (k jihu), proto -dy.
    dirDeg:
      (((Math.atan2(dxPx * kmPerPxX, -dyPx * kmPerPxY) * 180) / Math.PI) +
        360) %
      360,
  };
}

// Vezme snímky seřazené od nejnovějšího a najde první dvojici, ze které jde
// posun spočítat (nejnovější snímek nemusí být ještě k dispozici – 404).
export async function estimateRadarMotion(
  newestFirst: RadarFrame[],
): Promise<RadarMotion | null> {
  const pixels = new Map<number, ImageData | null>();
  const read = async (f: RadarFrame): Promise<ImageData | null> => {
    if (pixels.has(f.time)) return pixels.get(f.time) ?? null;
    let px: ImageData | null = null;
    try {
      px = readPixels(await loadImage(f.path));
    } catch {
      px = null;
    }
    pixels.set(f.time, px);
    return px;
  };

  for (let i = 0; i + 1 < newestFirst.length; i++) {
    const newer = await read(newestFirst[i]);
    if (!newer) continue;
    const older = await read(newestFirst[i + 1]);
    if (!older) continue;
    const stepSec = newestFirst[i].time - newestFirst[i + 1].time;
    if (stepSec <= 0) continue;
    const motion = estimateFromPixels(older, newer, stepSec);
    if (motion) return motion;
  }
  return null;
}

type Corners = [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
];

const [[CHMI_S, CHMI_W], [CHMI_N, CHMI_E]] = CHMI_BOUNDS;

function mercY(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}

function invMercY(y: number): number {
  return ((Math.atan(Math.exp(y)) - Math.PI / 4) * 360) / Math.PI;
}

// Rohy snímku ČHMÚ posunuté o `minutes` podle odhadnutého vektoru. Snímek je
// v EPSG:3857, takže posouváme v Mercatoru – jinak by se pole na severu a jihu
// posunulo o různou vzdálenost.
export function shiftedChmiCoords(m: RadarMotion, minutes: number): Corners {
  const steps = (minutes * 60) / m.stepSec;
  const lonOff = m.dxFrac * steps * (CHMI_E - CHMI_W);
  const mercOff = -m.dyFrac * steps * (mercY(CHMI_N) - mercY(CHMI_S));
  const at = (lon: number, lat: number): [number, number] => [
    lon + lonOff,
    invMercY(mercY(lat) + mercOff),
  ];
  return [
    at(CHMI_W, CHMI_N),
    at(CHMI_E, CHMI_N),
    at(CHMI_E, CHMI_S),
    at(CHMI_W, CHMI_S),
  ];
}
