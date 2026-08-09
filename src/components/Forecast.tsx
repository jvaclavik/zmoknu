import type { DailyPoint, HourlyPoint, Minutely15 } from "../types";
import SmartSummary from "./SmartSummary";
import HourlyForecast from "./HourlyForecast";

interface Props {
  day?: DailyPoint | null;
  dayHasData: boolean;
  hourly: HourlyPoint[];
  date: string;
  isToday: boolean;
  minutely?: Minutely15;
  lat: number;
  lon: number;
  utcOffset?: number;
  feelsMax?: number;
  feelsMin?: number;
  onSelectDay?: (date: string) => void;
}

// Sloučená karta „Předpověď": nahoře souhrn vybraného dne, pod ním vícedenní
// výhled. Vybraný den v tabulce řídí, co ukazuje souhrn (klik → jiný den).
export default function Forecast({
  day,
  dayHasData,
  hourly,
  date,
  isToday,
  minutely,
  lat,
  lon,
  utcOffset,
  feelsMax,
  feelsMin,
  onSelectDay,
}: Props) {
  return (
    <section className="card forecast-card">
      {day && dayHasData && (
        <>
          <SmartSummary
            day={day}
            hourly={hourly}
            date={date}
            isToday={isToday}
            minutely={minutely}
            lat={lat}
            lon={lon}
            utcOffset={utcOffset}
            feelsMax={feelsMax}
            feelsMin={feelsMin}
          />
          <div className="forecast-sep" />
        </>
      )}
      <HourlyForecast
        hourly={hourly}
        activeDate={date}
        utcOffset={utcOffset}
        onSelectDay={onSelectDay}
      />
    </section>
  );
}
