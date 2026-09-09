import { useEffect, useMemo, useState } from "react";
import type { HourlyPoint } from "../types";
import { describeWeather } from "../lib/weatherCodes";
import {
  dayHeader,
  hourLabel,
  isoDate,
  locDate,
  zonedNow,
} from "../lib/format";
import { tempColor } from "../lib/tempColor";
import { tr } from "../lib/i18n";
import { useStoredState } from "../lib/useStoredState";
import WeatherIcon from "./WeatherIcon";

interface Props {
  hourly: HourlyPoint[];
  activeDate?: string;
  utcOffset?: number;
  onSelectDay?: (date: string) => void;
}

interface DayIcon {
  code: number;
  isDay: boolean;
}

interface DayRow {
  key: string;
  iso: string;
  timeLabel: string;
  weatherCode: number;
  isDay: boolean;
  icons: DayIcon[];
  /** Souhrnná ikonka dne pro úzké okno, kde se vejde jen jedna. */
  dayIcon: DayIcon;
  tempMax: number;
  tempMin: number;
  precipitation: number;
  precipitationProbability: number;
  windSpeed: number;
  windDirection: number;
  points: HourlyPoint[];
}

interface DetailRow {
  key: string;
  iso: string;
  timeLabel: string;
  weatherCode: number;
  isDay: boolean;
  tempMax: number;
  tempMin: number;
  grouped: boolean;
  precipitation: number;
  precipitationProbability: number;
  windSpeed: number;
  windDirection: number;
}

type DetailStep = 1 | 4 | 6;

// Průhlednost textu srážek podle pravděpodobnosti deště (vyšší šance = sytější).
function precipOpacity(prob: number): number {
  if (prob <= 0) return 0.6;
  return 0.3 + 0.7 * (Math.min(100, prob) / 100);
}

// Reprezentativní počasí úseku: přednostně hodina s nejvíc srážkami,
// jinak nejvýraznější (nejvyšší) kód počasí.
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

function buildDetailRows(pts: HourlyPoint[], step: DetailStep): DetailRow[] {
  if (step === 1) {
    return pts.map((p) => ({
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

  const buckets = new Map<string, HourlyPoint[]>();
  const order: string[] = [];
  for (const p of pts) {
    const hour = locDate(p.time).getHours();
    const key = `${p.time.slice(0, 10)}-${Math.floor(hour / step)}`;
    let arr = buckets.get(key);
    if (!arr) {
      arr = [];
      buckets.set(key, arr);
      order.push(key);
    }
    arr.push(p);
  }

  return order.map((key) => {
    const group = buckets.get(key)!;
    const padH = (h: number) => String(h).padStart(2, "0");
    const firstH = locDate(group[0].time).getHours();
    const lastH = locDate(group[group.length - 1].time).getHours();
    const precipitation = group.reduce((s, p) => s + p.precipitation, 0);
    const precipitationProbability = Math.max(
      ...group.map((p) => p.precipitationProbability),
    );
    const finiteTemps = group
      .map((p) => p.temperature)
      .filter((v) => Number.isFinite(v));
    const tempMax = finiteTemps.length ? Math.max(...finiteTemps) : NaN;
    const tempMin = finiteTemps.length ? Math.min(...finiteTemps) : NaN;
    const rep = pickRep(group);
    const windPt = group.reduce(
      (a, b) => (b.windSpeed > a.windSpeed ? b : a),
      group[0],
    );
    const end = Math.min(24, lastH + 1);

    return {
      key,
      iso: group[0].time,
      timeLabel: `${padH(firstH)}–${padH(end)}`,
      weatherCode: rep.weatherCode,
      isDay: rep.isDay,
      tempMax,
      tempMin,
      grouped: true,
      precipitation,
      precipitationProbability,
      windSpeed: windPt.windSpeed,
      windDirection: windPt.windDirection,
    };
  });
}

// Kolik dní najednou přidat / ubrat při „Zobrazit více/méně".
const DAY_STEP = 4;

export default function HourlyForecast({
  hourly,
  activeDate,
  utcOffset,
  onSelectDay,
}: Props) {
  const [detailStep, setDetailStep] = useStoredState<DetailStep>(
    "zmoknu.outlookDetailStep",
    6,
  );
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(DAY_STEP);

  const dayRows = useMemo<DayRow[]>(() => {
    const todayStr = isoDate(zonedNow(utcOffset));
    const base = activeDate && activeDate < todayStr ? activeDate : todayStr;
    let startIdx = hourly.findIndex((h) => h.time.slice(0, 10) >= base);
    if (startIdx === -1) startIdx = 0;
    const slice = hourly.slice(startIdx);

    const buckets = new Map<string, HourlyPoint[]>();
    const order: string[] = [];
    for (const p of slice) {
      const dateStr = p.time.slice(0, 10);
      let arr = buckets.get(dateStr);
      if (!arr) {
        arr = [];
        buckets.set(dateStr, arr);
        order.push(dateStr);
      }
      arr.push(p);
    }

    return order.map((dateStr) => {
      const pts = buckets.get(dateStr)!;
      const precipitation = pts.reduce((s, p) => s + p.precipitation, 0);
      const precipitationProbability = Math.max(
        ...pts.map((p) => p.precipitationProbability),
      );
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

      // Na úzkém okně se vejde jen jedna ikonka. Nesmí to být slepě první
      // šestihodinovka (0–6 = noc, tedy měsíc) – vezmeme reprezentanta ze
      // světlé části dne a jen když den světlo nemá, spadneme na celý den.
      const dayLight = pts.filter((p) => p.isDay);
      const repDay = pickRep(dayLight.length ? dayLight : pts);
      const dayIcon: DayIcon = {
        code: repDay.weatherCode,
        isDay: dayLight.length > 0,
      };

      const icons: DayIcon[] = [];
      for (let s = 0; s < 4; s++) {
        const seg = pts.filter((p) => {
          const h = locDate(p.time).getHours();
          return h >= s * 6 && h < s * 6 + 6;
        });
        if (seg.length) {
          const r = pickRep(seg);
          icons.push({ code: r.weatherCode, isDay: r.isDay });
        }
      }

      return {
        key: dateStr,
        iso: pts[0].time,
        timeLabel: dayHeader(pts[0].time, utcOffset),
        weatherCode: rep.weatherCode,
        isDay: rep.isDay,
        icons,
        dayIcon,
        tempMax,
        tempMin,
        precipitation,
        precipitationProbability,
        windSpeed: windPt.windSpeed,
        windDirection: windPt.windDirection,
        points: pts,
      };
    });
  }, [hourly, activeDate, utcOffset]);

  // Drž počet viditelných dní v platném rozsahu (po změně dat).
  useEffect(() => {
    setVisibleCount((n) =>
      Math.min(Math.max(DAY_STEP, n), Math.max(DAY_STEP, dayRows.length)),
    );
  }, [dayRows.length]);

  const shownDays = dayRows.slice(0, visibleCount);
  const canMore = visibleCount < dayRows.length;

  // Když uživatel posune výběr na den mimo aktuálně zobrazené, rozšíříme
  // výhled po krocích DAY_STEP, ať je vybraný den vidět.
  useEffect(() => {
    if (!activeDate) return;
    const idx = dayRows.findIndex((d) => d.key === activeDate);
    if (idx < 0) return;
    const needed = Math.min(
      dayRows.length,
      Math.ceil((idx + 1) / DAY_STEP) * DAY_STEP,
    );
    setVisibleCount((n) => (needed > n ? needed : n));
  }, [activeDate, dayRows]);

  // „Tik" jednou za minutu, aby se „teď" posunulo i při dlouho otevřené appce.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const todayKey = isoDate(zonedNow(utcOffset));
  const now = zonedNow(utcOffset);
  const pad = (n: number) => String(n).padStart(2, "0");
  const nowHourPrefix = `${isoDate(now)}T${pad(now.getHours())}`;
  const nowBucketKey = `${isoDate(now)}-${Math.floor(now.getHours() / detailStep)}`;

  const toggleDay = (key: string) => {
    setExpandedDay((prev) => (prev === key ? null : key));
    onSelectDay?.(key);
  };

  return (
    <section className={`card yr-24 ${canMore ? "yr-has-more" : ""}`}>
      <h2 className="card-title">{tr("Výhled")}</h2>

      <div className="yr-head">
        <span>{tr("Den")}</span>
        <span />
        <span className="ta-r">{tr("Teplota")}</span>
        <span className="ta-r">{tr("Srážky")}</span>
        <span className="ta-r">{tr("Vítr (m/s)")}</span>
      </div>

      <div className="yr-list">
        {shownDays.map((p) => {
          const selected = activeDate ? p.key === activeDate : false;
          const isToday = p.key === todayKey;
          const open = expandedDay === p.key;
          const details = open
            ? buildDetailRows(p.points, detailStep)
            : [];

          return (
            <div key={p.key}>
              <div
                className={`yr-row clickable ${selected ? "selected" : ""} ${
                  isToday ? "today" : ""
                } ${open ? "expanded" : ""}`}
                onClick={() => toggleDay(p.key)}
                aria-expanded={open}
              >
                <span className="yr-time">{p.timeLabel}</span>
                {open ? (
                  <div
                    className="yr-seg yr-seg-inline"
                    role="tablist"
                    aria-label={tr("Podrobnost výhledu")}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      role="tab"
                      className={detailStep === 1 ? "active" : ""}
                      aria-selected={detailStep === 1}
                      onClick={() => setDetailStep(1)}
                    >
                      1h
                    </button>
                    <button
                      type="button"
                      role="tab"
                      className={detailStep === 4 ? "active" : ""}
                      aria-selected={detailStep === 4}
                      onClick={() => setDetailStep(4)}
                    >
                      4h
                    </button>
                    <button
                      type="button"
                      role="tab"
                      className={detailStep === 6 ? "active" : ""}
                      aria-selected={detailStep === 6}
                      onClick={() => setDetailStep(6)}
                    >
                      6h
                    </button>
                  </div>
                ) : (
                  <>
                    <span className="yr-icon">
                      {Number.isFinite(p.dayIcon.code) ? (
                        <WeatherIcon
                          className="yr-icon-solo"
                          kind={describeWeather(p.dayIcon.code).icon}
                          isDay={p.dayIcon.isDay}
                          size={24}
                        />
                      ) : (
                        <span className="yr-missing yr-icon-solo">?</span>
                      )}
                      {p.icons.map((ic, idx) =>
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
                      )}
                    </span>
                    <span className="yr-temp">
                      {Number.isFinite(p.tempMin) &&
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
                        {Number.isFinite(p.tempMax)
                          ? `${Math.round(p.tempMax)}°`
                          : "?"}
                      </span>
                    </span>
                    <span
                      className="yr-precip"
                      style={
                        p.precipitation > 0
                          ? {
                              opacity: precipOpacity(
                                p.precipitationProbability,
                              ),
                            }
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
                  </>
                )}
              </div>

              {open && (
                <div className="yr-detail">
                  {details.map((d) => {
                    const dInfo = describeWeather(d.weatherCode);
                    const isNow =
                      detailStep === 1
                        ? d.iso.slice(0, 13) === nowHourPrefix
                        : d.key === nowBucketKey;
                    return (
                      <div
                        key={d.key}
                        className={`yr-row yr-detail-row ${isNow ? "now" : ""}`}
                      >
                        <span className="yr-time">{d.timeLabel}</span>
                        <span className="yr-icon">
                          {Number.isFinite(d.weatherCode) ? (
                            <WeatherIcon
                              kind={dInfo.icon}
                              isDay={d.isDay}
                              size={30}
                            />
                          ) : (
                            <span className="yr-missing">?</span>
                          )}
                        </span>
                        <span className="yr-temp">
                          {d.grouped &&
                            Number.isFinite(d.tempMin) &&
                            Number.isFinite(d.tempMax) &&
                            d.tempMin !== d.tempMax && (
                              <span className="yr-temp-min">
                                <span style={{ color: tempColor(d.tempMin) }}>
                                  {Math.round(d.tempMin)}°
                                </span>
                                <span className="yr-temp-sep"> / </span>
                              </span>
                            )}
                          <span
                            style={
                              Number.isFinite(d.tempMax)
                                ? { color: tempColor(d.tempMax) }
                                : undefined
                            }
                          >
                            {Number.isFinite(d.tempMax)
                              ? `${Math.round(d.tempMax)}°`
                              : "?"}
                          </span>
                        </span>
                        <span
                          className="yr-precip"
                          style={
                            d.precipitation > 0
                              ? {
                                  opacity: precipOpacity(
                                    d.precipitationProbability,
                                  ),
                                }
                              : undefined
                          }
                          title={
                            d.precipitation > 0 &&
                            d.precipitationProbability > 0
                              ? tr("{prob}% šance na déšť", {
                                  prob: d.precipitationProbability,
                                })
                              : undefined
                          }
                        >
                          {d.precipitation > 0 && (
                            <>
                              <strong>{d.precipitation.toFixed(1)}</strong>
                              <em>mm</em>
                            </>
                          )}
                        </span>
                        <span className="yr-wind">
                          <WindArrow deg={d.windDirection} />
                          <strong>{d.windSpeed.toFixed(0)}</strong>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {canMore && (
        <button
          type="button"
          className="yr-more"
          onClick={() =>
            setVisibleCount((n) => Math.min(dayRows.length, n + DAY_STEP))
          }
          aria-label={tr("Zobrazit více")}
          title={tr("Zobrazit více")}
        >
          <ChevronDown />
        </button>
      )}
    </section>
  );
}

function ChevronDown() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      className="yr-more-ico"
      aria-hidden="true"
    >
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
