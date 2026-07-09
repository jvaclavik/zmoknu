import type { IncomingMessage, ServerResponse } from "node:http";
import * as hdf5 from "jsfive";
import { PNG } from "pngjs";

// Vyrenderuje mapu úhrnu srážek (24/48/72/168 h) sečtením surových ČHMÚ MERGE
// 1h mřížek (ODIM HDF5, veličina ACRR, mm = gain*raw). Každý MERGE soubor je
// hodinový součet publikovaný po 10 min – bereme jeden soubor na hodinu
// (nepřekrývající se okna) zpět o `hours` hodin od posledního snímku, sečteme
// po pixelech, obarvíme a vrátíme PNG. Umístění na mapě řídí datový rozsah
// MERGE mřížky (viz MERGE_DATA_COORDINATES ve frontendu).
const DIR =
  "https://opendata.chmi.cz/meteorology/weather/radar/composite/merge1h/hdf5/";

// Barevná škála pro úhrn srážek [mm]. MUSÍ zůstat v souladu s
// src/lib/precipScale.ts (legenda + Open-Meteo fallback na klientu). Nešaháme na
// sdílený import přes hranici src/, aby se funkce spolehlivě zabalila na Vercelu.
const PRECIP_SCALE: { min: number; color: [number, number, number] }[] = [
  { min: 0.1, color: [200, 230, 255] },
  { min: 1, color: [130, 200, 255] },
  { min: 5, color: [80, 150, 255] },
  { min: 10, color: [40, 90, 230] },
  { min: 20, color: [30, 170, 90] },
  { min: 30, color: [120, 210, 40] },
  { min: 40, color: [240, 230, 40] },
  { min: 60, color: [250, 170, 30] },
  { min: 80, color: [235, 90, 30] },
  { min: 100, color: [200, 30, 30] },
  { min: 150, color: [150, 20, 90] },
  { min: 250, color: [120, 60, 160] },
];
const PRECIP_ALPHA = 220;

function precipColor(mm: number): [number, number, number, number] {
  if (!(mm >= PRECIP_SCALE[0].min)) return [0, 0, 0, 0];
  let c = PRECIP_SCALE[0].color;
  for (const stop of PRECIP_SCALE) {
    if (mm >= stop.min) c = stop.color;
  }
  return [c[0], c[1], c[2], PRECIP_ALPHA];
}

// Hlavička k ČHMÚ requestům – některé servery odmítají prázdný/„node“ UA.
const FETCH_HEADERS = {
  "User-Agent": "zmoknu/1.0 (+https://zmoknu.vercel.app)",
};

const W = 598;
const H = 378;
const NODATA = 32767;
const UNDETECT = 32766;
const GAIN = 0.1;

const ALLOWED_HOURS = new Set([24, 48, 72, 168]);
const TS_RE = /^\d{12}$/; // YYYYMMDDHHmm
const FETCH_CONCURRENCY = 16;

// ---- cache (na úrovni modulu, přežije mezi requesty v teplé lambdě) --------
const GRID_CACHE = new Map<string, Uint16Array>();
const GRID_CACHE_MAX = 200; // ~200 * 452 KB ≈ 90 MB
const PNG_CACHE = new Map<string, Buffer>();
const PNG_CACHE_MAX = 12;

function putLru<V>(cache: Map<string, V>, key: string, val: V, max: number) {
  cache.set(key, val);
  while (cache.size > max) {
    cache.delete(cache.keys().next().value as string);
  }
}

// stamp = YYYYMMDDHHmm00 (název souboru), z Date v UTC.
const stampFromMs = (ms: number) => {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}` +
    `${String(d.getUTCMonth() + 1).padStart(2, "0")}` +
    `${String(d.getUTCDate()).padStart(2, "0")}` +
    `${String(d.getUTCHours()).padStart(2, "0")}` +
    `${String(d.getUTCMinutes()).padStart(2, "0")}00`
  );
};

const msFromTs = (ts: string) =>
  Date.UTC(
    +ts.slice(0, 4),
    +ts.slice(4, 6) - 1,
    +ts.slice(6, 8),
    +ts.slice(8, 10),
    +ts.slice(10, 12),
  );

// Zjistí nejnovější dostupný MERGE snímek (YYYYMMDDHHmm) z výpisu adresáře.
async function latestTs(): Promise<string | null> {
  const res = await fetch(DIR, { headers: FETCH_HEADERS });
  if (!res.ok) return null;
  const html = await res.text();
  const re = /T_PASV23_C_OKPR_(\d{12})00\.hdf/g;
  let m: RegExpExecArray | null;
  let latest: string | null = null;
  while ((m = re.exec(html))) {
    if (!latest || m[1] > latest) latest = m[1];
  }
  return latest;
}

async function getGrid(stamp: string): Promise<Uint16Array | null> {
  const cached = GRID_CACHE.get(stamp);
  if (cached) return cached;
  const res = await fetch(`${DIR}T_PASV23_C_OKPR_${stamp}.hdf`, {
    headers: FETCH_HEADERS,
  });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  const file = new hdf5.File(buf.buffer, "g.hdf");
  const dset = file.get("dataset1/data1/data") as { value: number[] } | null;
  if (!dset || dset.value.length !== W * H) return null;
  const arr = Uint16Array.from(dset.value);
  putLru(GRID_CACHE, stamp, arr, GRID_CACHE_MAX);
  return arr;
}

async function buildAccum(stamps: string[]) {
  const sum = new Float32Array(W * H);
  const valid = new Uint8Array(W * H);
  let ok = 0;

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= stamps.length) return;
      const grid = await getGrid(stamps[i]);
      if (!grid) continue;
      ok += 1;
      for (let p = 0; p < grid.length; p++) {
        const raw = grid[p];
        if (raw === NODATA) continue;
        valid[p] = 1;
        if (raw !== UNDETECT) sum[p] += raw * GAIN;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, stamps.length) }, worker),
  );
  return { sum, valid, ok };
}

function renderPng(sum: Float32Array, valid: Uint8Array): Buffer {
  const png = new PNG({ width: W, height: H });
  for (let p = 0; p < W * H; p++) {
    const [r, g, b, a] = valid[p] ? precipColor(sum[p]) : [0, 0, 0, 0];
    const o = p * 4;
    png.data[o] = r;
    png.data[o + 1] = g;
    png.data[o + 2] = b;
    png.data[o + 3] = a;
  }
  return PNG.sync.write(png);
}

// Umožní na Vercelu delší běh (7denní úhrn = 168 stažení HDF5).
export const config = { maxDuration: 60 };

export default async function handler(
  req: IncomingMessage & { url?: string },
  res: ServerResponse,
) {
  if (req.method && req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const hours = Number(url.searchParams.get("hours") ?? 24);
  if (!ALLOWED_HOURS.has(hours)) {
    res.statusCode = 400;
    res.end("Invalid hours (24, 48, 72 or 168)");
    return;
  }

  const sendPng = (png: Buffer) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=600, immutable");
    res.end(png);
  };

  // Vše (včetně zjištění nejnovějšího snímku a stažení HDF5) obalíme, aby žádná
  // síťová/parsovací chyba neskončila jako neošetřený pád lambdy (500
  // FUNCTION_INVOCATION_FAILED). Místo toho vrátíme čitelnou 502 s důvodem.
  try {
    let endTs = url.searchParams.get("ts") ?? "";
    if (!TS_RE.test(endTs)) {
      const latest = await latestTs();
      if (!latest) {
        res.statusCode = 502;
        res.end("No grids available (latestTs failed)");
        return;
      }
      endTs = latest;
    }

    const endMs = msFromTs(endTs);
    const cacheKey = `${hours}:${endTs}`;

    const cached = PNG_CACHE.get(cacheKey);
    if (cached) {
      sendPng(cached);
      return;
    }

    const stamps = Array.from({ length: hours }, (_, i) =>
      stampFromMs(endMs - i * 3600_000),
    );

    const { sum, valid, ok } = await buildAccum(stamps);
    if (ok === 0) {
      res.statusCode = 502;
      res.end("No grids available");
      return;
    }
    const png = renderPng(sum, valid);
    putLru(PNG_CACHE, cacheKey, png, PNG_CACHE_MAX);
    sendPng(png);
  } catch (err) {
    res.statusCode = 502;
    res.end(`accum error: ${err instanceof Error ? err.stack : String(err)}`);
  }
}
