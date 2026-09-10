import { buildChmiRadar, isInChmiCoverage } from "./chmi";
import { tr } from "./i18n";
import {
  echoAtLatLon,
  estimateRadarMotion,
  unshiftLatLon,
  type RadarMotion,
} from "./radarMotion";

export type LocalPrecip =
  | { kind: "now"; weight: number }
  | { kind: "soon"; minutes: number }
  | { kind: "dry" };

const ETA_STEPS = [10, 20, 30, 40, 50, 60];

export async function localPrecipFromFrame(
  lat: number,
  lon: number,
  frameUrl: string,
  motion: RadarMotion | null,
): Promise<LocalPrecip | null> {
  const nowW = await echoAtLatLon(frameUrl, lat, lon);
  if (nowW == null) return null;
  if (nowW > 0) return { kind: "now", weight: nowW };
  if (!motion) return { kind: "dry" };
  for (const minutes of ETA_STEPS) {
    const p = unshiftLatLon(lat, lon, motion, minutes);
    const w = await echoAtLatLon(frameUrl, p.lat, p.lon);
    if (w != null && w > 0) return { kind: "soon", minutes };
  }
  return { kind: "dry" };
}

export async function fetchLocalChmiPrecip(
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<LocalPrecip | null> {
  if (!isInChmiCoverage(lat, lon)) return null;
  const newest = [...buildChmiRadar(3).frames].reverse();
  if (!newest.length) return null;
  if (signal?.aborted) return null;
  const motion = await estimateRadarMotion(newest.slice(0, 4));
  if (signal?.aborted) return null;
  for (const f of newest.slice(0, 4)) {
    if (signal?.aborted) return null;
    const hit = await localPrecipFromFrame(lat, lon, f.path, motion);
    if (hit) return hit;
  }
  return null;
}

export function localPrecipText(p: LocalPrecip): string {
  if (p.kind === "now") return tr("U tebe teď prší");
  if (p.kind === "soon") return tr("Déšť u tebe za ~{n} min", { n: p.minutes });
  return tr("U tebe bez srážek");
}
