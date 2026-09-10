import { useEffect, useMemo, useRef, useState } from "react";
import type { HourlyPoint } from "../types";
import { describeWeather } from "../lib/weatherCodes";
import {
  dayHeader,
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
  const padH = (h: number) => String(h).padStart(2, "0");
  if (step === 1) {
    return pts.map((p) => ({
      key: p.time,
      iso: p.time,
      timeLabel: padH(locDate(p.time).getHours()),
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!settingsOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!settingsRef.current?.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [settingsOpen]);

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
      <div className="yr-headbar">
        <h2 className="card-title">{tr("Výhled")}</h2>
        <div className="yr-settings" ref={settingsRef}>
          <button
            type="button"
            className={`mg-view-btn${settingsOpen ? " active" : ""}`}
            onClick={() => setSettingsOpen((o) => !o)}
            aria-expanded={settingsOpen}
            aria-label={tr("Nastavení výhledu")}
            title={tr("Nastavení výhledu")}
          >
            <GearGlyph />
          </button>
          {settingsOpen && (
            <div className="yr-settings-menu" role="dialog">
              <span className="yr-settings-label">{tr("Podrobnost výhledu")}</span>
              <div
                className="yr-seg"
                role="tablist"
                aria-label={tr("Podrobnost výhledu")}
              >
                {([1, 4, 6] as const).map((step) => (
                  <button
                    key={step}
                    type="button"
                    role="tab"
                    className={detailStep === step ? "active" : ""}
                    aria-selected={detailStep === step}
                    onClick={() => setDetailStep(step)}
                  >
                    {step}h
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="yr-head">
        <span>{tr("Den")}</span>
        <span />
        <span className="ta-r">{tr("Teplota")}</span>
        <span className="ta-r">{tr("Srážky")}</span>
        <span className="ta-r">{tr("Vítr (m/s)")}</span>
        <span />
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
            <div
              key={p.key}
              className={`yr-day${open ? " is-open" : ""}${
                selected ? " is-selected" : ""
              }${isToday ? " is-today" : ""}`}
            >
              <div
                className={`yr-row clickable${selected ? " selected" : ""}${
                  isToday ? " today" : ""
                }${open ? " expanded" : ""}`}
                role="button"
                tabIndex={0}
                aria-expanded={open}
                onClick={(e) => {
                  toggleDay(p.key);
                  (e.currentTarget as HTMLElement).blur();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleDay(p.key);
                  }
                }}
              >
                <span className="yr-time">{p.timeLabel}</span>
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
                <TempCell min={p.tempMin} max={p.tempMax} />
                <PrecipCell
                  mm={p.precipitation}
                  prob={p.precipitationProbability}
                />
                <span className="yr-wind">
                  <WindArrow deg={p.windDirection} />
                  <strong>{p.windSpeed.toFixed(0)}</strong>
                </span>
                <span className="yr-chevron" aria-hidden="true">
                  <ChevronDown className="yr-chevron-ico" />
                </span>
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
                        className={`yr-row yr-hour${isNow ? " now" : ""}`}
                      >
                        <span className="yr-time">{d.timeLabel}</span>
                        <span className="yr-icon">
                          {Number.isFinite(d.weatherCode) ? (
                            <WeatherIcon
                              kind={dInfo.icon}
                              isDay={d.isDay}
                              size={22}
                            />
                          ) : (
                            <span className="yr-missing">?</span>
                          )}
                        </span>
                        <TempCell
                          min={d.tempMin}
                          max={d.tempMax}
                          showMin={d.grouped}
                        />
                        <PrecipCell
                          mm={d.precipitation}
                          prob={d.precipitationProbability}
                        />
                        <span className="yr-wind">
                          <WindArrow deg={d.windDirection} />
                          <strong>{d.windSpeed.toFixed(0)}</strong>
                        </span>
                        <span />
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

function TempCell({
  min,
  max,
  showMin = true,
}: {
  min: number;
  max: number;
  showMin?: boolean;
}) {
  const range =
    showMin &&
    Number.isFinite(min) &&
    Number.isFinite(max) &&
    min !== max;
  return (
    <span className="yr-temp">
      {range && (
        <span className="yr-temp-min">
          <span style={{ color: tempColor(min) }}>{Math.round(min)}°</span>
          <span className="yr-temp-sep"> / </span>
        </span>
      )}
      <span
        style={Number.isFinite(max) ? { color: tempColor(max) } : undefined}
      >
        {Number.isFinite(max) ? `${Math.round(max)}°` : "?"}
      </span>
    </span>
  );
}

function PrecipCell({ mm, prob }: { mm: number; prob: number }) {
  return (
    <span
      className="yr-precip"
      style={mm > 0 ? { opacity: precipOpacity(prob) } : undefined}
      title={
        mm > 0 && prob > 0
          ? tr("{prob}% šance na déšť", { prob })
          : undefined
      }
    >
      {mm > 0 && (
        <>
          <strong>{mm.toFixed(1)}</strong>
          <em>mm</em>
        </>
      )}
    </span>
  );
}

function GearGlyph() {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function ChevronDown({ className = "yr-more-ico" }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      className={className}
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
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
