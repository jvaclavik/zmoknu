// Klient pro webkamery v okolí (viz api/webcams.ts). Chyby polkne → prázdno.

import { getLang } from "./i18n";

export interface Webcam {
  id: number;
  title: string;
  city: string;
  country: string;
  lat: number | null;
  lon: number | null;
  distanceKm: number | null;
  preview: string | null;
  thumbnail: string | null;
  dayEmbed: string | null;
  liveEmbed: string | null;
  detailUrl: string | null;
  updatedAt: string | null;
  live: boolean;
}

export async function fetchWebcams(
  lat: number,
  lon: number,
  radiusKm = 50,
  limit = 12,
): Promise<Webcam[]> {
  try {
    const res = await fetch(
      `/api/webcams?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}` +
        `&radius=${radiusKm}&limit=${limit}&lang=${getLang()}`,
    );
    if (!res.ok) return [];
    const d = (await res.json()) as { webcams?: Webcam[] };
    return Array.isArray(d.webcams) ? d.webcams : [];
  } catch {
    return [];
  }
}
