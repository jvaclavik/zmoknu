import type { RadarData, RadarFrame } from "../types";
import { isLowMemoryClient } from "./lowMemory";

// Radarová síť CZRAD (ČHMÚ) – sloučený snímek maximální odrazivosti.
// Snímky jsou georeferencované PNG v projekci EPSG:3857 (kompatibilní s OSM).
// ČHMÚ neposílá CORS – taháme je přes /api/chmi-opendata (Vercel serverless,
// lokálně vite dev-api), ať místo PNG nepřijde HTML ze SPA rewrite.
const BASE = "/api/chmi-opendata";

// Hranice celého obrázku (pro Leaflet ImageOverlay): [[jih, západ], [sever, východ]].
export const CHMI_BOUNDS: [[number, number], [number, number]] = [
  [48.047, 11.267],
  [52.167, 20.77],
];

// Oblast s kvalitními daty (užší než obrázek) – tady má smysl ČHMÚ nabízet.
export function isInChmiCoverage(lat: number, lon: number): boolean {
  return lat >= 48.0 && lat <= 51.5 && lon >= 11.3 && lon <= 19.6;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function loadImgEl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`chmi frame ${url}`));
    img.src = url;
  });
}

function isPng(buf: ArrayBuffer): boolean {
  const u8 = new Uint8Array(buf);
  return u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47;
}

let decodeActive = 0;
const decodeWait: Array<() => void> = [];

function acquireDecode(): Promise<void> {
  const max = isLowMemoryClient() ? 2 : 4;
  if (decodeActive < max) {
    decodeActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => decodeWait.push(resolve));
}

function releaseDecode() {
  const next = decodeWait.shift();
  if (next) next();
  else decodeActive--;
}

function capUrlCache() {
  const max = isLowMemoryClient() ? 20 : 80;
  while (urlCache.size > max) {
    const first = urlCache.keys().next().value;
    if (first == null) break;
    const url = urlCache.get(first);
    if (url) URL.revokeObjectURL(url);
    urlCache.delete(first);
  }
}

// Paletové PNG + tRNS MapLibre přes createImageBitmap nenačte. Překreslíme
// do RGBA a MapLibre dostane blob URL obyčejného PNG.
async function rgbaPngUrl(path: string): Promise<string> {
  await acquireDecode();
  const canvas = document.createElement("canvas");
  const srcBlob = { url: "" };
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`chmi frame ${path} ${res.status}`);
    const buf = await res.arrayBuffer();
    if (!isPng(buf)) throw new Error("chmi frame not png");
    srcBlob.url = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
    const img = await loadImgEl(srcBlob.url);
    if (!img.naturalWidth || !img.naturalHeight) throw new Error("empty frame");
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    const maxEdge = isLowMemoryClient() ? 1024 : 0;
    if (maxEdge > 0) {
      const edge = Math.max(w, h);
      if (edge > maxEdge) {
        const s = maxEdge / edge;
        w = Math.max(1, Math.round(w * s));
        h = Math.max(1, Math.round(h * s));
      }
    }
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d ctx");
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/png");
    });
    return URL.createObjectURL(blob);
  } finally {
    canvas.width = 1;
    canvas.height = 1;
    if (srcBlob.url) URL.revokeObjectURL(srcBlob.url);
    releaseDecode();
  }
}

const urlCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

export function peekChmiDisplayUrl(path: string): string | undefined {
  const hit = urlCache.get(path);
  if (!hit) return undefined;
  urlCache.delete(path);
  urlCache.set(path, hit);
  return hit;
}

export function chmiDisplayUrl(path: string): Promise<string> {
  const hit = peekChmiDisplayUrl(path);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(path);
  if (pending) return pending;
  const job = rgbaPngUrl(path)
    .then((url) => {
      urlCache.delete(path);
      urlCache.set(path, url);
      capUrlCache();
      return url;
    })
    .finally(() => {
      inflight.delete(path);
    });
  inflight.set(path, job);
  return job;
}

export function releaseChmiDisplayUrls(keep: Set<string>) {
  for (const [path, url] of urlCache) {
    if (keep.has(path)) continue;
    URL.revokeObjectURL(url);
    urlCache.delete(path);
  }
}

function frameUrl(d: Date): string {
  const y = d.getUTCFullYear();
  const stamp = `${y}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}.${pad(
    d.getUTCHours(),
  )}${pad(d.getUTCMinutes())}`;
  return `${BASE}?kind=radar&file=${encodeURIComponent(
    `pacz2gmaps3.z_max3d.${stamp}.0.png`,
  )}`;
}

// Krok snímků podle stáří – u „teď" hustě, do minulosti řidčeji, ať nevzniká
// příliš mnoho vrstev (ČHMÚ opendata drží ~7 dní snímků po 5 min).
function stepForAgeHours(ageH: number): number {
  if (ageH < 3) return 10;
  if (ageH < 12) return 30;
  if (ageH < 24) return 60;
  return 120;
}

// Sestaví seznam snímků za posledních `hours` hodin s adaptivním krokem.
export function buildChmiRadar(hours = 12): RadarData {
  const base = 10 * 60 * 1000; // zarovnání na 10min (soubory jsou po 5 min)
  // Poslední dostupný snímek bereme s rezervou 10 min (data mají zpoždění).
  const latest = Math.floor((Date.now() - 10 * 60 * 1000) / base) * base;
  const startMs = latest - hours * 60 * 60 * 1000;

  const stamps: number[] = [];
  let t = latest;
  while (t >= startMs) {
    stamps.push(t);
    const ageH = (latest - t) / 3_600_000;
    // Krátké okno (≤6 h) chceme kompletně po 10 min, delší adaptivně.
    const stepMin = hours <= 6 ? 10 : stepForAgeHours(ageH);
    t -= stepMin * 60 * 1000;
  }
  stamps.reverse();

  const frames: RadarFrame[] = stamps.map((ms) => ({
    time: Math.floor(ms / 1000),
    path: frameUrl(new Date(ms)),
    kind: "past",
  }));
  return { host: "", frames, nowcastStartIndex: frames.length };
}
