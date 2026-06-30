import { useMemo } from "react";
import type { HourlyPoint } from "../types";
import { describeWeather } from "../lib/weatherCodes";
import { tr } from "../lib/i18n";
import WeatherIcon from "./WeatherIcon";

interface Props {
  hourly: HourlyPoint[];
  date: string;
}

// Najde nejdelší souvislé „pěkné" okno během dne (málo srážek, slabší vítr).
function findWindow(hours: HourlyPoint[]) {
  const good = (h: HourlyPoint) =>
    h.precipitation < 0.2 && h.precipitationProbability <= 35 && h.windSpeed < 8;
  let best: { start: number; end: number } | null = null;
  let run: { start: number; end: number } | null = null;
  for (let i = 0; i < hours.length; i++) {
    if (good(hours[i])) {
      if (!run) run = { start: i, end: i };
      else run.end = i;
    } else {
      run = null;
    }
    if (run && (!best || run.end - run.start > best.end - best.start)) {
      best = { start: run.start, end: run.end };
    }
  }
  return best;
}

export default function BestWindow({ hourly, date }: Props) {
  const result = useMemo(() => {
    const day = hourly.filter((h) => {
      if (h.time.slice(0, 10) !== date) return false;
      const hr = new Date(h.time).getHours();
      return hr >= 7 && hr <= 21;
    });
    if (day.length < 3) return null;
    const win = findWindow(day);
    if (!win) return { ok: false as const };
    const slice = day.slice(win.start, win.end + 1);
    const startH = new Date(slice[0].time).getHours();
    const endH = new Date(slice[slice.length - 1].time).getHours();
    // Reprezentativní počasí = prostřední hodina okna.
    const mid = slice[Math.floor(slice.length / 2)];
    return {
      ok: true as const,
      startH,
      endH: endH + 1,
      code: mid.weatherCode,
      isDay: mid.isDay,
      hours: slice.length,
    };
  }, [hourly, date]);

  if (!result) return null;

  if (!result.ok) {
    return (
      <div className="bestwin bestwin-bad">
        <span className="bestwin-ic">☔</span>
        <span>
          {tr(
            "Dnes spíš nic moc – celý den buď prší, nebo fouká. Vezmi pláštěnku.",
          )}
        </span>
      </div>
    );
  }

  const info = describeWeather(result.code);
  return (
    <div className="bestwin">
      <span className="bestwin-lead">{tr("Nejlepší okno na ven")}</span>
      <span className="bestwin-right">
        <strong>
          {result.startH}–{result.endH} h
        </strong>
        <span className="bestwin-state">
          <WeatherIcon kind={info.icon} isDay={result.isDay} size={22} />
          <span className="bestwin-sub">{tr(info.label).toLowerCase()}</span>
        </span>
      </span>
    </div>
  );
}
