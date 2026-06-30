import { useState } from "react";
import type { DailyPoint } from "../types";
import type { AirQuality } from "../lib/airQuality";
import { aqiLabel, pollenLevel } from "../lib/airQuality";
import { clockTime } from "../lib/format";

interface Props {
  day: DailyPoint;
  air: AirQuality | null;
}

function uvInfo(uv: number): { level: string; note: string } {
  if (uv < 3) return { level: "nízký", note: "Krém netřeba." };
  if (uv < 6)
    return { level: "střední", note: "Při delším pobytu venku SPF 30." };
  if (uv < 8)
    return { level: "vysoký", note: "Krém SPF 30+, brýle, stín v poledne." };
  if (uv < 11)
    return {
      level: "velmi vysoký",
      note: "Vyhni se slunci 11–15 h, krém SPF 50.",
    };
  return { level: "extrémní", note: "Omez pobyt na slunci na minimum." };
}

function daylight(sunrise: string, sunset: string): string {
  const ms = new Date(sunset).getTime() - new Date(sunrise).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return `${h} h ${m} min`;
}

export default function DayDetails({ day, air }: Props) {
  const [open, setOpen] = useState(false);
  const uv = uvInfo(day.uvIndexMax);
  const aqi = air ? aqiLabel(air.aqi) : null;

  return (
    <section className="card details-card">
      <button
        type="button"
        className={`details-head ${open ? "open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="details-title">Další detaily</span>
        <span className="details-peek">
          <span title="Délka dne">
            ☀ {daylight(day.sunrise, day.sunset)}
          </span>
          <span title="UV index">UV {Math.round(day.uvIndexMax)}</span>
          {aqi && (
            <span className={`aqi-pill aqi-${aqi.tier}`} title="Kvalita ovzduší">
              {aqi.text}
            </span>
          )}
        </span>
        <Chevron open={open} />
      </button>

      {open && (
        <div className="details-body">
          <div className="detail-row">
            <span className="detail-k">Východ / západ slunce</span>
            <span className="detail-v">
              {clockTime(new Date(day.sunrise))} / {clockTime(new Date(day.sunset))}
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-k">Délka dne</span>
            <span className="detail-v">{daylight(day.sunrise, day.sunset)}</span>
          </div>
          <div className="detail-row">
            <span className="detail-k">UV index (max)</span>
            <span className="detail-v">
              {Math.round(day.uvIndexMax)} · {uv.level}
              <em className="detail-note">{uv.note}</em>
            </span>
          </div>

          {air && (
            <>
              <div className="detail-row">
                <span className="detail-k">Kvalita ovzduší</span>
                <span className="detail-v">
                  {aqi && (
                    <span className={`aqi-pill aqi-${aqi.tier}`}>{aqi.text}</span>
                  )}{" "}
                  AQI {air.aqi}
                </span>
              </div>
              <div className="detail-row">
                <span className="detail-k">Prach (PM2.5 / PM10)</span>
                <span className="detail-v">
                  {air.pm25} / {air.pm10} µg/m³
                </span>
              </div>
              {air.pollen.length > 0 && (
                <div className="detail-row">
                  <span className="detail-k">Pyl</span>
                  <span className="detail-v">
                    {air.pollen
                      .map(
                        (p) =>
                          `${p.label}: ${pollenLevel(p.kind, p.value)}`,
                      )
                      .join(" · ")}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
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
