import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { DailyPoint } from "../types";
import { describeWeather } from "../lib/weatherCodes";
import { isSameDay, shortDay } from "../lib/format";
import { tr } from "../lib/i18n";
import { TIER_COLOR, tempTier } from "../lib/tiers";
import WeatherIcon from "./WeatherIcon";

interface Props {
  days: DailyPoint[];
  selected: string;
  onSelect: (date: string) => void;
  onStep?: (delta: number) => void;
  canLoadPast?: boolean;
}

function label(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (isSameDay(d, today)) return tr("Dnes");
  if (isSameDay(d, tomorrow)) return tr("Zítra");
  if (isSameDay(d, yesterday)) return tr("Včera");
  return shortDay(iso);
}

export default function DaySelector({
  days,
  selected,
  onSelect,
  onStep,
  canLoadPast = false,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const didInit = useRef(false);
  const idx = days.findIndex((d) => d.time === selected);

  // Posuň aktivní den do viditelné oblasti – jen horizontálně uvnitř lišty,
  // aby se nehýbalo svislým scrollem celé stránky. Při prvním otevření
  // skoč rovnou (bez animace), následné výběry doplují plynule.
  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(".dayselect-chip.active");
    if (!list || !el) return;
    const target = el.offsetLeft - list.clientWidth / 2 + el.clientWidth / 2;
    list.scrollTo({
      left: Math.max(0, target),
      behavior: didInit.current ? "smooth" : "auto",
    });
    didInit.current = true;
  }, [selected]);

  return (
    <div className="dayselect-wrap">
      <button
        type="button"
        className="dayselect-arrow"
        aria-label={
          idx <= 0 && canLoadPast
            ? tr("Načíst předchozí den")
            : tr("Předchozí den")
        }
        title={idx <= 0 && canLoadPast ? tr("Načíst další den historie") : undefined}
        disabled={idx <= 0 && !canLoadPast}
        onClick={() => onStep?.(-1)}
      >
        <Chevron dir="left" />
      </button>
      <div className="dayselect" ref={listRef}>
        {days.map((d) => {
          const info = describeWeather(d.weatherCode);
          const date = new Date(d.time);
          const active = d.time === selected;
          const today = isSameDay(date, new Date());
          const tierColor = TIER_COLOR[tempTier(d.tempMax)];
          const style = { "--tier": tierColor } as CSSProperties;
          return (
            <button
              key={d.time}
              className={`dayselect-chip ${active ? "active" : ""} ${today ? "today" : ""}`}
              style={style}
              onClick={() => onSelect(d.time)}
            >
              <span className="ds-label">{label(d.time)}</span>
              <span className="ds-date">
                {date.getDate()}.{date.getMonth() + 1}.
              </span>
              <WeatherIcon kind={info.icon} isDay size={28} />
              <span className="ds-temps">
                <em>{Math.round(d.tempMax)}°</em>
                <i>{Math.round(d.tempMin)}°</i>
              </span>
              <span className="ds-mm">
                {d.precipitationSum > 0 ? `${d.precipitationSum.toFixed(1)} mm` : "—"}
              </span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="dayselect-arrow"
        aria-label={tr("Další den")}
        disabled={idx >= days.length - 1}
        onClick={() => onStep?.(1)}
      >
        <Chevron dir="right" />
      </button>
    </div>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d={dir === "left" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
