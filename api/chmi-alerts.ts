import type { IncomingMessage, ServerResponse } from "node:http";

// Výstrahy ČHMÚ (SIVS) z CAP XML na opendata.chmi.cz. ČHMÚ neposílá CORS a XML
// má ~2 MB, proto parsujeme serverless a klientovi vracíme kompaktní JSON jen
// pro jeho kraj. Území ČHMÚ kóduje po ORP (CISORP) seskupených do krajů; přesné
// ORP hranice offline nemáme, takže shodu děláme na úrovni kraje podle areaDesc
// (kraj zjistíme reverzním geokódováním lat/lon). Coarse, ale spolehlivé.

const DIR = "https://opendata.chmi.cz/meteorology/weather/alerts/cap/";
const REVERSE_URL =
  "https://api.bigdatacloud.net/data/reverse-geocode-client";
const FETCH_HEADERS = {
  "User-Agent": "zmoknu/1.0 (+https://zmoknu.vercel.app)",
};

// Kraj v rámci pokrytí ČHMÚ (hrubý bounding box ČR).
function inCz(lat: number, lon: number): boolean {
  return lat >= 48.0 && lat <= 51.2 && lon >= 11.8 && lon <= 19.0;
}

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// Kanonické „tokeny" krajů, kterými párujeme uživatelovu polohu s areaDesc.
const KRAJ_TOKENS = [
  "praha",
  "stredocesky",
  "jihocesky",
  "plzensky",
  "karlovarsky",
  "ustecky",
  "liberecky",
  "kralovehradecky",
  "pardubicky",
  "vysocina",
  "jihomoravsky",
  "olomoucky",
  "zlinsky",
  "moravskoslezsky",
];

function krajToken(subdivision: string): string | null {
  const n = norm(subdivision);
  for (const t of KRAJ_TOKENS) if (n.includes(t)) return t;
  return null;
}

interface Alert {
  event: string;
  eventEn: string;
  level: number; // 1–4
  color: string; // green/yellow/orange/red
  type: string; // awareness_type text
  onset: string;
  expires: string;
  description: string;
  descriptionEn: string;
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : "";
}
function param(block: string, name: string): string {
  const m = block.match(
    new RegExp(
      `<valueName>${name}</valueName>\\s*<value>([\\s\\S]*?)</value>`,
    ),
  );
  return m ? m[1].trim() : "";
}
const COLOR_BY_LEVEL: Record<number, string> = {
  1: "green",
  2: "yellow",
  3: "orange",
  4: "red",
};

// ---- cache nejnovějšího souboru + jeho zparsovaných výstrah -----------------
let cache:
  | { at: number; file: string; cs: ParsedInfo[]; en: Map<string, ParsedInfo> }
  | null = null;
const TTL = 5 * 60 * 1000;

interface ParsedInfo {
  event: string;
  level: number;
  type: string;
  onset: string;
  expires: string;
  description: string;
  areas: string[]; // normalizované areaDesc
}

async function newestFileUrl(): Promise<string | null> {
  const res = await fetch(DIR, { headers: FETCH_HEADERS });
  if (!res.ok) return null;
  const html = await res.text();
  const re =
    /(alert_cap_50_\d+\.xml)<\/a>\s+(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2})/g;
  const months: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  let best: { name: string; ts: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const ts = Date.UTC(+m[4], months[m[3]] ?? 0, +m[2], +m[5], +m[6]);
    if (!best || ts > best.ts) best = { name: m[1], ts };
  }
  return best ? DIR + best.name : null;
}

function parseInfos(xml: string): { cs: ParsedInfo[]; en: Map<string, ParsedInfo> } {
  const blocks = xml.match(/<info>[\s\S]*?<\/info>/g) ?? [];
  const cs: ParsedInfo[] = [];
  const en = new Map<string, ParsedInfo>();
  for (const b of blocks) {
    const level = parseInt(param(b, "awareness_level"), 10);
    if (!Number.isFinite(level) || level < 2) continue; // jen skutečné výstrahy
    const lang = tag(b, "language");
    const areas = (b.match(/<areaDesc>([\s\S]*?)<\/areaDesc>/g) ?? []).map((a) =>
      norm(a.replace(/<\/?areaDesc>/g, "")),
    );
    const info: ParsedInfo = {
      event: tag(b, "event"),
      level,
      type: param(b, "awareness_type"),
      onset: tag(b, "onset"),
      expires: param(b, "eventEndingTime") || tag(b, "expires"),
      description: tag(b, "description"),
      areas,
    };
    if (lang.toLowerCase().startsWith("cs")) cs.push(info);
    else en.set(`${info.type}|${info.onset}`, info);
  }
  return { cs, en };
}

async function loadAlerts(): Promise<typeof cache> {
  if (cache && Date.now() - cache.at < TTL) return cache;
  const file = await newestFileUrl();
  if (!file) return null;
  const res = await fetch(file, { headers: FETCH_HEADERS });
  if (!res.ok) return null;
  const xml = await res.text();
  const { cs, en } = parseInfos(xml);
  cache = { at: Date.now(), file, cs, en };
  return cache;
}

async function reverseKraj(lat: number, lon: number): Promise<string | null> {
  try {
    const u = `${REVERSE_URL}?latitude=${lat}&longitude=${lon}&localityLanguage=cs`;
    const res = await fetch(u, { headers: FETCH_HEADERS });
    if (!res.ok) return null;
    const d = (await res.json()) as { principalSubdivision?: string };
    return d.principalSubdivision ?? null;
  } catch {
    return null;
  }
}

export const config = { maxDuration: 30 };

export default async function handler(
  req: IncomingMessage & { url?: string },
  res: ServerResponse,
) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method && req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.end("[]");
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));

  const send = (body: unknown, sMaxAge = 300) => {
    res.statusCode = 200;
    res.setHeader("Cache-Control", `public, max-age=60, s-maxage=${sMaxAge}`);
    res.end(JSON.stringify(body));
  };

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !inCz(lat, lon)) {
    send({ region: null, alerts: [] });
    return;
  }

  try {
    const subdivision = await reverseKraj(lat, lon);
    const token = subdivision ? krajToken(subdivision) : null;
    if (!token) {
      send({ region: subdivision, alerts: [] });
      return;
    }

    const data = await loadAlerts();
    if (!data) {
      res.statusCode = 502;
      res.end(JSON.stringify({ region: subdivision, alerts: [], error: "no data" }));
      return;
    }

    const seen = new Set<string>();
    const alerts: Alert[] = [];
    for (const info of data.cs) {
      if (!info.areas.some((a) => a.includes(token))) continue;
      const key = `${info.event}|${info.level}|${info.onset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const enInfo = data.en.get(`${info.type}|${info.onset}`);
      alerts.push({
        event: info.event,
        eventEn: enInfo?.event ?? info.event,
        level: info.level,
        color: COLOR_BY_LEVEL[info.level] ?? "yellow",
        type: info.type,
        onset: info.onset,
        expires: info.expires,
        description: info.description,
        descriptionEn: enInfo?.description ?? info.description,
      });
    }
    alerts.sort((a, b) => b.level - a.level);
    send({ region: subdivision, alerts });
  } catch (err) {
    res.statusCode = 502;
    res.end(
      JSON.stringify({ alerts: [], error: err instanceof Error ? err.message : String(err) }),
    );
  }
}
