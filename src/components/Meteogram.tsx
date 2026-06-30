import { useEffect, useMemo, useRef, useState } from "react";
import type { DailyPoint, HourlyPoint } from "../types";
import { describeWeather } from "../lib/weatherCodes";
import { useStoredState } from "../lib/useStoredState";
import { tempColor } from "../lib/tempColor";
import WeatherIcon from "./WeatherIcon";

interface Props {
  hourly: HourlyPoint[];
  activeDate?: string;
  day?: DailyPoint | null;
  feelsMax?: number;
  feelsMin?: number;
}

type Tab =
  | "temp"
  | "feels"
  | "precip"
  | "wind"
  | "cloud"
  | "humidity"
  | "dewpoint"
  | "pressure";

// Pevné okno od 00:00 vybraného dne. Graf se vejde na šířku, nescrolluje.
const WINDOW_HOURS = 56;
const H = 240;
const TOP_PAD = 36;
const PRECIP_H = 58;
const CURVE_BOTTOM = H - PRECIP_H - 8;

const DAY_SHORT = ["Ne", "Po", "Út", "St", "Čt", "Pá", "So"];

export default function Meteogram({
  hourly,
  activeDate,
  day,
  feelsMax,
  feelsMin,
}: Props) {
  const [tab, setTab] = useStoredState<Tab>("zmoknu.mgTab", "temp");
  const plotRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // Změř šířku plochy grafu (bez scrollu se vše vejde na tuto šířku).
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const todayStr = isoLocal(new Date());

  // Na širokém displeji ukážeme víc dní (4 dny = 96 h), jinak základní okno.
  const windowHours = width >= 1000 ? 96 : WINDOW_HOURS;

  // Okno začíná na 00:00 vybraného dne (nebo dneška).
  const points = useMemo(() => {
    const base = activeDate || todayStr;
    let start = hourly.findIndex(
      (h) => h.time.slice(0, 10) === base && new Date(h.time).getHours() === 0,
    );
    if (start === -1) start = hourly.findIndex((h) => h.time.slice(0, 10) >= base);
    if (start === -1) start = 0;
    return hourly.slice(start, start + windowHours);
  }, [hourly, activeDate, todayStr, windowHours]);

  const activeMissing = useMemo(() => {
    if (!activeDate || !points.length) return false;
    return !points.some((p) => p.time.slice(0, 10) === activeDate);
  }, [activeDate, points]);

  const isCloud = tab === "cloud";
  const isPrecip = tab === "precip";

  const pph = points.length > 0 && width > 0 ? width / points.length : 0;
  const x = (i: number) => (i + 0.5) * pph;

  // Index "teď" – jen když je aktuální čas uvnitř okna.
  const nowIndex = useMemo(() => {
    if (!points.length) return -1;
    const now = Date.now();
    const first = new Date(points[0].time).getTime();
    const last = new Date(points[points.length - 1].time).getTime();
    if (now < first - 1_800_000 || now > last + 1_800_000) return -1;
    let best = 0;
    let bestDiff = Infinity;
    points.forEach((p, i) => {
      const diff = Math.abs(new Date(p.time).getTime() - now);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    });
    return best;
  }, [points]);

  const [cursor, setCursor] = useState(0);
  useEffect(() => {
    setCursor(nowIndex >= 0 ? nowIndex : Math.min(12, points.length - 1));
  }, [nowIndex, points.length]);

  const precipMax = useMemo(
    () => Math.max(1, ...points.map((p) => p.precipitation)),
    [points],
  );

  const activeKey = activeDate || todayStr;

  const dayBands = useMemo(() => {
    const bands: { startI: number; endI: number; date: Date; dateStr: string }[] =
      [];
    if (!points.length) return bands;
    let startI = 0;
    for (let i = 1; i <= points.length; i++) {
      const prevStr = points[i - 1].time.slice(0, 10);
      const curStr = i < points.length ? points[i].time.slice(0, 10) : null;
      if (curStr !== prevStr) {
        bands.push({
          startI,
          endI: i - 1,
          date: new Date(points[i - 1].time),
          dateStr: prevStr,
        });
        startI = i;
      }
    }
    return bands;
  }, [points]);

  const series = useMemo(() => buildSeries(tab, points), [tab, points]);

  const precipBars = useMemo(() => {
    const bars: { startI: number; endI: number; value: number; prob: number }[] =
      [];
    let i = 0;
    while (i < points.length) {
      const v = points[i].precipitation;
      if (v <= 0) {
        i++;
        continue;
      }
      let j = i;
      let prob = points[i].precipitationProbability;
      while (
        j + 1 < points.length &&
        Math.abs(points[j + 1].precipitation - v) < 0.01
      ) {
        j++;
        prob = Math.max(prob, points[j].precipitationProbability);
      }
      bars.push({ startI: i, endI: j, value: v, prob });
      i = j + 1;
    }
    return bars;
  }, [points]);

  const yCurve = (v: number) => {
    const t = (v - series.min) / Math.max(0.001, series.max - series.min);
    return CURVE_BOTTOM - t * (CURVE_BOTTOM - TOP_PAD);
  };

  // U tabu srážek kreslíme sloupce od úplného spodku grafu (víc místa).
  const PRECIP_BASELINE = H - 16;
  const yPrecip = (v: number) =>
    PRECIP_BASELINE - (v / Math.max(0.001, series.max)) * (PRECIP_BASELINE - TOP_PAD);

  // Vodorovné osové linky pro velký graf srážek (hodnoty v mm).
  const precipTicks = useMemo(() => {
    if (!isPrecip) return [];
    const max = series.max;
    return [0.25, 0.5, 0.75, 1]
      .map((f) => Math.round(max * f * 10) / 10)
      .filter((v, i, arr) => v > 0 && arr.indexOf(v) === i);
  }, [isPrecip, series.max]);

  const areaPath = useMemo(() => {
    if (!points.length || !pph) return "";
    let d = `M ${x(0)} ${CURVE_BOTTOM}`;
    series.primary.forEach((v, i) => {
      d += ` L ${x(i)} ${yCurve(v)}`;
    });
    d += ` L ${x(points.length - 1)} ${CURVE_BOTTOM} Z`;
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, points.length, pph]);

  const linePath = useMemo(() => {
    if (!pph) return "";
    return series.primary
      .map((v, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${yCurve(v)}`)
      .join(" ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, points.length, pph]);

  const secondaryPath = useMemo(() => {
    if (!series.secondary || !pph) return "";
    return series.secondary
      .map((v, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${yCurve(v)}`)
      .join(" ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, points.length, pph]);

  const extraPaths = useMemo(() => {
    if (!series.extras || !pph) return [];
    return series.extras.map((ex) => ({
      color: ex.color,
      d: ex.values
        .map((v, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${yCurve(v)}`)
        .join(" "),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, points.length, pph]);

  const cloudBands = useMemo(() => {
    if (!isCloud || !pph) return [];
    const layers = [
      { values: points.map((p) => p.cloudHigh), color: "#e7edf8", label: "vysoká" },
      { values: points.map((p) => p.cloudMid), color: "#aeb9d2", label: "střední" },
      { values: points.map((p) => p.cloudLow), color: "#6f8ac9", label: "nízká" },
    ];
    const bandH = (CURVE_BOTTOM - TOP_PAD) / 3;
    return layers.map((l, idx) => {
      const centerY = TOP_PAD + bandH * (idx + 0.5);
      const half = bandH * 0.42;
      let d = "";
      l.values.forEach((v, i) => {
        d += `${i === 0 ? "M" : "L"} ${x(i)} ${centerY - (v / 100) * half} `;
      });
      for (let i = l.values.length - 1; i >= 0; i--) {
        d += `L ${x(i)} ${centerY + (l.values[i] / 100) * half} `;
      }
      d += "Z";
      return { d, color: l.color, label: l.label, centerY };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCloud, points, pph]);

  const tempLineStops = useMemo(() => {
    if (tab !== "temp" && tab !== "feels") return [];
    const n = 12;
    const out: { offset: number; color: string }[] = [];
    for (let k = 0; k <= n; k++) {
      const off = k / n;
      const t = series.max - off * (series.max - series.min);
      out.push({ offset: off, color: tempColor(t) });
    }
    return out;
  }, [tab, series.min, series.max]);

  const labelValues = series.primary;
  const labelColor = tab === "feels" ? "feels" : "";
  // Minimální rozestup popisků v hodinách odvozený od skutečné šířky (px),
  // aby se na úzké obrazovce (malé pph) hodnoty nepřekrývaly.
  const minGapHours = pph > 0 ? Math.max(2, Math.ceil(40 / pph)) : 2;
  const valueLabelList = useMemo(
    () => valueLabels(points, labelValues, minGapHours),
    [points, labelValues, minGapHours],
  );

  const pressing = useRef(false);

  function handlePointer(clientX: number) {
    const el = plotRef.current;
    if (!el || !pph) return;
    const rect = el.getBoundingClientRect();
    const px = clientX - rect.left;
    const i = Math.floor(px / pph);
    setCursor(Math.max(0, Math.min(points.length - 1, i)));
  }

  const active = points[cursor];

  // Tendence tlaku za poslední ~3 h (pro trendovou šipku ve stats).
  const pressureDelta =
    active && cursor >= 0
      ? active.pressure - points[Math.max(0, cursor - 3)].pressure
      : 0;

  if (!points.length) return null;

  // Pozice tooltipu (den + čas) u kurzoru, oříznutá do šířky grafu.
  const tipW = 78;
  const tipX = Math.max(2, Math.min(width - tipW - 2, x(cursor) - tipW / 2));

  return (
    <section className="card meteogram-card">
      {day && <DaySummary day={day} feelsMax={feelsMax} feelsMin={feelsMin} />}

      <div className="mg-head">
        <h2 className="card-title" style={{ margin: 0 }}>
          Meteogram
        </h2>
      </div>

      {activeMissing && (
        <div className="mg-missing">
          Pro {dayShortLabel(activeDate!)} meteogram není k dispozici – hodinová
          data sahají jen několik dní dopředu.
        </div>
      )}

      {active && (
        <StatReadout
          p={active}
          time={active.time}
          tab={tab}
          onTab={setTab}
          pressureDelta={pressureDelta}
        />
      )}

      <div
        className="meteogram-plot"
        ref={plotRef}
        onPointerDown={(e) => {
          pressing.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          handlePointer(e.clientX);
        }}
        onPointerMove={(e) => {
          // Myš scrubuje při přejezdu; dotyk/pero jen během tažení.
          if (e.pointerType === "mouse" || pressing.current) handlePointer(e.clientX);
        }}
        onPointerUp={() => {
          pressing.current = false;
        }}
        onPointerCancel={() => {
          pressing.current = false;
        }}
      >
        {/* proužek ikon – po 2 hodinách, střídavě ve dvou řadách */}
        <div className="mg-icons">
          {pph > 0 &&
            points.map((p, i) => {
              const hr = new Date(p.time).getHours();
              if (hr % 2 !== 0) return null;
              return (
                <span
                  key={p.time}
                  className={`mg-icon ${hr % 4 === 0 ? "row-a" : "row-b"}`}
                  style={{ left: x(i) }}
                >
                  <WeatherIcon
                    kind={describeWeather(p.weatherCode).icon}
                    isDay={p.isDay}
                    size={20}
                  />
                </span>
              );
            })}
        </div>

        <svg width={width || 1} height={H} className="mg-svg">
          <defs>
            <linearGradient id="grad-primary" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={series.fill} stopOpacity="0.55" />
              <stop offset="100%" stopColor={series.fill} stopOpacity="0.04" />
            </linearGradient>
            <linearGradient id="grad-precip" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#8fd0ff" />
              <stop offset="100%" stopColor="#2f7ff0" />
            </linearGradient>
            {(tab === "temp" || tab === "feels") && (
              <linearGradient
                id="grad-templine"
                gradientUnits="userSpaceOnUse"
                x1="0"
                y1={TOP_PAD}
                x2="0"
                y2={CURVE_BOTTOM}
              >
                {tempLineStops.map((s, i) => (
                  <stop
                    key={i}
                    offset={`${(s.offset * 100).toFixed(1)}%`}
                    stopColor={s.color}
                  />
                ))}
              </linearGradient>
            )}
          </defs>

          {/* denní pruhy + oddělovače */}
          {pph > 0 &&
            dayBands.map((b, bi) => {
              const left = b.startI * pph;
              const right = (b.endI + 1) * pph;
              const isToday = b.dateStr === todayStr;
              const isActive = b.dateStr === activeKey;
              const isPast = b.dateStr < todayStr;
              const fill = isPast ? "rgba(0,0,0,0.22)" : "transparent";
              return (
                <g key={`band-${bi}`}>
                  <rect
                    x={left}
                    y={TOP_PAD - 10}
                    width={right - left}
                    height={H - 14 - (TOP_PAD - 10)}
                    fill={fill}
                  />
                  {bi > 0 && (
                    <line
                      x1={left}
                      y1={TOP_PAD - 12}
                      x2={left}
                      y2={H - 14}
                      stroke="rgba(255,255,255,0.28)"
                      strokeWidth="1.5"
                    />
                  )}
                  <text
                    x={(left + right) / 2}
                    y={14}
                    className={`mg-daylabel ${isActive ? "selected" : ""} ${isToday ? "today" : ""}`}
                    textAnchor="middle"
                  >
                    {isToday
                      ? "Dnes"
                      : `${DAY_SHORT[b.date.getDay()]} ${b.date.getDate()}.${b.date.getMonth() + 1}.`}
                  </text>
                </g>
              );
            })}

          {/* hodinové linky + popisky (6/12/18) */}
          {pph > 0 &&
            points.map((p, i) => {
              const d = new Date(p.time);
              if (d.getHours() % 6 === 0 && d.getHours() !== 0) {
                return (
                  <g key={`h-${i}`}>
                    <line
                      x1={x(i)}
                      y1={TOP_PAD - 8}
                      x2={x(i)}
                      y2={H - 16}
                      stroke="rgba(255,255,255,0.06)"
                      strokeWidth="1"
                    />
                    <text x={x(i)} y={TOP_PAD - 8} className="mg-hourlabel">
                      {d.getHours()}
                    </text>
                  </g>
                );
              }
              return null;
            })}

          {/* srážkové sloupce – malý pruh dole (u ostatních veličin) */}
          {pph > 0 &&
            !isPrecip &&
            precipBars.map((b) => {
              const baseline = H - 16;
              const scale = Math.max(2, precipMax);
              const norm = Math.min(1, Math.pow(b.value / scale, 0.6));
              const hb = Math.max(4, norm * (PRECIP_H - 4));
              const left = x(b.startI) - pph * 0.42;
              const right = x(b.endI) + pph * 0.42;
              const opacity = b.prob > 0 ? 0.2 + 0.8 * (b.prob / 100) : 0.4;
              return (
                <rect
                  key={`p-${b.startI}`}
                  x={left}
                  y={baseline - hb}
                  width={right - left}
                  height={hb}
                  rx="2"
                  fill="url(#grad-precip)"
                  opacity={opacity}
                />
              );
            })}

          {isCloud ? (
            <>
              {cloudBands.map((b, i) => (
                <g key={`cloud-${i}`}>
                  <line
                    x1={0}
                    y1={b.centerY}
                    x2={width}
                    y2={b.centerY}
                    stroke="rgba(255,255,255,0.08)"
                    strokeWidth="1"
                  />
                  <path d={b.d} fill={b.color} opacity="0.92" />
                </g>
              ))}
              {cloudBands.map((b, i) => (
                <text
                  key={`cl-${i}`}
                  x={8}
                  y={b.centerY - (CURVE_BOTTOM - TOP_PAD) / 6 + 4}
                  className="mg-bandlabel"
                >
                  {b.label}
                </text>
              ))}
            </>
          ) : isPrecip ? (
            pph > 0 && (
              <>
                {/* osové linky s hodnotami v mm */}
                {precipTicks.map((t) => (
                  <g key={`pt-${t}`}>
                    <line
                      x1={0}
                      y1={yPrecip(t)}
                      x2={width}
                      y2={yPrecip(t)}
                      stroke="rgba(255,255,255,0.08)"
                      strokeWidth="1"
                    />
                    <text x={6} y={yPrecip(t) - 3} className="mg-bandlabel">
                      {t} mm
                    </text>
                  </g>
                ))}
                {/* velké srážkové sloupce – od spodku grafu */}
                {precipBars.map((b) => {
                  const top = yPrecip(b.value);
                  const hb = Math.max(2, PRECIP_BASELINE - top);
                  const left = x(b.startI) - pph * 0.42;
                  const right = x(b.endI) + pph * 0.42;
                  const opacity = b.prob > 0 ? 0.35 + 0.65 * (b.prob / 100) : 0.5;
                  return (
                    <rect
                      key={`pb-${b.startI}`}
                      x={left}
                      y={top}
                      width={right - left}
                      height={hb}
                      rx="2"
                      fill="url(#grad-precip)"
                      opacity={opacity}
                    />
                  );
                })}
                {/* hodnoty nad sloupci */}
                {precipBars.map((b) => {
                  const cx = (x(b.startI) + x(b.endI)) / 2;
                  const top = yPrecip(b.value);
                  return (
                    <text
                      key={`pl-${b.startI}`}
                      x={cx}
                      y={Math.max(TOP_PAD + 8, top - 5)}
                      className="mg-extrema precip"
                      textAnchor="middle"
                    >
                      {b.value.toFixed(1)}
                    </text>
                  );
                })}
              </>
            )
          ) : (
            pph > 0 && (
              <>
                <path d={areaPath} fill="url(#grad-primary)" />
                {secondaryPath && (
                  <path
                    d={secondaryPath}
                    fill="none"
                    stroke={series.secondaryColor}
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                )}
                <path
                  d={linePath}
                  fill="none"
                  stroke={
                    tab === "temp" || tab === "feels"
                      ? "url(#grad-templine)"
                      : series.stroke
                  }
                  strokeWidth="2.5"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {extraPaths.map((ex, i) => (
                  <path
                    key={`extra-${i}`}
                    d={ex.d}
                    fill="none"
                    stroke={ex.color}
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    opacity="0.95"
                  />
                ))}
                {valueLabelList.map((e) => (
                  <text
                    key={`ex-${e.i}`}
                    x={x(e.i)}
                    y={yCurve(labelValues[e.i]) + (e.kind === "max" ? -8 : 15)}
                    className={`mg-extrema ${labelColor}`}
                    textAnchor="middle"
                  >
                    {series.fmt(labelValues[e.i])}
                  </text>
                ))}
              </>
            )
          )}

          {/* značka "teď" */}
          {nowIndex >= 0 && pph > 0 && (
            <line
              x1={x(nowIndex)}
              y1={TOP_PAD - 8}
              x2={x(nowIndex)}
              y2={H - 14}
              stroke="rgba(255,209,102,0.7)"
              strokeWidth="1.5"
              strokeDasharray="3 3"
            />
          )}

          {/* časový kurzor */}
          {pph > 0 && (
            <>
              <line
                x1={x(cursor)}
                y1={TOP_PAD - 10}
                x2={x(cursor)}
                y2={H - 14}
                stroke="rgba(255,255,255,0.85)"
                strokeWidth="1.5"
              />
              {!isCloud && !isPrecip && (
                <circle
                  cx={x(cursor)}
                  cy={yCurve(series.primary[cursor])}
                  r="4.5"
                  fill="#fff"
                  stroke={
                    tab === "temp" || tab === "feels"
                      ? tempColor(series.primary[cursor])
                      : series.stroke
                  }
                  strokeWidth="2"
                />
              )}
              {/* tooltip den + čas – dole pod srážkami */}
              <g transform={`translate(${tipX}, ${H - 19})`}>
                <rect
                  width={tipW}
                  height={18}
                  rx="6"
                  fill="rgba(12,18,32,0.92)"
                  stroke="rgba(255,255,255,0.18)"
                />
                <text x={tipW / 2} y={13} className="mg-tip" textAnchor="middle">
                  {cursorTimeLabel(active.time)}
                </text>
              </g>
            </>
          )}
        </svg>
      </div>
    </section>
  );
}

// Stručný přehled vybraného dne nad meteogramem.
function DaySummary({
  day,
  feelsMax,
  feelsMin,
}: {
  day: DailyPoint;
  feelsMax?: number;
  feelsMin?: number;
}) {
  const info = describeWeather(day.weatherCode);
  const prob = day.precipitationProbabilityMax ?? 0;
  const precipOp = day.precipitationSum > 0 ? 0.3 + 0.7 * (prob / 100) : 0.4;
  const hasFeels = feelsMax != null && feelsMin != null;
  return (
    <div className="mg-daysum">
      <WeatherIcon kind={info.icon} isDay size={36} />
      <div className="mg-daysum-main">
        <span className="mg-daysum-day">{daySummaryLabel(day.time)}</span>
        <strong className="mg-daysum-temp">
          {Math.round(day.tempMax)}° / {Math.round(day.tempMin)}°
        </strong>
        {hasFeels && (
          <span className="mg-daysum-feels">
            pocitově {Math.round(feelsMax!)}° / {Math.round(feelsMin!)}°
          </span>
        )}
      </div>
      <div className="mg-daysum-precip" style={{ opacity: precipOp }}>
        <span className="mg-daysum-precip-main">
          <DropMini />
          <strong>{day.precipitationSum.toFixed(1)} mm</strong>
        </span>
        {prob > 0 && <span className="mg-daysum-prob">{prob}% šance</span>}
      </div>
    </div>
  );
}

function DropMini() {
  return (
    <svg width="12" height="15" viewBox="0 0 11 14" aria-hidden="true">
      <path
        d="M5.5 0S0 6 0 9.2A5.5 5.5 0 0 0 11 9.2C11 6 5.5 0 5.5 0z"
        fill="#3b9bff"
      />
    </svg>
  );
}

// Panel s ikonami pro hodinu pod kurzorem – pevné rozložení, nehýbe se.
function StatReadout({
  p,
  time,
  tab,
  onTab,
  pressureDelta,
}: {
  p: HourlyPoint;
  time: string;
  tab: Tab;
  onTab: (t: Tab) => void;
  pressureDelta: number;
}) {
  const info = describeWeather(p.weatherCode);
  return (
    <div className="mg-stats">
      <button
        type="button"
        className={`mg-stat mg-stat-btn ${tab === "temp" ? "active" : ""} ${tempFlag(p.temperature)}`}
        onClick={() => onTab("temp")}
        aria-pressed={tab === "temp"}
        title="Zobrazit graf teploty"
      >
        <WeatherIcon kind={info.icon} isDay={p.isDay} size={30} />
        <div className="mg-stat-v">
          <strong style={{ color: tempColor(p.temperature) }}>
            {Math.round(p.temperature)}°
          </strong>
          <span>{cursorTimeLabel(time)}</span>
        </div>
      </button>

      <button
        type="button"
        className={`mg-stat mg-stat-btn ${tab === "feels" ? "active" : ""} ${tempFlag(p.apparentTemperature)}`}
        onClick={() => onTab("feels")}
        aria-pressed={tab === "feels"}
        title="Zobrazit graf pocitové teploty"
      >
        <PersonGlyph />
        <div className="mg-stat-v">
          <strong style={{ color: tempColor(p.apparentTemperature) }}>
            {Math.round(p.apparentTemperature)}°
          </strong>
          <span>pocitově</span>
        </div>
      </button>

      <button
        type="button"
        className={`mg-stat mg-stat-btn mg-stat-precip ${tab === "precip" ? "active" : ""} ${p.precipitation > 0 ? "flag-wet" : ""}`}
        onClick={() => onTab("precip")}
        aria-pressed={tab === "precip"}
        title="Zobrazit graf srážek"
      >
        <RainGlyph />
        <div className="mg-stat-v">
          <RainDrops n={dropsFor(p.precipitation)} prob={p.precipitationProbability} />
          <span className="mg-precip-sub">
            {p.precipitation > 0 ? `${p.precipitation.toFixed(1)} mm` : "0 mm"}
            {p.precipitationProbability > 0 && ` · ${p.precipitationProbability} %`}
          </span>
        </div>
      </button>

      <button
        type="button"
        className={`mg-stat mg-stat-btn ${tab === "wind" ? "active" : ""} ${windFlag(p.windSpeed, p.windGusts)}`}
        onClick={() => onTab("wind")}
        aria-pressed={tab === "wind"}
        title="Zobrazit graf větru"
      >
        <WindGlyph />
        <div className="mg-stat-v">
          <strong>{p.windSpeed.toFixed(0)} m/s</strong>
          <span>vítr (nárazy {p.windGusts.toFixed(0)} m/s)</span>
        </div>
      </button>

      <button
        type="button"
        className={`mg-stat mg-stat-btn ${tab === "cloud" ? "active" : ""}`}
        onClick={() => onTab("cloud")}
        aria-pressed={tab === "cloud"}
        title="Zobrazit graf oblačnosti"
      >
        <CloudGlyph />
        <div className="mg-stat-v">
          <strong>{Math.round(p.cloudCover)} %</strong>
          <span>oblačnost</span>
        </div>
      </button>

      <button
        type="button"
        className={`mg-stat mg-stat-btn ${tab === "humidity" ? "active" : ""} ${p.humidity >= 90 ? "flag-humid" : ""}`}
        onClick={() => onTab("humidity")}
        aria-pressed={tab === "humidity"}
        title="Zobrazit graf vlhkosti"
      >
        <HumidGlyph />
        <div className="mg-stat-v">
          <strong>{Math.round(p.humidity)} %</strong>
          <span>vlhkost</span>
        </div>
      </button>

      <button
        type="button"
        className={`mg-stat mg-stat-btn ${tab === "dewpoint" ? "active" : ""}`}
        onClick={() => onTab("dewpoint")}
        aria-pressed={tab === "dewpoint"}
        title="Zobrazit graf rosného bodu"
      >
        <DewGlyph />
        <div className="mg-stat-v">
          <strong>{Math.round(p.dewPoint)}°</strong>
          <span>rosný bod</span>
        </div>
      </button>

      <button
        type="button"
        className={`mg-stat mg-stat-btn ${tab === "pressure" ? "active" : ""}`}
        onClick={() => onTab("pressure")}
        aria-pressed={tab === "pressure"}
        title="Zobrazit graf tlaku"
      >
        <PressureGlyph />
        <div className="mg-stat-v">
          <strong>
            {Math.round(p.pressure)} hPa <PressureTrend delta={pressureDelta} />
          </strong>
          <span>tlak</span>
        </div>
      </button>
    </div>
  );
}

// Zvýraznění nestandardních hodnot, ať jsou na první pohled vidět.
function tempFlag(t: number): string {
  if (t >= 30) return "flag-vhot";
  if (t >= 26) return "flag-hot";
  if (t <= -6) return "flag-vcold";
  if (t <= 0) return "flag-cold";
  return "";
}

function windFlag(speed: number, gusts: number): string {
  if (speed >= 14 || gusts >= 20) return "flag-vwindy";
  if (speed >= 8 || gusts >= 13) return "flag-windy";
  return "";
}

function dropsFor(mm: number): number {
  if (mm <= 0) return 0;
  if (mm < 0.5) return 1;
  if (mm < 1.5) return 2;
  if (mm < 4) return 3;
  if (mm < 8) return 4;
  return 5;
}

function RainDrops({ n, prob }: { n: number; prob: number }) {
  // Průhlednost kapek podle šance na déšť (jako u srážkových sloupců).
  const op = n > 0 ? (prob > 0 ? 0.25 + 0.75 * (prob / 100) : 0.5) : 1;
  return (
    <span className="mg-drops" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <svg key={i} width="11" height="14" viewBox="0 0 11 14">
          <path
            d="M5.5 0S0 6 0 9.2A5.5 5.5 0 0 0 11 9.2C11 6 5.5 0 5.5 0z"
            fill={i < n ? "#3b9bff" : "rgba(255,255,255,0.14)"}
            opacity={i < n ? op : 1}
          />
        </svg>
      ))}
    </span>
  );
}

function PersonGlyph() {
  return (
    <svg className="mg-glyph" width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="6" r="3" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M5 21c0-4 3.1-7 7-7s7 3 7 7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function WindGlyph() {
  return (
    <svg className="mg-glyph" width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path
        d="M3 8h11a3 3 0 1 0-3-3M3 16h14a3 3 0 1 1-3 3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloudGlyph() {
  return (
    <svg className="mg-glyph" width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path
        d="M7 18a4 4 0 0 1 .4-8 5.5 5.5 0 0 1 10.5 1.5A3.5 3.5 0 0 1 17.5 18H7z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RainGlyph() {
  return (
    <svg className="mg-glyph" width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path
        d="M7 14a4 4 0 0 1 .4-8 5.5 5.5 0 0 1 10.5 1.5A3.5 3.5 0 0 1 17.5 14H7z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function HumidGlyph() {
  return (
    <svg className="mg-glyph" width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 3s6 6.5 6 10.5A6 6 0 0 1 6 13.5C6 9.5 12 3 12 3z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Trendová šipka tlaku podle 3h tendence (prudce/mírně nahoru/dolů, stálý).
function PressureTrend({ delta }: { delta: number }) {
  let angle: number;
  let cls: string;
  let title: string;
  if (delta >= 2) {
    angle = -90;
    cls = "up";
    title = "prudce stoupá";
  } else if (delta >= 0.7) {
    angle = -45;
    cls = "up";
    title = "stoupá";
  } else if (delta <= -2) {
    angle = 90;
    cls = "down";
    title = "prudce klesá";
  } else if (delta <= -0.7) {
    angle = 45;
    cls = "down";
    title = "klesá";
  } else {
    angle = 0;
    cls = "steady";
    title = "stálý";
  }
  return (
    <svg
      className={`mg-ptrend ${cls}`}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label={`tlak ${title}`}
    >
      <title>{title}</title>
      <g transform={`rotate(${angle} 12 12)`}>
        <path
          d="M4 12h13M12 7l6 5-6 5"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

function DewGlyph() {
  return (
    <svg className="mg-glyph" width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 4s5 6 5 9.5A5 5 0 0 1 7 13.5C7 10 12 4 12 4z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M10 13a2 2 0 0 0 2 2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PressureGlyph() {
  return (
    <svg className="mg-glyph" width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M12 12l4-3"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface ExtraLine {
  values: number[];
  color: string;
  label: string;
}

interface SeriesConfig {
  primary: number[];
  secondary?: number[];
  secondaryColor?: string;
  extras?: ExtraLine[];
  min: number;
  max: number;
  stroke: string;
  fill: string;
  fmt: (v: number) => string;
}

function buildSeries(tab: Tab, points: HourlyPoint[]): SeriesConfig {
  if (tab === "precip") {
    const precip = points.map((p) => p.precipitation);
    const max = niceMax(Math.max(0, ...precip));
    return {
      primary: precip,
      min: 0,
      max,
      stroke: "#3b9bff",
      fill: "#3b9bff",
      fmt: (v) => `${v.toFixed(1)} mm`,
    };
  }
  if (tab === "wind") {
    const speed = points.map((p) => p.windSpeed);
    const gusts = points.map((p) => p.windGusts);
    const max = Math.max(1, ...gusts) * 1.1;
    return {
      primary: speed,
      secondary: gusts,
      secondaryColor: "#ff5b5b",
      min: 0,
      max,
      stroke: "#5bd99a",
      fill: "#5bd99a",
      fmt: (v) => `${v.toFixed(0)}`,
    };
  }
  if (tab === "cloud") {
    const cloud = points.map((p) => p.cloudCover);
    return {
      primary: cloud,
      extras: [
        { values: points.map((p) => p.cloudHigh), color: "#e7edf8", label: "vysoká" },
        { values: points.map((p) => p.cloudMid), color: "#aeb9d2", label: "střední" },
        { values: points.map((p) => p.cloudLow), color: "#6f8ac9", label: "nízká" },
      ],
      min: 0,
      max: 100,
      stroke: "#c3cde0",
      fill: "#c3cde0",
      fmt: (v) => `${Math.round(v)}%`,
    };
  }
  if (tab === "humidity") {
    const hum = points.map((p) => p.humidity);
    return {
      primary: hum,
      min: 0,
      max: 100,
      stroke: "#4fd1b0",
      fill: "#4fd1b0",
      fmt: (v) => `${Math.round(v)}%`,
    };
  }
  if (tab === "dewpoint") {
    const dew = points.map((p) => p.dewPoint);
    const lo = Math.min(...dew);
    const hi = Math.max(...dew);
    const pad = Math.max(1, (hi - lo) * 0.15);
    return {
      primary: dew,
      min: lo - pad,
      max: hi + pad,
      stroke: "#63c7e0",
      fill: "#63c7e0",
      fmt: (v) => `${Math.round(v)}°`,
    };
  }
  if (tab === "pressure") {
    const pres = points.map((p) => p.pressure);
    const lo = Math.min(...pres);
    const hi = Math.max(...pres);
    const pad = Math.max(1, (hi - lo) * 0.15);
    return {
      primary: pres,
      min: lo - pad,
      max: hi + pad,
      stroke: "#e0b24d",
      fill: "#e0b24d",
      fmt: (v) => `${Math.round(v)}`,
    };
  }
  if (tab === "feels") {
    const feels = points.map((p) => p.apparentTemperature);
    const lo = Math.min(...feels);
    const hi = Math.max(...feels);
    const pad = Math.max(0.5, (hi - lo) * 0.06);
    return {
      primary: feels,
      min: lo - pad,
      max: hi + pad,
      stroke: "#c98bff",
      fill: "#c98bff",
      fmt: (v) => `${Math.round(v)}°`,
    };
  }
  const temps = points.map((p) => p.temperature);
  const lo = Math.min(...temps);
  const hi = Math.max(...temps);
  // Menší padding = vyšší amplituda (křivka využije víc výšky grafu).
  const pad = Math.max(0.5, (hi - lo) * 0.06);
  return {
    primary: temps,
    min: lo - pad,
    max: hi + pad,
    stroke: "#ff8a5b",
    fill: "#ff8a5b",
    fmt: (v) => `${Math.round(v)}°`,
  };
}

function valueLabels(points: HourlyPoint[], values: number[], minGap = 2) {
  const n = values.length;
  if (n === 0) return [];
  const MIN_GAP = Math.max(2, minGap);

  type Cand = { i: number; kind: "max" | "min"; prio: number };
  const cands: Cand[] = [];

  const localKind = (i: number): "max" | "min" => {
    const prev = values[i - 1] ?? values[i];
    const next = values[i + 1] ?? values[i];
    return values[i] >= (prev + next) / 2 ? "max" : "min";
  };

  for (let i = 1; i < n - 1; i++) {
    if (values[i] > values[i - 1] && values[i] >= values[i + 1])
      cands.push({ i, kind: "max", prio: 3 });
    else if (values[i] < values[i - 1] && values[i] <= values[i + 1])
      cands.push({ i, kind: "min", prio: 3 });
  }
  cands.push({ i: 0, kind: localKind(0), prio: 2 });
  cands.push({ i: n - 1, kind: localKind(n - 1), prio: 2 });
  points.forEach((p, i) => {
    if (new Date(p.time).getHours() % 6 === 0)
      cands.push({ i, kind: localKind(i), prio: 1 });
  });

  cands.sort((a, b) => a.i - b.i || b.prio - a.prio);

  const kept: Cand[] = [];
  for (const c of cands) {
    const last = kept[kept.length - 1];
    if (last && c.i - last.i < MIN_GAP) {
      if (c.prio > last.prio) kept[kept.length - 1] = c;
      continue;
    }
    if (last && c.i === last.i) continue;
    kept.push(c);
  }
  return kept;
}

// Zaokrouhlí maximum srážek nahoru na „hezkou" hodnotu pro osu grafu.
function niceMax(v: number): number {
  if (v <= 1) return 1;
  if (v <= 2) return 2;
  if (v <= 5) return 5;
  if (v <= 10) return 10;
  if (v <= 20) return 20;
  return Math.ceil(v / 10) * 10;
}

function isoLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function cursorTimeLabel(iso: string): string {
  const d = new Date(iso);
  return `${DAY_SHORT[d.getDay()]}, ${d.getHours()}:00`;
}

function dayShortLabel(date: string): string {
  const d = new Date(date + "T12:00:00");
  return `${DAY_SHORT[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}.`;
}

const DAY_FULL = [
  "Neděle",
  "Pondělí",
  "Úterý",
  "Středa",
  "Čtvrtek",
  "Pátek",
  "Sobota",
];

// Popisek dne pro souhrn: "Dnes", "Zítra", jinak "Čtvrtek, 2.7.".
function daySummaryLabel(date: string): string {
  const today = new Date();
  const todayStr = isoLocal(today);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const dateOnly = date.slice(0, 10);
  const d = new Date(dateOnly + "T12:00:00");
  const suffix = `${d.getDate()}.${d.getMonth() + 1}.`;
  if (dateOnly === todayStr) return `Dnes, ${suffix}`;
  if (dateOnly === isoLocal(tomorrow)) return `Zítra, ${suffix}`;
  return `${DAY_FULL[d.getDay()]}, ${suffix}`;
}
