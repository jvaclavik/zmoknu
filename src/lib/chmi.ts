import type { RadarData, RadarFrame } from "../types";

// Radarová síť CZRAD (ČHMÚ) – sloučený snímek maximální odrazivosti.
// Snímky jsou georeferencované PNG v projekci EPSG:3857 (kompatibilní s OSM).
// ČHMÚ neposílá CORS hlavičky, takže obrázky tahá MapLibre přes proxy na
// vlastním originu (/chmi-radar → opendata.chmi.cz; viz vercel.json a vite).
const BASE = "/chmi-radar";

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

function frameUrl(d: Date): string {
  const y = d.getUTCFullYear();
  const stamp = `${y}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}.${pad(
    d.getUTCHours(),
  )}${pad(d.getUTCMinutes())}`;
  return `${BASE}/pacz2gmaps3.z_max3d.${stamp}.0.png`;
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
