import { tr } from "./i18n";

// Modely počasí dostupné přes Open-Meteo. "best_match" = automatický výběr
// nejlepšího modelu pro danou lokalitu (výchozí). Ostatní jde zvolit jako
// globální zdroj dat nebo je porovnat v meteogramu (multimód).
export interface WeatherModel {
  id: string;
  label: string;
  short: string;
  color: string;
}

export const WEATHER_MODELS: WeatherModel[] = [
  { id: "best_match", label: "Automaticky (nejlepší shoda)", short: "Auto", color: "#5bb6ff" },
  { id: "chmi_aladin_cz_1km", label: "ČHMÚ ALADIN (Česko, 1 km)", short: "ČHMÚ", color: "#ff5470" },
  { id: "icon_seamless", label: "ICON · DWD (Německo)", short: "ICON", color: "#ffd166" },
  { id: "ecmwf_ifs025", label: "ECMWF IFS (Evropa)", short: "ECMWF", color: "#a78bfa" },
  { id: "gfs_seamless", label: "GFS · NOAA (USA)", short: "GFS", color: "#4ccf8e" },
  { id: "meteofrance_seamless", label: "Météo-France (AROME/ARPEGE)", short: "MF", color: "#ff8fb0" },
  { id: "ukmo_seamless", label: "UK Met Office", short: "UKMO", color: "#f0883e" },
  { id: "gem_seamless", label: "GEM (Kanada)", short: "GEM", color: "#7ad0e6" },
];

export const DEFAULT_MODEL = "best_match";

export function modelById(id: string): WeatherModel | undefined {
  return WEATHER_MODELS.find((m) => m.id === id);
}

export function modelLabel(id: string): string {
  return tr(modelById(id)?.label ?? id);
}

export function modelColor(id: string): string {
  return modelById(id)?.color ?? "#9aa7c4";
}
