import type { RadarData, RadarFrame } from "../types";

const MAPS_URL = "https://api.rainviewer.com/public/weather-maps.json";

interface RawMaps {
  host: string;
  radar: {
    past: { time: number; path: string }[];
    nowcast: { time: number; path: string }[];
  };
}

export async function fetchRadar(): Promise<RadarData> {
  const res = await fetch(MAPS_URL);
  if (!res.ok) throw new Error("Nepodařilo se načíst radar.");
  const data = (await res.json()) as RawMaps;

  const past: RadarFrame[] = data.radar.past.map((f) => ({
    ...f,
    kind: "past",
  }));
  const nowcast: RadarFrame[] = data.radar.nowcast.map((f) => ({
    ...f,
    kind: "nowcast",
  }));

  const frames = [...past, ...nowcast];
  return {
    host: data.host,
    frames,
    nowcastStartIndex: past.length,
  };
}

// Sestaví URL šablonu dlaždice radaru pro Leaflet.
// color: barevné schéma (4 = Universal Blue), smooth a snow zapnuty.
export function radarTileUrl(host: string, path: string): string {
  return `${host}${path}/256/{z}/{x}/{y}/4/1_1.png`;
}
