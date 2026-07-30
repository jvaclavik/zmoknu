export interface GeoLocation {
  id?: number;
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
}

export interface CurrentWeather {
  time: string;
  temperature: number;
  apparentTemperature: number;
  isDay: boolean;
  precipitation: number;
  weatherCode: number;
  windSpeed: number;
  windDirection: number;
  windGusts: number;
  humidity: number;
  pressure: number;
  cloudCover: number;
}

export interface HourlyPoint {
  time: string;
  temperature: number;
  apparentTemperature: number;
  precipitation: number;
  precipitationProbability: number;
  weatherCode: number;
  windSpeed: number;
  windGusts: number;
  windDirection: number;
  humidity: number;
  dewPoint: number;
  pressure: number;
  cloudCover: number;
  cloudLow: number;
  cloudMid: number;
  cloudHigh: number;
  cape: number;
  uvIndex: number;
  uvIndexClearSky: number;
  isDay: boolean;
}

export interface DailyPoint {
  time: string;
  weatherCode: number;
  tempMax: number;
  tempMin: number;
  precipitationSum: number;
  precipitationProbabilityMax: number;
  windSpeedMax: number;
  windGustsMax: number;
  sunrise: string;
  sunset: string;
  uvIndexMax: number;
}

export interface Minutely15 {
  time: string[];
  precipitation: number[];
}

export interface Forecast {
  timezone: string;
  // Posun zóny lokality vůči UTC v sekundách (z Open-Meteo). Časy v hourly/daily
  // jsou „naivní" lokální řetězce lokality – offset umožní správně určit „teď".
  utcOffsetSeconds: number;
  current: CurrentWeather;
  hourly: HourlyPoint[];
  daily: DailyPoint[];
  minutely15?: Minutely15;
}

export interface RadarFrame {
  time: number;
  path: string;
  kind: "past" | "nowcast";
}

export interface RadarData {
  host: string;
  frames: RadarFrame[];
  nowcastStartIndex: number;
}
