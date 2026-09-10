import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { DailyPoint, HourlyPoint } from "../types";
import type { AirQuality, LevelTier } from "../lib/airQuality";
import { aqiLabel, pmLevel, pollenLevel } from "../lib/airQuality";
import { stormRiskForDate } from "../lib/storm";
import { skyQuality } from "../lib/skyEvents";
import { fetchFlood, floodRisk, type FloodData } from "../lib/flood";
import { clockTime, locDate } from "../lib/format";
import { tr } from "../lib/i18n";

interface Props {
  day: DailyPoint;
  air: AirQuality | null;
  date: string;
  lat?: number;
  lon?: number;
  hourly?: HourlyPoint[];
}

// Délka dne (h) pro daný den v roce a zeměpisnou šířku – čistě astronomicky,
// bez API. Deklinace přibližně dle Cooperovy formule, hodinový úhel z acos.
function daylightHours(lat: number, doy: number): number {
  const latRad = (lat * Math.PI) / 180;
  const decl =
    ((-23.44 * Math.PI) / 180) * Math.cos((2 * Math.PI * (doy + 10)) / 365);
  // Standardní výška Slunce při východu/západu (−0,833°: refrakce + poloměr disku),
  // aby délka dne odpovídala času východu/západu z API, ne jen geometrii.
  const alt0 = (-0.833 * Math.PI) / 180;
  const cosH =
    (Math.sin(alt0) - Math.sin(latRad) * Math.sin(decl)) /
    (Math.cos(latRad) * Math.cos(decl));
  if (cosH <= -1) return 24; // polární den
  if (cosH >= 1) return 0; // polární noc
  return (24 * Math.acos(cosH)) / Math.PI;
}

// Sluneční deklinace (rad) pro den v roce – Cooperova formule.
function solarDecl(doy: number): number {
  return ((-23.44 * Math.PI) / 180) * Math.cos((2 * Math.PI * (doy + 10)) / 365);
}

// Hodiny od pravého poledne, kdy je Slunce ve výšce altDeg (null = nenastane).
function hoursFromNoon(lat: number, decl: number, altDeg: number): number | null {
  const latR = (lat * Math.PI) / 180;
  const altR = (altDeg * Math.PI) / 180;
  const cosH =
    (Math.sin(altR) - Math.sin(latR) * Math.sin(decl)) /
    (Math.cos(latR) * Math.cos(decl));
  if (cosH <= -1 || cosH >= 1) return null;
  return (Math.acos(cosH) * 12) / Math.PI;
}

// Délka zlaté hodinky (min): jak dlouho trvá, než Slunce vystoupá z obzoru
// (−0,833°) na 6° nad obzorem. Symetricky platí i pro večer před západem.
function goldenHourMinutes(lat: number, doy: number): number {
  const decl = solarDecl(doy);
  const hRise = hoursFromNoon(lat, decl, -0.833);
  const h6 = hoursFromNoon(lat, decl, 6);
  if (hRise == null || h6 == null) return 50; // polární oblasti → fallback
  const min = (hRise - h6) * 60;
  return Math.max(10, Math.min(180, min));
}

// Den v roce (1–366) z ISO data.
function dayOfYear(iso: string): number {
  const d = new Date(`${iso}T12:00:00`);
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86_400_000);
}

function uvInfo(uv: number): { level: string; note: string; tier: LevelTier } {
  if (uv < 3)
    return { level: "nízký", note: tr("Krém netřeba."), tier: "good" };
  if (uv < 6)
    return {
      level: "střední",
      note: tr("Při delším pobytu venku SPF 30."),
      tier: "moderate",
    };
  if (uv < 8)
    return {
      level: "vysoký",
      note: tr("Krém SPF 30+, brýle, stín v poledne."),
      tier: "poor",
    };
  if (uv < 11)
    return {
      level: "velmi vysoký",
      note: tr("Vyhni se slunci 11–15 h, krém SPF 50."),
      tier: "verypoor",
    };
  return {
    level: "extrémní",
    note: tr("Omez pobyt na slunci na minimum."),
    tier: "extreme",
  };
}

// Fáze Měsíce pro daný den (poledne) – synodický měsíc od známého novu.
function moonInfo(dateISO: string): {
  name: string;
  emoji: string;
  illum: number;
} {
  const t = new Date(`${dateISO}T12:00:00`).getTime();
  const synodic = 29.530588853;
  const ref = Date.UTC(2000, 0, 6, 18, 14, 0); // nov 6. 1. 2000
  let phase = (((t - ref) / 86_400_000) % synodic) / synodic;
  if (phase < 0) phase += 1;
  const illum = Math.round(((1 - Math.cos(2 * Math.PI * phase)) / 2) * 100);
  const phases: { name: string; emoji: string }[] = [
    { name: "nov", emoji: "🌑" },
    { name: "dorůstající srpek", emoji: "🌒" },
    { name: "první čtvrť", emoji: "🌓" },
    { name: "dorůstající měsíc", emoji: "🌔" },
    { name: "úplněk", emoji: "🌕" },
    { name: "couvající měsíc", emoji: "🌖" },
    { name: "poslední čtvrť", emoji: "🌗" },
    { name: "couvající srpek", emoji: "🌘" },
  ];
  const idx = Math.round(phase * 8) % 8;
  return { ...phases[idx], illum };
}

// Krátké datum "D. M." z ISO řetězce (pro popisek vrcholu průtoku).
function shortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return `${d.getDate()}. ${d.getMonth() + 1}.`;
}

function daylight(sunrise: string, sunset: string): string {
  const ms = new Date(sunset).getTime() - new Date(sunrise).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return `${h} h ${m} min`;
}

export default function DayDetails({
  day,
  air,
  date,
  lat,
  lon,
  hourly,
}: Props) {
  const [open, setOpen] = useState(false);
  const uv = uvInfo(day.uvIndexMax);
  const aqi = air ? aqiLabel(air.aqi) : null;
  const pm = air ? pmLevel(air.pm25, air.pm10) : null;
  const moon = moonInfo(date);

  // Riziko povodní (GloFAS) – načteme až při rozbalení detailů, ať zbytečně
  // netáhneme data. Výsledek je cachovaný podle polohy napříč dny.
  const [flood, setFlood] = useState<FloodData | null>(null);
  useEffect(() => {
    if (!open || lat == null || lon == null) return;
    let alive = true;
    fetchFlood(lat, lon).then((d) => {
      if (alive) setFlood(d);
    });
    return () => {
      alive = false;
    };
  }, [open, lat, lon]);

  const floodInfo = useMemo(() => {
    if (!flood) return null;
    const q = flood.byDate.get(date);
    if (q == null) return null;
    return { q, risk: floodRisk(q, flood.thresholds) };
  }, [flood, date]);

  // Zlatá hodinka: ráno od východu, večer do západu.
  const sunriseD = locDate(day.sunrise);
  const sunsetD = locDate(day.sunset);
  const goldenMin = goldenHourMinutes(lat ?? 50, dayOfYear(date));
  const goldenAmEnd = new Date(sunriseD.getTime() + goldenMin * 60_000);
  const goldenPmStart = new Date(sunsetD.getTime() - goldenMin * 60_000);
  const goldenOk =
    Number.isFinite(sunriseD.getTime()) &&
    Number.isFinite(sunsetD.getTime()) &&
    goldenPmStart.getTime() > goldenAmEnd.getTime();

  const storm =
    hourly && hourly.length ? stormRiskForDate(hourly, date) : null;

  // Barvy oblohy při západu (a šance na duhu) – čistě z oblačnosti po patrech.
  const sky = useMemo(
    () =>
      hourly && hourly.length
        ? skyQuality(hourly, day.sunrise, day.sunset)
        : null,
    [hourly, day.sunrise, day.sunset],
  );
  const rainbow = useMemo(() => {
    if (!sky) return null;
    const cands = [sky.sunset, sky.sunrise].filter(
      (s): s is NonNullable<typeof s> => !!s,
    );
    let best: (typeof cands)[number] | null = null;
    for (const c of cands) if (!best || c.rainbow > best.rainbow) best = c;
    return best && best.rainbow >= 0.35 ? best : null;
  }, [sky]);

  const pollen =
    air && air.pollen.length > 0 ? pollenSummary(air.pollen) : null;

  return (
    <section className="card details-card">
      <button
        type="button"
        className={`details-head ${open ? "open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="details-title">{tr("Další detaily")}</span>
        <Chevron open={open} />
      </button>

      {open && (
        <div className="details-body">
          <div className="dd-grid">
            <Tile
              icon="sunrise"
              label={tr("Východ / západ")}
              value={
                <>
                  {clockTime(sunriseD)}
                  <em className="dd-tile-sep"> / </em>
                  {clockTime(sunsetD)}
                </>
              }
            />
            {lat != null && (
              <Tile
                icon="daylight"
                label={tr("Délka dne")}
                value={daylight(day.sunrise, day.sunset)}
                note={daylightTrend(lat, date)}
              />
            )}
            <Tile
              emoji={moon.emoji}
              label={tr("Měsíc")}
              value={tr(moon.name)}
              note={tr("osvětlení {n} %", { n: moon.illum })}
            />
            {goldenOk && (
              <Tile
                icon="golden"
                label={tr("Zlatá hodinka")}
                value={`${clockTime(sunriseD)}–${clockTime(goldenAmEnd)}`}
                note={`${tr("večer")} ${clockTime(goldenPmStart)}–${clockTime(sunsetD)}`}
              />
            )}
            {sky?.sunset && (
              <Tile
                icon="sunset"
                label={tr("Barvy západu")}
                value={tr(sky.sunset.label)}
                note={
                  rainbow
                    ? rainbow.kind === "sunrise"
                      ? tr("šance na duhu ráno")
                      : tr("šance na duhu večer")
                    : String(sky.sunset.score)
                }
                title={
                  rainbow
                    ? `${tr(sky.sunset.label)} · ${sky.sunset.score}`
                    : undefined
                }
              />
            )}
            <Tile
              icon="uv"
              label={tr("UV index")}
              value={Math.round(day.uvIndexMax)}
              note={tr(uv.level)}
              tone={uv.tier}
              toneOn="note"
              title={uv.note}
            />
            {aqi && air && (
              <Tile
                icon="air"
                label={tr("Kvalita ovzduší")}
                value={tr(aqi.text)}
                note={`AQI ${air.aqi}`}
                tone={aqi.tier}
              />
            )}
            {pm && (
              <Tile
                icon="dust"
                label={tr("Prach")}
                value={
                  <>
                    {air!.pm25}
                    <em className="dd-tile-sep"> / </em>
                    {air!.pm10}
                  </>
                }
                note="PM2.5 / PM10"
              />
            )}
            {pollen && air && (
              <Tile
                icon="pollen"
                label={tr("Pyl")}
                value={tr(pollen.text)}
                note={air.pollen.map((p) => tr(p.label)).join(" · ")}
                tone={pollen.tier}
              />
            )}
            {storm && (
              <Tile
                icon="storm"
                label={tr("Riziko bouřek")}
                className={storm.level === "high" ? "dd-tile-alert" : ""}
                value={tr(storm.label)}
                tone={storm.tier}
                note={
                  storm.from
                    ? `${tr("mezi {a} a {b}", {
                        a: clockTime(locDate(storm.from)),
                        b: clockTime(
                          new Date(locDate(storm.to!).getTime() + 3_600_000),
                        ),
                      })}${storm.hail ? ` · ${tr("možné kroupy")}` : ""}`
                    : storm.maxCape > 0
                      ? tr("energie CAPE {n} J/kg", {
                          n: Math.round(storm.maxCape),
                        })
                      : undefined
                }
              />
            )}
            {floodInfo && flood && (
              <Tile
                icon="flood"
                label={tr("Riziko povodní")}
                className={floodInfo.risk.alert ? "dd-tile-alert" : ""}
                value={tr(floodInfo.risk.label)}
                tone={floodInfo.risk.tier}
                note={
                  flood.peakDate !== date &&
                  flood.peakValue >= flood.thresholds.p90
                    ? tr("vrchol {d}: {n} m³/s", {
                        d: shortDate(flood.peakDate),
                        n: flood.peakValue.toFixed(1),
                      })
                    : `${floodInfo.q.toFixed(1)} m³/s`
                }
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function daylightTrend(lat: number, date: string): string {
  const DAYS = 365;
  const vals = Array.from({ length: DAYS }, (_, i) => daylightHours(lat, i + 1));
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const idx = Math.max(0, Math.min(DAYS - 1, dayOfYear(date) - 1));
  const prev = vals[Math.max(0, idx - 1)];
  const next = vals[Math.min(DAYS - 1, idx + 1)];
  const deltaMin = Math.round(((next - prev) / 2) * 60);
  if (deltaMin > 0) return tr("prodlužuje se o {n} min/den", { n: deltaMin });
  if (deltaMin < 0) return tr("zkracuje se o {n} min/den", { n: -deltaMin });
  return vals[idx] > (lo + hi) / 2
    ? tr("nejdelší den v roce")
    : tr("nejkratší den v roce");
}

const TIER_RANK: Record<LevelTier, number> = {
  good: 0,
  fair: 1,
  moderate: 2,
  poor: 3,
  verypoor: 4,
  extreme: 5,
};

function pollenSummary(items: AirQuality["pollen"]): {
  text: string;
  tier: LevelTier;
} {
  let best = pollenLevel(items[0].kind, items[0].value);
  for (const p of items) {
    const lvl = pollenLevel(p.kind, p.value);
    if (TIER_RANK[lvl.tier] > TIER_RANK[best.tier]) best = lvl;
  }
  return best;
}

function Tile({
  icon,
  emoji,
  label,
  value,
  note,
  tone,
  toneOn,
  className,
  title,
}: {
  icon?: DetailIconKind;
  emoji?: string;
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: LevelTier;
  toneOn?: "value" | "note";
  className?: string;
  title?: string;
}) {
  return (
    <div className={`dd-tile${className ? ` ${className}` : ""}`} title={title}>
      <span className="dd-tile-label">
        <span className="dd-tile-ico" aria-hidden="true">
          {emoji ? emoji : icon ? <DetailIcon kind={icon} /> : null}
        </span>
        {label}
      </span>
      <span
        className={`dd-tile-value${tone && toneOn !== "note" ? ` dd-tone-${tone}` : ""}`}
      >
        {value}
      </span>
      <span
        className={`dd-tile-note${tone && toneOn === "note" ? ` dd-tone-${tone}` : ""}`}
      >
        {note ?? "\u00a0"}
      </span>
    </div>
  );
}

type DetailIconKind =
  | "sunrise"
  | "sunset"
  | "daylight"
  | "uv"
  | "air"
  | "dust"
  | "pollen"
  | "golden"
  | "storm"
  | "flood";

function DetailIcon({ kind }: { kind: DetailIconKind }) {
  const c = {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "sunrise":
      return (
        <svg {...c}>
          <path d="M3 18h18M6 18a6 6 0 0 1 12 0" />
          <path d="M12 3v4M5 8l1.5 1.5M19 8l-1.5 1.5" />
        </svg>
      );
    case "sunset":
      return (
        <svg {...c}>
          <path d="M3 18h18M6 18a6 6 0 0 1 12 0" />
          <path d="M12 11V7M5 8l1.5 1.5M19 8l-1.5 1.5" />
        </svg>
      );
    case "daylight":
      return (
        <svg {...c}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
        </svg>
      );
    case "uv":
      return (
        <svg {...c}>
          <circle cx="12" cy="12" r="3.5" />
          <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6" />
        </svg>
      );
    case "air":
      return (
        <svg {...c}>
          <path d="M3 9h11a2.5 2.5 0 1 0-2.5-2.5" />
          <path d="M3 14h14a2.5 2.5 0 1 1-2.5 2.5" />
          <path d="M3 19h8" />
        </svg>
      );
    case "dust":
      return (
        <svg {...c}>
          <circle cx="7" cy="8" r="1.4" />
          <circle cx="14" cy="6" r="1.4" />
          <circle cx="17" cy="12" r="1.4" />
          <circle cx="9" cy="14" r="1.4" />
          <circle cx="15" cy="17" r="1.4" />
          <circle cx="6" cy="18" r="1.4" />
        </svg>
      );
    case "pollen":
      return (
        <svg {...c}>
          <circle cx="12" cy="12" r="2.2" />
          <path d="M12 12c0-4-4-6-4-6s0 4 4 6zM12 12c0-4 4-6 4-6s0 4-4 6zM12 12c4 0 6 4 6 4s-4 0-6-4zM12 12c-4 0-6 4-6 4s4 0 6-4z" />
        </svg>
      );
    case "golden":
      return (
        <svg {...c}>
          <circle cx="12" cy="9" r="3.5" />
          <path d="M12 2.5v1.6M4.8 9H3.2M20.8 9h-1.6M6.4 3.4l1.1 1.1M17.6 3.4l-1.1 1.1" />
          <path d="M3 18h18M3 21h18" />
        </svg>
      );
    case "storm":
      return (
        <svg {...c}>
          <path d="M7 16a4 4 0 0 1 .5-7.97 5.5 5.5 0 0 1 10.6 1.02A3.5 3.5 0 0 1 17.5 16" />
          <path d="M12.5 12l-2.5 4h3l-2 4" />
        </svg>
      );
    case "flood":
      return (
        <svg {...c}>
          <path d="M12 3s5 5.5 5 9a5 5 0 0 1-10 0c0-3.5 5-9 5-9z" />
          <path d="M3 19c1.5 0 1.5-1.2 3-1.2s1.5 1.2 3 1.2 1.5-1.2 3-1.2 1.5 1.2 3 1.2 1.5-1.2 3-1.2" />
        </svg>
      );
  }
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{
        transform: open ? "rotate(180deg)" : "none",
        transition: "transform 0.2s",
        flexShrink: 0,
      }}
    >
      <path
        d="M6 9l6 6 6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
