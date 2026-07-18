import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { DailyPoint, HourlyPoint } from "../types";
import type { AirQuality, LevelTier } from "../lib/airQuality";
import { aqiLabel, pmLevel, pollenLevel } from "../lib/airQuality";
import { stormRiskForDate } from "../lib/storm";
import { fetchFlood, floodRisk, type FloodData } from "../lib/flood";
import { clockTime } from "../lib/format";
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

function fmtDur(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h} h ${m} min`;
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
  const sunriseD = new Date(day.sunrise);
  const sunsetD = new Date(day.sunset);
  const goldenMin = goldenHourMinutes(lat ?? 50, dayOfYear(date));
  const goldenAmEnd = new Date(sunriseD.getTime() + goldenMin * 60_000);
  const goldenPmStart = new Date(sunsetD.getTime() - goldenMin * 60_000);
  const goldenOk =
    Number.isFinite(sunriseD.getTime()) &&
    Number.isFinite(sunsetD.getTime()) &&
    goldenPmStart.getTime() > goldenAmEnd.getTime();

  const storm =
    hourly && hourly.length ? stormRiskForDate(hourly, date) : null;

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
          <div className="dd-grid dd-grid-sun">
            <Tile icon="sunrise" label={tr("Východ / západ")}>
              <span className="dd-tile-value">
                {clockTime(new Date(day.sunrise))}
                <em className="dd-tile-sep"> / </em>
                {clockTime(new Date(day.sunset))}
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
            {goldenOk && (
              <Tile icon="golden" label={tr("Zlatá hodinka")}>
                <span className="dd-tile-value dd-tile-value-sm">
                  {clockTime(sunriseD)}–{clockTime(goldenAmEnd)}
                </span>
                <span className="dd-tile-note">
                  {tr("večer")} {clockTime(goldenPmStart)}–{clockTime(sunsetD)}
                </span>
              </Tile>
            )}
            {lat != null && (
              <DaylightYearChart
                lat={lat}
                date={date}
                lengthLabel={daylight(day.sunrise, day.sunset)}
                todayHours={
                  (new Date(day.sunset).getTime() -
                    new Date(day.sunrise).getTime()) /
                  3_600_000
                }
              />
            )}
          </div>

          {storm && (
            <>
              <div className="dd-group-title">{tr("Bouřky")}</div>
              <div className="dd-grid">
                <Tile
                  icon="storm"
                  label={tr("Riziko bouřek")}
                  className={storm.level === "high" ? "dd-tile-alert" : ""}
                >
                  <div className="dd-tile-main">
                    <LevelPill tier={storm.tier} text={storm.label} />
                  </div>
                  {storm.from ? (
                    <span className="dd-tile-note">
                      {tr("mezi {a} a {b}", {
                        a: clockTime(new Date(storm.from)),
                        b: clockTime(
                          new Date(new Date(storm.to!).getTime() + 3_600_000),
                        ),
                      })}
                      {storm.hail ? ` · ${tr("možné kroupy")}` : ""}
                    </span>
                  ) : storm.maxCape > 0 ? (
                    <span className="dd-tile-note">
                      {tr("energie CAPE {n} J/kg", {
                        n: Math.round(storm.maxCape),
                      })}
                    </span>
                  ) : null}
                </Tile>
              </div>
            </>
          )}

          {floodInfo && flood && (
            <>
              <div className="dd-group-title">{tr("Voda")}</div>
              <div className="dd-grid">
                <Tile
                  icon="flood"
                  label={tr("Riziko povodní")}
                  className={floodInfo.risk.alert ? "dd-tile-alert" : ""}
                >
                  <div className="dd-tile-main">
                    <LevelPill
                      tier={floodInfo.risk.tier}
                      text={floodInfo.risk.label}
                    />
                    <span className="dd-tile-value dd-tile-value-sm">
                      {floodInfo.q.toFixed(1)}
                      <em className="dd-tile-unit"> m³/s</em>
                    </span>
                  </div>
                  {flood.peakDate !== date &&
                  flood.peakValue >= flood.thresholds.p90 ? (
                    <span className="dd-tile-note">
                      {tr("vrchol {d}: {n} m³/s", {
                        d: shortDate(flood.peakDate),
                        n: flood.peakValue.toFixed(1),
                      })}
                    </span>
                  ) : (
                    <span className="dd-tile-note">
                      {tr("průtok řek (GloFAS)")}
                    </span>
                  )}
                </Tile>
              </div>
            </>
          )}

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

// Graf, jak se během roku prodlužuje a zkracuje den, s markerem aktuálního dne.
// Slučuje v sobě i hodnotu „Délka dne“ (lengthLabel) – tvoří širokou dlaždici.
function DaylightYearChart({
  lat,
  date,
  lengthLabel,
  todayHours,
}: {
  lat: number;
  date: string;
  lengthLabel: string;
  todayHours: number;
}) {
  // Graf kreslíme v pixelech (viewBox = skutečná šířka × výška), aby byl vždy na
  // 100 % šířky, s pevnou max. výškou a bez deformace (kulaté body, ostrý text).
  const svgRef = useRef<SVGSVGElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const [cw, setCw] = useState(0);
  useLayoutEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const update = () => setCw(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = Math.round(Math.min(150, Math.max(96, cw / 3.2)));
  const padL = 26; // levý žlábek pro popisky osy y (hodiny)
  const padR = 8;
  const padT = 8;
  const padB = 18; // dolní pruh pro čísla měsíců
  const DAYS = 365;

  // Popisky měsíců jako čísla 1–12.
  const CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

  const { vals, lo, hi } = useMemo(() => {
    const v = Array.from({ length: DAYS }, (_, i) => daylightHours(lat, i + 1));
    return { vals: v, lo: Math.min(...v), hi: Math.max(...v) };
  }, [lat]);

  const idx = Math.max(0, Math.min(DAYS - 1, dayOfYear(date) - 1));
  const range = Math.max(0.5, hi - lo);
  const X = (i: number) => padL + (i / (DAYS - 1)) * (cw - padL - padR);
  const Y = (v: number) => padT + (1 - (v - lo) / range) * (H - padT - padB);

  // Ukotvení: posuneme celou křivku tak, aby vybraný den seděl přesně na hodnotu
  // z východu/západu (todayHours). Posun je konstantní → tvar i pozice křivky se
  // nemění, jen se zobrazované hodnoty srovnají s tím, co je napsané mimo graf.
  const offset = Number.isFinite(todayHours) ? todayHours - vals[idx] : 0;
  const dispVal = (i: number) => vals[i] + offset;

  const linePath = vals
    .map((v, i) => `${i === 0 ? "M" : "L"} ${X(i).toFixed(1)} ${Y(v).toFixed(1)}`)
    .join(" ");
  const areaPath = `${linePath} L ${X(DAYS - 1).toFixed(1)} ${H - padB} L ${X(0).toFixed(1)} ${H - padB} Z`;

  // Vodorovné čáry osy y po celých hodinách (krok 4 h) s popiskem.
  const yTicks: number[] = [];
  for (let h = Math.ceil(lo / 4) * 4; h <= hi; h += 4) yTicks.push(h);

  const prev = vals[Math.max(0, idx - 1)];
  const next = vals[Math.min(DAYS - 1, idx + 1)];
  const deltaMin = Math.round(((next - prev) / 2) * 60);
  let trend: string;
  if (deltaMin > 0) trend = tr("prodlužuje se o {n} min/den", { n: deltaMin });
  else if (deltaMin < 0)
    trend = tr("zkracuje se o {n} min/den", { n: -deltaMin });
  else
    trend =
      vals[idx] > (lo + hi) / 2
        ? tr("nejdelší den v roce")
        : tr("nejkratší den v roce");

  const markX = X(idx);
  const markY = Y(vals[idx]);

  const [hover, setHover] = useState<{
    idx: number;
    xPct: number;
    yPct: number;
  } | null>(null);
  const year = Number(date.slice(0, 4)) || new Date().getFullYear();

  // Mapování kurzoru na den v roce přes getScreenCTM – korektně i když je SVG
  // kvůli poměru stran vycentrované s okraji (jinak by odchylka rostla od středu).
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    const rect = svg?.getBoundingClientRect();
    if (!svg || !ctm || !rect || rect.width === 0) return;
    const userX = new DOMPoint(e.clientX, e.clientY).matrixTransform(
      ctm.inverse(),
    ).x;
    const i = Math.max(
      0,
      Math.min(
        DAYS - 1,
        Math.round(((userX - padL) / (cw - padL - padR)) * (DAYS - 1)),
      ),
    );
    const snap = new DOMPoint(X(i), Y(vals[i])).matrixTransform(ctm);
    const xPct = ((snap.x - rect.left) / rect.width) * 100;
    const yPct = ((snap.y - rect.top) / rect.height) * 100;
    setHover({ idx: i, xPct, yPct });
  };

  const hi2 = hover ? hover.idx : null;
  const hoverDate = hi2 != null ? new Date(Date.UTC(year, 0, 1 + hi2)) : null;
  const hoverLabel = hoverDate
    ? `${hoverDate.getUTCDate()}. ${hoverDate.getUTCMonth() + 1}.`
    : "";
  const hoverPct = hover ? hover.xPct : 0;
  const xt = hoverPct < 18 ? "0" : hoverPct > 82 ? "-100%" : "-50%";
  // Tooltip nad bodem; u horního okraje se překlopí pod něj, ať je vidět.
  const flipDown = (hover?.yPct ?? 100) < 34;
  const yt = flipDown ? "8px" : "calc(-100% - 8px)";

  return (
    <div className="dd-tile dd-daylight">
      <div className="dd-daylight-head">
        <span className="dd-tile-ico" aria-hidden="true">
          <DetailIcon kind="daylight" />
        </span>
        <div className="dd-daylight-headtext">
          <span className="dd-tile-label">{tr("Délka dne")}</span>
          <div className="dd-daylight-now">
            <span className="dd-tile-value">{lengthLabel}</span>
            <span className="dd-daylight-trend">{trend}</span>
          </div>
        </div>
      </div>
      <div className="dd-daylight-plot" ref={plotRef}>
        {cw > 0 && (
        <svg
          ref={svgRef}
          className="dd-daylight-svg"
          viewBox={`0 0 ${cw} ${H}`}
          style={{ height: `${H}px` }}
          role="img"
          aria-label={tr("Délka dne během roku")}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id="dd-day-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(255,209,102,0.35)" />
              <stop offset="100%" stopColor="rgba(255,209,102,0)" />
            </linearGradient>
          </defs>
          {yTicks.map((h) => (
            <g key={`y${h}`}>
              <line
                x1={padL}
                y1={Y(h)}
                x2={cw - padR}
                y2={Y(h)}
                stroke="rgba(255,255,255,0.06)"
                strokeWidth="1"
              />
              <text
                x={padL - 5}
                y={Y(h) + 3}
                className="dd-daylight-axis"
                textAnchor="end"
              >
                {h} h
              </text>
            </g>
          ))}
          {CUM.map((c, m) => (
            <text
              key={`m${m}`}
              x={X(c + 15)}
              y={H - 5}
              className="dd-daylight-axis"
              textAnchor="middle"
            >
              {m + 1}
            </text>
          ))}
          <path d={areaPath} fill="url(#dd-day-grad)" />
          <path
            d={linePath}
            fill="none"
            stroke="#ffd166"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <line
            x1={markX}
            y1={padT - 4}
            x2={markX}
            y2={H - padB}
            stroke="var(--accent, #4aa8ff)"
            strokeWidth="1.5"
            strokeDasharray="3 3"
          />
          <circle
            cx={markX}
            cy={markY}
            r="4.5"
            fill="var(--accent, #4aa8ff)"
            stroke="#0b1f33"
            strokeWidth="1.5"
          />
          {hi2 != null && (
            <g pointerEvents="none">
              <line
                x1={X(hi2)}
                y1={padT - 4}
                x2={X(hi2)}
                y2={H - padB}
                stroke="rgba(255,255,255,0.5)"
                strokeWidth="1"
              />
              <circle
                cx={X(hi2)}
                cy={Y(vals[hi2])}
                r="4"
                fill="#fff"
                stroke="#0b1f33"
                strokeWidth="1.5"
              />
            </g>
          )}
        </svg>
        )}
        {hi2 != null && (
          <div
            className="dd-daylight-tip"
            style={{
              left: `${hoverPct}%`,
              top: `${hover?.yPct ?? 0}%`,
              transform: `translate(${xt}, ${yt})`,
            }}
          >
            <strong>{fmtDur(dispVal(hi2))}</strong> · {hoverLabel}
          </div>
        )}
      </div>
    </div>
  );
}

function Tile({
  icon,
  emoji,
  label,
  className,
  children,
}: {
  icon?: DetailIconKind;
  emoji?: string;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`dd-tile${className ? ` ${className}` : ""}`}>
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

type DetailIconKind =
  | "sunrise"
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
