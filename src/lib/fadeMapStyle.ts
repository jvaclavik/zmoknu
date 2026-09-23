import type { StyleSpecification } from "maplibre-gl";

// Ztlumí podklad radaru: odbarví a zatáhne k tmavší šedé, ať světlé
// (šedé až bílé) mraky i barevný radar mají kontrast. KČT a popisky necháme.

const FADE = { desaturate: 0.66, blend: 0.7, target: 24 };

type Rgba = { r: number; g: number; b: number; a: number };

const KEEP_TRAILS = /^trail_(?!longdistance)/;
const COLOR_KEY = /(?:^|-)color$/;

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

const hueToRgb = (p: number, q: number, t: number) => {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
};

const hslToRgb = (h: number, s: number, l: number) => {
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = h / 360;
  return {
    r: hueToRgb(p, q, hk + 1 / 3) * 255,
    g: hueToRgb(p, q, hk) * 255,
    b: hueToRgb(p, q, hk - 1 / 3) * 255,
  };
};

const parseColor = (input: string): Rgba | null => {
  const str = input.trim();

  const hex = str.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    const h = hex[1];
    const full =
      h.length === 3 || h.length === 4
        ? h
            .split("")
            .map((c) => c + c)
            .join("")
        : h;
    if (full.length !== 6 && full.length !== 8) return null;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
    };
  }

  const rgb = str.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i,
  );
  if (rgb) {
    return {
      r: parseFloat(rgb[1]),
      g: parseFloat(rgb[2]),
      b: parseFloat(rgb[3]),
      a: rgb[4] !== undefined ? parseFloat(rgb[4]) : 1,
    };
  }

  const hsl = str.match(
    /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+)\s*)?\)$/i,
  );
  if (hsl) {
    const { r, g, b } = hslToRgb(
      parseFloat(hsl[1]),
      parseFloat(hsl[2]) / 100,
      parseFloat(hsl[3]) / 100,
    );
    return { r, g, b, a: hsl[4] !== undefined ? parseFloat(hsl[4]) : 1 };
  }

  return null;
};

const fadeColorString = (
  input: string,
  desaturate: number,
  blend: number,
  target: number,
): string => {
  const c = parseColor(input);
  if (!c) return input;
  const gray = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  const mute = (channel: number) => {
    const desaturated = channel * (1 - desaturate) + gray * desaturate;
    return desaturated * (1 - blend) + target * blend;
  };
  return `rgba(${clamp(mute(c.r))}, ${clamp(mute(c.g))}, ${clamp(mute(c.b))}, ${c.a})`;
};

const fadeColorValue = (
  value: unknown,
  desaturate: number,
  blend: number,
  target: number,
): unknown => {
  if (typeof value === "string") {
    return fadeColorString(value, desaturate, blend, target);
  }
  if (Array.isArray(value)) {
    return value.map((v) => fadeColorValue(v, desaturate, blend, target));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        fadeColorValue(v, desaturate, blend, target),
      ]),
    );
  }
  return value;
};

const scaleNumeric = (value: unknown, factor: number): unknown => {
  if (typeof value === "number") return value * factor;
  if (value && typeof value === "object" && Array.isArray((value as { stops?: unknown }).stops)) {
    const o = value as { stops: unknown[]; [k: string]: unknown };
    return {
      ...o,
      stops: o.stops.map((s) =>
        Array.isArray(s) && typeof s[1] === "number" ? [s[0], s[1] * factor] : s,
      ),
    };
  }
  return value;
};

export function fadeRadarBasemap(style: StyleSpecification): StyleSpecification {
  const { desaturate, blend, target } = FADE;
  const faded: StyleSpecification =
    typeof structuredClone === "function"
      ? structuredClone(style)
      : JSON.parse(JSON.stringify(style));

  for (const layer of faded.layers) {
    if (KEEP_TRAILS.test(layer.id)) continue;
    const paint = (layer as { paint?: Record<string, unknown> }).paint;
    if (!paint) continue;
    for (const key of Object.keys(paint)) {
      if (!COLOR_KEY.test(key)) continue;
      // Popisky necháme – jinak halo i text zblednou stejně a města zmizí.
      if (key === "text-color" || key === "text-halo-color") continue;
      paint[key] = fadeColorValue(paint[key], desaturate, blend, target);
    }
    // Reliéf jinak přebije oblačnost i po ztlumení barev.
    if (paint["hillshade-exaggeration"] != null) {
      paint["hillshade-exaggeration"] = scaleNumeric(
        paint["hillshade-exaggeration"],
        0.55,
      );
    }
  }
  return faded;
}
