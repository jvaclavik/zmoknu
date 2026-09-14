import type { IncomingMessage, ServerResponse } from "node:http";

// ČHMÚ opendata neposílá CORS a Vercel rewrite na cizí hostitele často
// skončí u SPA catch-all (HTML místo PNG). Proto snímky taháme serverless
// a klientovi je posíláme z /api (stejný origin).
const RADAR_DIR =
  "https://opendata.chmi.cz/meteorology/weather/radar/composite/maxz/png/";
const SAT_DIR =
  "https://opendata.chmi.cz/meteorology/weather/satellite/geo/";

const RADAR_FILE = /^pacz2gmaps3\.z_max3d\.\d{8}\.\d{4}\.0\.png$/;
const SAT_FILE = /^[a-z0-9]+\/\d{12}_geo_[a-z0-9]+_[a-z0-9]+\.jpe?g$/;

const FETCH_HEADERS = {
  "User-Agent": "zmoknu/1.0 (+https://zmoknu.vercel.app)",
  Accept: "image/png,image/jpeg,*/*",
};

export const config = { maxDuration: 15 };

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
  const kind = url.searchParams.get("kind");
  const file = url.searchParams.get("file") ?? "";

  let upstream: string | null = null;
  let contentType = "application/octet-stream";
  if (kind === "radar" && RADAR_FILE.test(file)) {
    upstream = RADAR_DIR + file;
    contentType = "image/png";
  } else if (kind === "sat" && SAT_FILE.test(file)) {
    upstream = SAT_DIR + file;
    contentType = "image/jpeg";
  }
  if (!upstream) {
    res.statusCode = 400;
    res.end("bad request");
    return;
  }

  try {
    const r = await fetch(upstream, { headers: FETCH_HEADERS });
    if (!r.ok) {
      res.statusCode = r.status === 404 ? 404 : 502;
      res.end();
      return;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.setHeader("CDN-Cache-Control", "public, s-maxage=86400, immutable");
    res.end(buf);
  } catch {
    res.statusCode = 502;
    res.end();
  }
}
