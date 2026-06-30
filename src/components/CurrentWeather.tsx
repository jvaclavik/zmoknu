import type {
  CurrentWeather as Current,
  DailyPoint,
  GeoLocation,
  HourlyPoint,
} from "../types";
import { describeWeather } from "../lib/weatherCodes";
import { dayHeader, windDirLabel } from "../lib/format";
import WeatherIcon from "./WeatherIcon";

interface Props {
  location: GeoLocation;
  current: Current;
  day?: DailyPoint;
  hourly: HourlyPoint[];
  selectedDate: string;
  isToday: boolean;
}

function comfortLabel(feels: number, humidity: number, wind: number): string {
  if (feels >= 30) return humidity >= 55 ? "Dusno" : "Horko";
  if (feels >= 25) return humidity >= 70 ? "Dusno" : "Teplo";
  if (feels >= 18) return "Příjemně";
  if (feels >= 11) return "Svěží";
  if (feels >= 4) return wind >= 6 || humidity >= 85 ? "Sychravo" : "Chladno";
  if (feels >= -4) return "Studeno";
  return "Mrazivo";
}

function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

export default function CurrentWeather({
  location,
  current,
  day,
  hourly,
  selectedDate,
  isToday,
}: Props) {
  // Agregace hodinových dat vybraného dne (pro jiné dny než dnešek).
  const dayHours = hourly.filter((h) => h.time.slice(0, 10) === selectedDate);
  const warmHour =
    dayHours.length > 0
      ? dayHours.reduce((a, b) => (b.temperature > a.temperature ? b : a))
      : undefined;

  const info = describeWeather(isToday ? current.weatherCode : day?.weatherCode ?? current.weatherCode);
  const isDay = isToday ? current.isDay : true;

  // Hodnoty pro headline + boxíky podle toho, zda jde o dnešek nebo jiný den.
  const tempMain = isToday ? Math.round(current.temperature) : Math.round(day?.tempMax ?? current.temperature);
  const tempMin = day ? Math.round(day.tempMin) : undefined;
  const feels = isToday
    ? current.apparentTemperature
    : warmHour?.apparentTemperature ?? day?.tempMax ?? current.apparentTemperature;
  const humidity = isToday ? current.humidity : avg(dayHours.map((h) => h.humidity));
  const wind = isToday ? current.windSpeed : day?.windSpeedMax ?? 0;
  const gusts = isToday ? current.windGusts : day?.windGustsMax ?? 0;
  const cloud = isToday ? current.cloudCover : avg(dayHours.map((h) => h.cloudCover));
  const precip = isToday ? current.precipitation : day?.precipitationSum ?? 0;
  const comfort = comfortLabel(feels, humidity, wind);

  return (
    <section className="card current">
      <div className="current-head">
        <div>
          <h1 className="loc-name">{location.name}</h1>
          <p className="loc-meta">
            {[location.admin1, location.country].filter(Boolean).join(", ")}
            <span className="loc-day">{dayHeader(selectedDate)}</span>
          </p>
        </div>
        <WeatherIcon kind={info.icon} isDay={isDay} size={92} />
      </div>

      <div className="current-main">
        <div className="big-temp">
          {tempMain}°
          {!isToday && tempMin !== undefined && (
            <span className="big-temp-min">/ {tempMin}°</span>
          )}
        </div>
        <div className="current-desc">
          <span className="desc-label">{info.label}</span>
          <span className="feels">
            {isToday ? "Pocitově" : "Pocitově max"} {Math.round(feels)}°
          </span>
        </div>
      </div>

      <div className="current-stats comfort">
        <Stat
          label="Srážky"
          value={`${precip.toFixed(1)} mm`}
          sub={isToday ? undefined : "celkem"}
        />
        <Stat label="Vlhkost" value={`${Math.round(humidity)} %`} />
        <Stat label="Pocitově" value={`${Math.round(feels)}°`} />
        <Stat label="Komfort" value={comfort} />
      </div>

      <div className="current-stats">
        <Stat
          label="Vítr"
          value={`${wind.toFixed(1)} m/s`}
          sub={isToday ? windDirLabel(current.windDirection) : "max"}
        />
        <Stat label="Nárazy" value={`${gusts.toFixed(1)} m/s`} />
        <Stat label="Oblačnost" value={`${Math.round(cloud)} %`} />
        {isToday && <Stat label="Tlak" value={`${Math.round(current.pressure)} hPa`} />}
      </div>
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {value}
        {sub && <em className="stat-sub"> {sub}</em>}
      </span>
    </div>
  );
}
