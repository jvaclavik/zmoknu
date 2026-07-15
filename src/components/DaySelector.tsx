import { useEffect, useLayoutEffect, useRef } from "react";
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
  onLoadPast?: () => void;
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
  onLoadPast,
  canLoadPast = false,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const didInit = useRef(false);
  // Pro zachování pozice scrollu při donačtení starších dnů (prepend zleva).
  const prevFirstRef = useRef<string | undefined>(undefined);
  const prevScrollWidthRef = useRef(0);

  // Když se dopředu vloží starší dny, kompenzujeme scrollLeft o šířku přidaného
  // obsahu – uživatel tak zůstane vizuálně na stejném místě (nic „neuskočí").
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const newFirst = days[0]?.time;
    const prevFirst = prevFirstRef.current;
    if (prevFirst && newFirst !== prevFirst) {
      const k = days.findIndex((d) => d.time === prevFirst);
      if (k > 0) {
        list.scrollLeft += list.scrollWidth - prevScrollWidthRef.current;
      }
    }
    prevFirstRef.current = newFirst;
    prevScrollWidthRef.current = list.scrollWidth;
  }, [days]);

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
      <div className="dayselect" ref={listRef}>
        {canLoadPast && (
          <button
            type="button"
            className="dayselect-loadmore"
            onClick={() => onLoadPast?.()}
            aria-label={tr("Načíst starší týden")}
            title={tr("Načíst starší týden historie")}
          >
            <Chevron dir="left" />
            <span className="dsl-label">{tr("Starší")}</span>
          </button>
        )}
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
