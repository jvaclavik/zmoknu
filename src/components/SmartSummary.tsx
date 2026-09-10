import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { CurrentWeather, DailyPoint, HourlyPoint, Minutely15 } from "../types";
import { dayHeadline } from "../lib/summary";
import { computeNowcast } from "../lib/nowcast";
import { fetchModelSeries, type ModelSeries } from "../lib/openMeteo";
import { tr } from "../lib/i18n";
import { WEATHER_MODELS } from "../lib/models";
import { describeWeather } from "../lib/weatherCodes";
import { tempColor } from "../lib/tempColor";
import { outfitAt, outfitLabel, type Activity } from "../lib/outfit";
import { useStoredState } from "../lib/useStoredState";
import {
  fetchLocalChmiPrecip,
  localPrecipText,
  type LocalPrecip,
} from "../lib/radarNowcast";
import WeatherIcon from "./WeatherIcon";

interface Props {
  day: DailyPoint;
  hourly: HourlyPoint[];
  date: string;
  isToday: boolean;
  isPast?: boolean;
  minutely?: Minutely15;
  current?: CurrentWeather;
  lat: number;
  lon: number;
  utcOffset?: number;
  feelsMax?: number;
  feelsMin?: number;
  onOpenRadar?: () => void;
}

// Pro shodu porovnáváme všechny modely nabízené v appce (kromě automatického
// „best_match"). Regionální modely bez dat pro danou lokalitu se samy vynechají.
const AGREE_MODELS = WEATHER_MODELS.filter((m) => m.id !== "best_match").map(
  (m) => m.id,
);

interface Agreement {
  spread: number; // typická odchylka denního maxima mezi modely (°C, směr. odch.)
  count: number; // kolik modelů mělo pro den data
  level: "high" | "medium" | "low" | "poor";
  maxes: number[]; // denní maxima jednotlivých modelů (pro vizualizaci)
}

function agreementFor(series: ModelSeries[], date: string): Agreement | null {
  const maxes: number[] = [];
  for (const s of series) {
    let m = -Infinity;
    for (const [t, v] of s.byTime) {
      if (t.slice(0, 10) === date && Number.isFinite(v)) m = Math.max(m, v);
    }
    if (m > -Infinity) maxes.push(m);
  }
  if (maxes.length < 2) return null;
  // Směrodatná odchylka je robustní vůči počtu modelů i ojedinělým odlehlým
  // hodnotám (jeden „ustřelený" model shodu nezboří jako u prostého max−min).
  const mean = maxes.reduce((s, v) => s + v, 0) / maxes.length;
  const variance =
    maxes.reduce((s, v) => s + (v - mean) ** 2, 0) / maxes.length;
  const spread = Math.sqrt(variance);
  const level =
    spread < 1 ? "high" : spread < 2 ? "medium" : spread < 3 ? "low" : "poor";
  return { spread, count: maxes.length, level, maxes };
}

export default function SmartSummary({
  day,
  hourly,
  date,
  isToday,
  isPast = false,
  minutely,
  current,
  lat,
  lon,
  utcOffset,
  feelsMax,
  onOpenRadar,
}: Props) {
  const [activity] = useStoredState<Activity>("wear.activity", "walk");
  const text = dayHeadline(day, hourly, date);
  const modelNowcast = isToday ? computeNowcast(minutely, utcOffset) : null;
  const [radarPrecip, setRadarPrecip] = useState<LocalPrecip | null>(null);

  useEffect(() => {
    if (!isToday) {
      setRadarPrecip(null);
      return;
    }
    const ac = new AbortController();
    fetchLocalChmiPrecip(lat, lon, ac.signal)
      .then((p) => {
        if (!ac.signal.aborted) setRadarPrecip(p);
      })
      .catch(() => {
        if (!ac.signal.aborted) setRadarPrecip(null);
      });
    return () => ac.abort();
  }, [isToday, lat, lon]);

  const radarNowcast =
    radarPrecip && radarPrecip.kind !== "dry" ? radarPrecip : null;
  const nowcast = radarNowcast
    ? {
        kind: radarNowcast.kind === "now" ? ("now" as const) : ("starting" as const),
        text: localPrecipText(radarNowcast),
      }
    : modelNowcast
      ? { kind: modelNowcast.kind, text: modelNowcast.text }
      : null;

  const [series, setSeries] = useState<ModelSeries[] | null>(null);
  useEffect(() => {
    if (isPast) {
      setSeries(null);
      return;
    }
    let cancelled = false;
    fetchModelSeries(lat, lon, "temperature_2m", AGREE_MODELS, 1)
      .then((s) => !cancelled && setSeries(s))
      .catch(() => !cancelled && setSeries(null));
    return () => {
      cancelled = true;
    };
  }, [lat, lon, isPast]);

  const agree = series ? agreementFor(series, date) : null;

  const noData = !Number.isFinite(day.weatherCode);
  const info = describeWeather(
    isToday && current ? current.weatherCode : day.weatherCode,
  );
  const isDayIcon = isToday && current ? current.isDay : true;
  const nowTemp = isToday && current ? current.temperature : day.tempMax;
  const showFeels =
    isToday &&
    current &&
    Math.abs(current.apparentTemperature - current.temperature) >= 1.5;

  const heroLabel = noData
    ? "?"
    : isToday && current
      ? tr("Teď {n}°, dnes {min}° až {max}°", {
          n: Math.round(current.temperature),
          min: Math.round(day.tempMin),
          max: Math.round(day.tempMax),
        })
      : tr("{min}° až {max}°", {
          min: Math.round(day.tempMin),
          max: Math.round(day.tempMax),
        });

  const outfit = outfitAt(
    Number.isFinite(feelsMax) ? feelsMax! : day.tempMax,
    activity,
  );
  const wearLabel = outfitLabel(outfit.top, outfit.jacket, tr);

  return (
    <section
      className="card smart-summary"
      style={
        noData
          ? undefined
          : ({ ["--now-c"]: tempColor(nowTemp) } as CSSProperties)
      }
    >
      <WeatherIcon
        className="smart-hero-icon"
        kind={noData ? "cloudy" : info.icon}
        isDay={isDayIcon}
        size={160}
      />
      <div className="smart-hero" role="group" aria-label={heroLabel}>
        <strong className="smart-hero-now">
          {noData ? (
            "?"
          ) : (
            <>
              {Math.round(nowTemp)}
              <span className="smart-hero-deg">°</span>
            </>
          )}
        </strong>
        <div className="smart-hero-line">
          <p className="smart-hero-headline">
            {noData ? tr("Bez dat") : text}
            {showFeels && current && (
              <span className="smart-hero-meta">
                {tr("pocitově")} {Math.round(current.apparentTemperature)}°
              </span>
            )}
          </p>
        </div>
        {!noData && Number.isFinite(day.tempMin) && (
          <HeroFacts
            min={day.tempMin}
            max={Number.isFinite(day.tempMax) ? day.tempMax : day.tempMin}
            now={isToday && current ? current.temperature : undefined}
            precip={day.precipitationSum}
            precipProb={day.precipitationProbabilityMax}
            wear={wearLabel}
            agree={isPast ? null : agree}
          />
        )}
        {nowcast && onOpenRadar ? (
          <button
            type="button"
            className={`smart-hero-nowcast-btn ${nowcast.kind}`}
            onClick={onOpenRadar}
            aria-label={`${nowcast.text}. ${tr("Ukázat na radaru")}`}
          >
            <span>{nowcast.text}</span>
            <ChevronGlyph />
          </button>
        ) : nowcast ? (
          <span className={`smart-hero-nowcast-btn ${nowcast.kind}`}>
            {nowcast.text}
          </span>
        ) : null}
      </div>
    </section>
  );
}

function fmtMm(n: number): string {
  if (!Number.isFinite(n) || n < 0.05) return "0 mm";
  if (n < 10) {
    const s = n.toFixed(1);
    return `${s.endsWith(".0") ? s.slice(0, -2) : s} mm`;
  }
  return `${Math.round(n)} mm`;
}

function HeroFacts({
  min,
  max,
  now,
  precip,
  precipProb,
  wear,
  agree,
}: {
  min: number;
  max: number;
  now?: number;
  precip: number;
  precipProb: number;
  wear: string;
  agree: Agreement | null;
}) {
  const span = Math.max(1, max - min);
  const pct =
    now == null
      ? null
      : Math.max(0, Math.min(100, ((now - min) / span) * 100));
  const mm = Number.isFinite(precip) ? precip : 0;
  const prob = Math.max(
    0,
    Math.min(100, Number.isFinite(precipProb) ? precipProb : 0),
  );
  const rainOp = 0.22 + 0.78 * (prob / 100);
  return (
    <div className="smart-hero-facts">
      <div className="smart-hero-scale" aria-hidden="true">
        <span style={{ color: tempColor(min) }}>{Math.round(min)}°</span>
        <span
          className="smart-hero-scale-track"
          style={{
            ["--min-c" as string]: tempColor(min),
            ["--max-c" as string]: tempColor(max),
          }}
        >
          {pct != null && (
            <span
              className="smart-hero-scale-now"
              style={{
                left: `${pct}%`,
                background: tempColor(now as number),
              }}
            />
          )}
        </span>
        <span style={{ color: tempColor(max) }}>{Math.round(max)}°</span>
      </div>
      <div className="smart-hero-rest">
        <span className="smart-hero-wear">{wear}</span>
        <span className="smart-hero-mm">
          <span
            className={`smart-hero-rain${mm < 0.05 ? " is-dry" : ""}`}
            title={tr("{prob}% šance", { prob: Math.round(prob) })}
          >
            <span style={{ opacity: rainOp }}>{fmtMm(mm)}</span>
          </span>
          {agree && agree.level !== "high" && (
            <AgreementChip key={agree.level} a={agree} />
          )}
        </span>
      </div>
    </div>
  );
}

function agreeWord(level: Agreement["level"] | null): string {
  if (level === "high") return tr("Jistota");
  if (level === "medium") return tr("Možná");
  if (level === "low") return tr("Nejisté");
  return tr("Nevíme");
}

function agreeExplain(a: Agreement): string {
  const n = a.spread.toFixed(a.spread < 10 ? 1 : 0);
  if (a.level === "high") {
    return tr(
      "Modely se shodují. Denní maxima se liší jen o ~{n}° – předpovědi lze věřit.",
      { n },
    );
  }
  if (a.level === "medium") {
    return tr("Modely se mírně rozcházejí (~{n}°). Ber to s rezervou.", { n });
  }
  if (a.level === "low") {
    return tr("Modely se rozcházejí (~{n}°). Ber to jako hrubý odhad.", { n });
  }
  return tr("Modely se neshodují (~{n}°). Ber to jako hrubý odhad.", { n });
}

function AgreementChip({ a }: { a: Agreement }) {
  const level = a.level;
  const label = agreeWord(level);
  const explain = agreeExplain(a);
  const spread = a.spread.toFixed(a.spread < 10 ? 1 : 0);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
    maxH: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const m = 8;
    const maxW = Math.min(280, window.innerWidth - m * 2);
    let left = r.left + r.width / 2 - maxW / 2;
    left = Math.max(m, Math.min(left, window.innerWidth - m - maxW));
    const spaceBelow = window.innerHeight - r.bottom - m - 8;
    const spaceAbove = r.top - m - 8;
    if (spaceBelow >= 120 || spaceBelow >= spaceAbove) {
      setPos({ left, width: maxW, top: r.bottom + 8, maxH: Math.max(60, spaceBelow) });
    } else {
      setPos({
        left,
        width: maxW,
        bottom: window.innerHeight - r.top + 8,
        maxH: Math.max(60, spaceAbove),
      });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || tipRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`model-agree-plain lvl-${level}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${tr("Shoda modelů")}: ${label}`}
        onClick={() => setOpen((o) => !o)}
      >
        <UnsureGlyph />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={tipRef}
            className={`model-agree-tip lvl-${level}`}
            role="dialog"
            style={{
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxH,
              ...(pos.top != null ? { top: pos.top } : { bottom: pos.bottom }),
            }}
          >
            <p className="agree-kicker">{tr("Shoda modelů")}</p>
            <div className="agree-head">
              <span className="agree-level">
                <strong>{label}</strong>
              </span>
              <span className="agree-spread">±{spread}°</span>
            </div>
            <AgreementViz a={a} />
            <p className="agree-explain">{explain}</p>
          </div>,
          document.body,
        )}
    </>
  );
}

// Vizualizace shody: každá tečka = denní maximum jednoho modelu na pevné škále
// (±6 °C kolem průměru). Těsně u sebe = velká shoda, rozházené = malá.
function AgreementViz({ a }: { a: Agreement }) {
  const mean = a.maxes.reduce((s, v) => s + v, 0) / a.maxes.length;
  const HALF = 6; // půlka okna škály (°C)
  const pct = (v: number) =>
    Math.max(2, Math.min(98, 50 + ((v - mean) / (HALF * 2)) * 100));
  return (
    <div className="agree-viz" aria-hidden="true">
      <div className="agree-track">
        <span className="agree-mid" />
        {a.maxes.map((v, i) => (
          <span
            key={i}
            className="agree-dot"
            style={{ left: `${pct(v)}%` }}
          />
        ))}
      </div>
      {/* Konce jsou pevné (průměr ±6 °C) → měřítko je stejné každý den,
          takže rozptyl teček jde porovnávat mezi dny. Uprostřed je průměr. */}
      <div className="agree-ends">
        <span>−{HALF}°</span>
        <span>{Math.round(mean)}°</span>
        <span>+{HALF}°</span>
      </div>
    </div>
  );
}

function UnsureGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M9.2 9.2a2.8 2.8 0 1 1 4.4 2.3c-.8.5-1.6 1-1.6 2.2" />
      <path d="M12 17.2h.01" />
    </svg>
  );
}

function ChevronGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
