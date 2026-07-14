import type { IncomingMessage, ServerResponse } from "node:http";

// Webkamery v okolí přes Windy Webcams API v3. Klíč nepatří do klienta, proto
// voláme serverless a klientovi vracíme jen kompaktní JSON. URL obrázků jsou
// tokenované a v platnosti ~15 min (free tier), proto krátká cache.

const API_URL = "https://api.windy.com/webcams/api/v3/webcams";
// Klíč z prostředí (Vercel env / lokální shell). Bez klíče vrací prázdno.
const API_KEY =
  process.env.WINDY_WEBCAMS_KEY || process.env.WINDY_API_KEY || "";

interface WindyImage {
  current?: { icon?: string; thumbnail?: string; preview?: string };
}
// player v3 vrací přímo URL embed přehrávače jako řetězce
// (day/month/year/lifetime, u živých kamer i live).
interface WindyPlayer {
  day?: string;
  month?: string;
  year?: string;
  lifetime?: string;
  live?: string;
}
interface WindyWebcam {
  webcamId: number;
  title: string;
  status?: string;
  viewCount?: number;
  lastUpdatedOn?: string;
  images?: WindyImage;
  location?: {
    city?: string;
    region?: string;
    country?: string;
    latitude?: number;
    longitude?: number;
  };
  player?: WindyPlayer;
  urls?: { detail?: string; provider?: string };
}

interface OutWebcam {
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

function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---- krátká in-memory cache (per lat/lon/radius/lang) -----------------------
const cache = new Map<string, { at: number; data: OutWebcam[] }>();
const TTL = 10 * 60 * 1000; // < 15 min platnost tokenů u obrázků

export const config = { maxDuration: 15 };

export default async function handler(
  req: IncomingMessage & { url?: string },
  res: ServerResponse,
) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method && req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.end(JSON.stringify({ webcams: [] }));
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  const radius = Math.min(
    250,
    Math.max(1, Number(url.searchParams.get("radius")) || 50),
  );
  const limit = Math.min(
    50,
    Math.max(1, Number(url.searchParams.get("limit")) || 12),
  );
  const lang = (url.searchParams.get("lang") || "en").toLowerCase().startsWith(
    "cs",
  )
    ? "cs"
    : "en";

  const send = (body: unknown, sMaxAge = 600) => {
    res.statusCode = 200;
    res.setHeader("Cache-Control", `public, max-age=300, s-maxage=${sMaxAge}`);
    res.end(JSON.stringify(body));
  };

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    send({ webcams: [] });
    return;
  }
  if (!API_KEY) {
    // Bez klíče se feature tiše vypne (klient nic nevykreslí).
    send({ webcams: [], configured: false });
    return;
  }

  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${radius},${limit},${lang}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) {
    send({ webcams: hit.data, configured: true });
    return;
  }

  try {
    const api = new URL(API_URL);
    api.searchParams.set("nearby", `${lat},${lon},${radius}`);
    api.searchParams.set("include", "images,location,player,urls");
    api.searchParams.set("lang", lang);
    api.searchParams.set("limit", String(limit));

    const r = await fetch(api.toString(), {
      headers: { "x-windy-api-key": API_KEY },
    });
    if (!r.ok) {
      res.statusCode = 502;
      res.end(JSON.stringify({ webcams: [], error: `windy ${r.status}` }));
      return;
    }
    const json = (await r.json()) as { webcams?: WindyWebcam[] };
    const list = Array.isArray(json.webcams) ? json.webcams : [];

    const out: OutWebcam[] = list
      .filter((w) => (w.status ? w.status === "active" : true))
      .map((w) => {
        const wlat = w.location?.latitude ?? null;
        const wlon = w.location?.longitude ?? null;
        const dist =
          wlat != null && wlon != null
            ? haversineKm(lat, lon, wlat, wlon)
            : null;
        return {
          id: w.webcamId,
          title: w.title ?? "",
          city: w.location?.city ?? "",
          country: w.location?.country ?? "",
          lat: wlat,
          lon: wlon,
          distanceKm: dist != null ? Math.round(dist * 10) / 10 : null,
          preview: w.images?.current?.preview ?? null,
          thumbnail: w.images?.current?.thumbnail ?? null,
          dayEmbed:
            typeof w.player?.day === "string" ? w.player.day : null,
          liveEmbed:
            typeof w.player?.live === "string" ? w.player.live : null,
          detailUrl: w.urls?.detail ?? null,
          updatedAt: w.lastUpdatedOn ?? null,
          live: typeof w.player?.live === "string",
        };
      })
      .sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));

    cache.set(key, { at: Date.now(), data: out });
    send({ webcams: out, configured: true });
  } catch (err) {
    res.statusCode = 502;
    res.end(
      JSON.stringify({
        webcams: [],
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
