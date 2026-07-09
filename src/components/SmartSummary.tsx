import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DailyPoint, HourlyPoint, Minutely15 } from "../types";
import { daySummary } from "../lib/summary";
import { computeNowcast } from "../lib/nowcast";
import { fetchModelSeries, type ModelSeries } from "../lib/openMeteo";
import { getLang, tr } from "../lib/i18n";
import { DaySummary } from "./Meteogram";
import { TIER_COLOR, TIER_LABEL, tempTier } from "../lib/tiers";

interface Props {
  day: DailyPoint;
  hourly: HourlyPoint[];
  date: string;
  isToday: boolean;
  minutely?: Minutely15;
  lat: number;
  lon: number;
  feelsMax?: number;
  feelsMin?: number;
}

// Světové modely pro porovnání shody (edukace: shoda = jistota).
const AGREE_MODELS = ["icon_seamless", "ecmwf_ifs025", "gfs_seamless", "gem_seamless"];

interface Agreement {
  spread: number; // rozptyl denního maxima mezi modely (°C)
  count: number; // kolik modelů mělo pro den data
  level: "high" | "medium" | "low";
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
  const spread = Math.max(...maxes) - Math.min(...maxes);
  const level = spread < 2 ? "high" : spread < 4 ? "medium" : "low";
  return { spread, count: maxes.length, level };
}

export default function SmartSummary({
  day,
  hourly,
  date,
  isToday,
  minutely,
  lat,
  lon,
  feelsMax,
  feelsMin,
}: Props) {
  const text = daySummary(day, hourly, date);
  const nowcast = isToday ? computeNowcast(minutely) : null;

  const [series, setSeries] = useState<ModelSeries[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchModelSeries(lat, lon, "temperature_2m", AGREE_MODELS, 1)
      .then((s) => !cancelled && setSeries(s))
      .catch(() => !cancelled && setSeries(null));
    return () => {
      cancelled = true;
    };
  }, [lat, lon]);

  const agree = series ? agreementFor(series, date) : null;

  const tier = tempTier(feelsMax ?? day.tempMax);

  return (
    <section className="card smart-summary">
      <DaySummary day={day} feelsMax={feelsMax} feelsMin={feelsMin} hideTone />

      {nowcast && (
        <div className="smart-summary-row">
          <div className={`smart-nowcast ${nowcast.kind}`}>
            <DropGlyph />
            <span>{nowcast.text}</span>
          </div>
        </div>
      )}

      {(text || agree) && (
        <div className="smart-summary-foot">
          {text && <p className="smart-summary-text">{text}</p>}
          {agree && <AgreementChip a={agree} />}
          <span
            className="mg-daysum-tone smart-summary-tone"
            style={{ background: TIER_COLOR[tier] }}
          >
            {tr(TIER_LABEL[tier])}
          </span>
        </div>
      )}
    </section>
  );
}

function AgreementChip({ a }: { a: Agreement }) {
  const en = getLang() === "en";
  const label =
    a.level === "high"
      ? tr("vysoká")
      : a.level === "medium"
        ? tr("střední")
        : tr("nízká");
  const spread = a.spread.toFixed(a.spread < 10 ? 1 : 0);
  const explain = en
    ? `Agreement of ${a.count} global models (ICON, ECMWF, GFS, GEM). When they agree the forecast is more certain; here they differ by ${spread}° in the day's high, so confidence is ${label}.`
    : `Shoda ${a.count} světových modelů (ICON, ECMWF, GFS, GEM). Když se shodují, je předpověď jistější; tady se v denním maximu liší o ${spread}°, takže jistota je ${label}.`;
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
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
    // Vodorovně vycentrovat na tlačítko, ale držet v rámci viewportu.
    let left = r.left + r.width / 2 - maxW / 2;
    left = Math.max(m, Math.min(left, window.innerWidth - m - maxW));
    // Svisle: pod tlačítko, a když tam není místo, nad tlačítko.
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
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`model-agree-plain lvl-${a.level}`}
        title={explain}
        aria-expanded={open}
        aria-label={explain}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="model-agree-dot" aria-hidden="true" />
        <span className="model-agree-txt">
          {tr("Shoda modelů")}: {label}
          <span className="model-agree-spread">±{spread}°</span>
        </span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            className={`model-agree-tip lvl-${a.level}`}
            role="tooltip"
            style={{
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxH,
              ...(pos.top != null ? { top: pos.top } : { bottom: pos.bottom }),
            }}
          >
            {explain}
          </div>,
          document.body,
        )}
    </>
  );
}

function DropGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3s6 6.5 6 10.5a6 6 0 0 1-12 0C6 9.5 12 3 12 3z" />
    </svg>
  );
}
