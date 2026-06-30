import { useState, type ReactNode } from "react";
import type { DailyPoint } from "../types";
import type { AirQuality, LevelTier } from "../lib/airQuality";
import { aqiLabel, pmLevel, pollenLevel } from "../lib/airQuality";
import { clockTime } from "../lib/format";
import { tr } from "../lib/i18n";

interface Props {
  day: DailyPoint;
  air: AirQuality | null;
  date: string;
}

// Barevná pilulka s úrovní (dobré/špatné) – sdílené barvy přes .lvl-{tier}.
function LevelPill({ tier, text }: { tier: LevelTier; text: string }) {
  return <span className={`lvl-pill lvl-${tier}`}>{tr(text)}</span>;
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

function daylight(sunrise: string, sunset: string): string {
  const ms = new Date(sunset).getTime() - new Date(sunrise).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return `${h} h ${m} min`;
}

export default function DayDetails({ day, air, date }: Props) {
  const [open, setOpen] = useState(false);
  const uv = uvInfo(day.uvIndexMax);
  const aqi = air ? aqiLabel(air.aqi) : null;
  const pm = air ? pmLevel(air.pm25, air.pm10) : null;
  const moon = moonInfo(date);

  return (
    <section className="card details-card">
      <button
        type="button"
        className={`details-head ${open ? "open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="details-title">{tr("Další detaily")}</span>
        {open && (
          <span className="details-peek">
            <span title={tr("Délka dne")}>
              ☀ {daylight(day.sunrise, day.sunset)}
            </span>
            <span className="details-peek-uv" title={tr("UV index")}>
              <span className={`lvl-dot lvl-${uv.tier}`} />
              UV {Math.round(day.uvIndexMax)}
            </span>
            {aqi && (
              <span
                className={`aqi-pill aqi-${aqi.tier}`}
                title={tr("Kvalita ovzduší")}
              >
                {tr(aqi.text)}
              </span>
            )}
          </span>
        )}
        <Chevron open={open} />
      </button>

      {open && (
        <div className="details-body">
          <div className="dd-group-title">{tr("Slunce a Měsíc")}</div>
          <div className="dd-grid">
            <Tile icon="sunrise" label={tr("Východ / západ")}>
              <span className="dd-tile-value">
                {clockTime(new Date(day.sunrise))}
                <em className="dd-tile-sep"> / </em>
                {clockTime(new Date(day.sunset))}
              </span>
            </Tile>
            <Tile icon="daylight" label={tr("Délka dne")}>
              <span className="dd-tile-value">
                {daylight(day.sunrise, day.sunset)}
              </span>
            </Tile>
            <Tile emoji={moon.emoji} label={tr("Měsíc")}>
              <span className="dd-tile-value dd-tile-value-sm">
                {tr(moon.name)}
              </span>
              <span className="dd-tile-note">
                {tr("osvětlení {n} %", { n: moon.illum })}
              </span>
            </Tile>
          </div>

          <div className="dd-group-title">{tr("Ovzduší a UV")}</div>
          <div className="dd-grid">
            <Tile icon="uv" label={tr("UV index")}>
              <div className="dd-tile-main">
                <span className="dd-tile-value">
                  {Math.round(day.uvIndexMax)}
                </span>
                <LevelPill tier={uv.tier} text={uv.level} />
              </div>
              <span className="dd-tile-note">{uv.note}</span>
            </Tile>

            {aqi && (
              <Tile icon="air" label={tr("Kvalita ovzduší")}>
                <div className="dd-tile-main">
                  <span className="dd-tile-value">AQI {air!.aqi}</span>
                  <LevelPill tier={aqi.tier} text={aqi.text} />
                </div>
              </Tile>
            )}

            {pm && (
              <Tile icon="dust" label={tr("Prach")}>
                <div className="dd-tile-main">
                  <span className="dd-tile-value dd-tile-value-sm">
                    {air!.pm25} / {air!.pm10}
                    <em className="dd-tile-unit"> µg/m³</em>
                  </span>
                  <LevelPill tier={pm.tier} text={pm.text} />
                </div>
                <span className="dd-tile-note">PM2.5 / PM10</span>
              </Tile>
            )}

            {air &&
              air.pollen.map((p) => {
                const lvl = pollenLevel(p.kind, p.value);
                return (
                  <Tile icon="pollen" label={tr(p.label)} key={p.kind}>
                    <div className="dd-tile-main">
                      <LevelPill tier={lvl.tier} text={lvl.text} />
                    </div>
                  </Tile>
                );
              })}
          </div>
        </div>
      )}
    </section>
  );
}

function Tile({
  icon,
  emoji,
  label,
  children,
}: {
  icon?: DetailIconKind;
  emoji?: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="dd-tile">
      <span className="dd-tile-ico" aria-hidden="true">
        {emoji ? emoji : icon ? <DetailIcon kind={icon} /> : null}
      </span>
      <div className="dd-tile-body">
        <span className="dd-tile-label">{label}</span>
        {children}
      </div>
    </div>
  );
}

type DetailIconKind = "sunrise" | "daylight" | "uv" | "air" | "dust" | "pollen";

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
