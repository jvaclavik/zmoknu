import { useEffect, useMemo, useState } from "react";
import type { HourlyPoint } from "../types";
import { describeWeather } from "../lib/weatherCodes";
import { dateKey, dayHeader, hourLabel, isoDate } from "../lib/format";
import { tempColor } from "../lib/tempColor";
import { tr } from "../lib/i18n";
import { useStoredState } from "../lib/useStoredState";
import WeatherIcon from "./WeatherIcon";

interface Props {
  hourly: HourlyPoint[];
  activeDate?: string;
  onSelectDay?: (date: string) => void;
}

interface DayIcon {
  code: number;
  isDay: boolean;
}

interface Row {
  key: string;
  iso: string;
  timeLabel: string;
  weatherCode: number;
  isDay: boolean;
  icons?: DayIcon[];
  tempMax: number;
  tempMin: number;
  grouped: boolean;
  precipitation: number;
  precipitationProbability: number;
  windSpeed: number;
  windDirection: number;
}

// Reprezentativní počasí úseku: přednostně hodina s nejvíc srážkami,
// jinak nejvýraznější (nejvyšší) kód počasí.
// Průhlednost textu srážek podle pravděpodobnosti deště (vyšší šance = sytější).
function precipOpacity(prob: number): number {
  if (prob <= 0) return 0.6; // neznámá pravděpodobnost
  return 0.3 + 0.7 * (Math.min(100, prob) / 100);
}

function pickRep(pts: HourlyPoint[]): HourlyPoint {
  let rep = pts[0];
  let bestP = -1;
  for (const p of pts) {
    if (p.precipitation > bestP) {
      bestP = p.precipitation;
      rep = p;
    }
  }
  if (bestP <= 0) {
    rep = pts.reduce((a, b) => (b.weatherCode > a.weatherCode ? b : a), pts[0]);
  }
  return rep;
}

// Kolik dní výhledu ukázat, než uživatel klikne na „Načíst další dny".
const DAY_LIMIT = 7;

export default function HourlyForecast({ hourly, activeDate, onSelectDay }: Props) {
  const [step, setStep] = useStoredState<1 | 6 | 24>("zmoknu.outlookStep", 6);
  const [expanded, setExpanded] = useState(false);

  const rows = useMemo<Row[]>(() => {
    // Výchozí start = dnešek. Včerejšek (a starší) ukážeme jen tehdy, když je
    // vybrán den v minulosti – při vybraném dnešku už včerejšek nezobrazujeme.
    const todayStr = isoDate(new Date());
    const base = activeDate && activeDate < todayStr ? activeDate : todayStr;
    let startIdx = hourly.findIndex((h) => h.time.slice(0, 10) >= base);
    if (startIdx === -1) startIdx = 0;
    const rangeHours = step === 24 ? 24 * 25 : step === 6 ? 24 * 12 : 24 * 4;
    const slice = hourly.slice(startIdx, startIdx + rangeHours);

    if (step === 1) {
      return slice.map((p) => ({
        key: p.time,
        iso: p.time,
        timeLabel: hourLabel(p.time),
        weatherCode: p.weatherCode,
        isDay: p.isDay,
        tempMax: p.temperature,
        tempMin: p.temperature,
        grouped: false,
        precipitation: p.precipitation,
        precipitationProbability: p.precipitationProbability,
        windSpeed: p.windSpeed,
        windDirection: p.windDirection,
      }));
    }

    // Seskupení do bloků (6 h, nebo celý kalendářní den).
    const buckets = new Map<string, HourlyPoint[]>();
    const order: string[] = [];
    for (const p of slice) {
      const dateStr = p.time.slice(0, 10);
      const hour = new Date(p.time).getHours();
      const key = step === 24 ? dateStr : `${dateStr}-${Math.floor(hour / 6)}`;
      let arr = buckets.get(key);
      if (!arr) {
        arr = [];
        buckets.set(key, arr);
        order.push(key);
      }
      arr.push(p);
    }

    return order.map((key) => {
      const pts = buckets.get(key)!;
      const firstH = new Date(pts[0].time).getHours();
      const lastH = new Date(pts[pts.length - 1].time).getHours();
      const precipitation = pts.reduce((s, p) => s + p.precipitation, 0);
      const precipitationProbability = Math.max(
        ...pts.map((p) => p.precipitationProbability),
      );
      // Jen platné teploty – když část bloku chybí (model mimo horizont),
      // nesmí NaN „nakazit" celý blok.
      const finiteTemps = pts
        .map((p) => p.temperature)
        .filter((v) => Number.isFinite(v));
      const tempMax = finiteTemps.length ? Math.max(...finiteTemps) : NaN;
      const tempMin = finiteTemps.length ? Math.min(...finiteTemps) : NaN;

      const rep = pickRep(pts);
      const windPt = pts.reduce(
        (a, b) => (b.windSpeed > a.windSpeed ? b : a),
        pts[0],
      );

      // U denního výhledu (24 h) ukážeme až 4 ikony – ráno/dopoledne/
      // odpoledne/večer – aby byl vidět vývoj počasí během dne.
      let icons: DayIcon[] | undefined;
      if (step === 24) {
        icons = [];
        for (let s = 0; s < 4; s++) {
          const seg = pts.filter((p) => {
            const h = new Date(p.time).getHours();
            return h >= s * 6 && h < s * 6 + 6;
          });
          if (seg.length) {
            const r = pickRep(seg);
            icons.push({ code: r.weatherCode, isDay: r.isDay });
          }
        }
      }

      const end = Math.min(24, lastH + 1);
      const timeLabel =
        step === 24 ? dayHeader(pts[0].time) : `${firstH}–${end}`;

      return {
        key,
        iso: pts[0].time,
        timeLabel,
        weatherCode: rep.weatherCode,
        isDay: rep.isDay,
        icons,
        tempMax,
        tempMin,
        grouped: true,
        precipitation,
        precipitationProbability,
        windSpeed: windPt.windSpeed,
        windDirection: windPt.windDirection,
      };
    });
  }, [hourly, step, activeDate]);

  // Výhled omezíme na prvních DAY_LIMIT kalendářních dní; zbytek se dozobrazí
  // až po kliknutí na „Načíst další dny".
  const { limitedRows, hasMore } = useMemo(() => {
    const seen = new Set<string>();
    const out: Row[] = [];
    let more = false;
    for (const r of rows) {
      const day = r.iso.slice(0, 10);
      if (!seen.has(day)) {
        if (seen.size >= DAY_LIMIT) {
          more = true;
          break;
        }
        seen.add(day);
      }
      out.push(r);
    }
    return { limitedRows: out, hasMore: more };
  }, [rows]);

  // Při změně kroku nebo vybraného dne začneme zase sbaleně.
  useEffect(() => {
    setExpanded(false);
  }, [step, activeDate]);

  const shownRows = expanded ? rows : limitedRows;

  // Aktuální čas – přepočítá se jednou za minutu, aby se „teď" posunulo
  // i při dlouho otevřené aplikaci.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  let lastDay = "";
  const showHeaders = step !== 24;
  const todayKey = isoDate(new Date());
  const now = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  const nowHourPrefix = `${isoDate(now)}T${pad(now.getHours())}`;
  const nowKey6 = `${isoDate(now)}-${Math.floor(now.getHours() / 6)}`;

  return (
    <section className={`card ${step === 24 ? "yr-24" : ""}`}>
      <div className="mg-head">
        <h2 className="card-title" style={{ margin: 0 }}>
          {tr("Výhled")}
        </h2>
        <div className="yr-seg" role="tablist" aria-label={tr("Krok výhledu")}>
          <button
            role="tab"
            className={step === 1 ? "active" : ""}
            aria-selected={step === 1}
            onClick={() => setStep(1)}
          >
            1h
          </button>
          <button
            role="tab"
            className={step === 6 ? "active" : ""}
            aria-selected={step === 6}
            onClick={() => setStep(6)}
          >
            6h
          </button>
          <button
            role="tab"
            className={step === 24 ? "active" : ""}
            aria-selected={step === 24}
            onClick={() => setStep(24)}
          >
            1d
          </button>
        </div>
      </div>

      <div className="yr-head">
        <span>{tr("Čas")}</span>
        <span />
        <span className="ta-r">{tr("Teplota")}</span>
        <span className="ta-r">{tr("Srážky")}</span>
        <span className="ta-r">{tr("Vítr (m/s)")}</span>
      </div>

      <div className="yr-list">
        {shownRows.map((p) => {
          const info = describeWeather(p.weatherCode);
          const key = dateKey(p.iso);
          const newDay = key !== lastDay;
          lastDay = key;
          const selected = activeDate ? key === activeDate : false;
          const isToday = key === todayKey;
          const isNow =
            step === 1
              ? p.iso.slice(0, 13) === nowHourPrefix
              : step === 6
                ? p.key === nowKey6
                : false;
          return (
            <div key={p.key}>
              {showHeaders && newDay && (
                <div
                  className={`yr-dayhead ${selected ? "selected" : ""} ${isToday ? "today" : ""} ${
                    onSelectDay ? "clickable" : ""
                  }`}
                  onClick={onSelectDay ? () => onSelectDay(key) : undefined}
                >
                  {dayHeader(p.iso)}
                </div>
              )}
              <div
                className={`yr-row ${selected ? "selected" : ""} ${isToday ? "today" : ""} ${
                  isNow ? "now" : ""
                } ${step === 24 && onSelectDay ? "clickable" : ""}`}
                onClick={
                  step === 24 && onSelectDay ? () => onSelectDay(key) : undefined
                }
              >
                <span className="yr-time">{p.timeLabel}</span>
                <span className="yr-icon">
                  {p.icons ? (
                    p.icons.map((ic, idx) =>
                      Number.isFinite(ic.code) ? (
                        <WeatherIcon
                          key={idx}
                          kind={describeWeather(ic.code).icon}
                          isDay={ic.isDay}
                          size={24}
                        />
                      ) : (
                        <span key={idx} className="yr-missing">
                          ?
                        </span>
                      ),
                    )
                  ) : Number.isFinite(p.weatherCode) ? (
                    <WeatherIcon kind={info.icon} isDay={p.isDay} size={30} />
                  ) : (
                    <span className="yr-missing">?</span>
                  )}
                </span>
                <span className="yr-temp">
                  {p.grouped &&
                    Number.isFinite(p.tempMin) &&
                    Number.isFinite(p.tempMax) &&
                    p.tempMin !== p.tempMax && (
                      <span className="yr-temp-min">
                        <span style={{ color: tempColor(p.tempMin) }}>
                          {Math.round(p.tempMin)}°
                        </span>
                        <span className="yr-temp-sep"> / </span>
                      </span>
                    )}
                  <span
                    style={
                      Number.isFinite(p.tempMax)
                        ? { color: tempColor(p.tempMax) }
                        : undefined
                    }
                  >
                    {Number.isFinite(p.tempMax) ? `${Math.round(p.tempMax)}°` : "?"}
                  </span>
                </span>
                <span
                  className="yr-precip"
                  style={
                    p.precipitation > 0
                      ? { opacity: precipOpacity(p.precipitationProbability) }
                      : undefined
                  }
                  title={
                    p.precipitation > 0 && p.precipitationProbability > 0
                      ? tr("{prob}% šance na déšť", {
                          prob: p.precipitationProbability,
                        })
                      : undefined
                  }
                >
                  {p.precipitation > 0 && (
                    <>
                      <strong>{p.precipitation.toFixed(1)}</strong>
                      <em>mm</em>
                    </>
                  )}
                </span>
                <span className="yr-wind">
                  <WindArrow deg={p.windDirection} />
                  <strong>{p.windSpeed.toFixed(0)}</strong>
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {hasMore && !expanded && (
        <button
          type="button"
          className="yr-showmore"
          onClick={() => setExpanded(true)}
        >
          {tr("Načíst další dny")}
        </button>
      )}
    </section>
  );
}

function WindArrow({ deg }: { deg: number }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      style={{ transform: `rotate(${deg}deg)` }}
      aria-hidden="true"
    >
      <path
        d="M12 3v15m0 0l-5-5m5 5l5-5"
        stroke="#9aa7c4"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
