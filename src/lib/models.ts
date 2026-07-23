import { tr } from "./i18n";

// Modely počasí dostupné přes Open-Meteo. "best_match" = automatický výběr
// nejlepšího modelu pro danou lokalitu (výchozí). Ostatní jde zvolit jako
// globální zdroj dat nebo je porovnat v meteogramu (multimód).
export interface WeatherModel {
  id: string;
  label: string;
  short: string;
  color: string;
  // Vlaječka země, které se model primárně týká (🌍 = globální/automatický).
  flag: string;
}

export const WEATHER_MODELS: WeatherModel[] = [
  { id: "best_match", label: "Automaticky (nejlepší shoda)", short: "Auto", color: "#5bb6ff", flag: "🌍" },
  { id: "icon_seamless", label: "DWD ICON (Německo)", short: "ICON", color: "#ffd166", flag: "🇩🇪" },
  { id: "gfs_seamless", label: "NOAA GFS (USA)", short: "GFS", color: "#4ccf8e", flag: "🇺🇸" },
  { id: "meteofrance_seamless", label: "Météo-France (ARPEGE/AROME)", short: "MF", color: "#ff8fb0", flag: "🇫🇷" },
  { id: "ecmwf_ifs025", label: "ECMWF IFS (Evropa)", short: "ECMWF", color: "#a78bfa", flag: "🇪🇺" },
  { id: "ukmo_seamless", label: "UK Met Office", short: "UKMO", color: "#f0883e", flag: "🇬🇧" },
  { id: "kma_seamless", label: "KMA (Korea)", short: "KMA", color: "#00b4d8", flag: "🇰🇷" },
  { id: "jma_seamless", label: "JMA (Japonsko)", short: "JMA", color: "#e63946", flag: "🇯🇵" },
  { id: "meteoswiss_icon_seamless", label: "MeteoSwiss ICON-CH (Švýcarsko)", short: "ICON-CH", color: "#d81159", flag: "🇨🇭" },
  { id: "metno_seamless", label: "MET Norway (Norsko)", short: "METNO", color: "#8ecae6", flag: "🇳🇴" },
  { id: "gem_seamless", label: "GEM (Kanada)", short: "GEM", color: "#7ad0e6", flag: "🇨🇦" },
  { id: "bom_access_global", label: "BOM ACCESS-G (Austrálie)", short: "BOM", color: "#9b5de5", flag: "🇦🇺" },
  { id: "cma_grapes_global", label: "CMA GRAPES (Čína)", short: "CMA", color: "#f4a259", flag: "🇨🇳" },
  { id: "knmi_seamless", label: "KNMI HARMONIE (Nizozemsko)", short: "KNMI", color: "#90be6d", flag: "🇳🇱" },
  { id: "dmi_seamless", label: "DMI HARMONIE (Dánsko)", short: "DMI", color: "#e9c46a", flag: "🇩🇰" },
  { id: "italia_meteo_arpae_icon_2i", label: "ItaliaMeteo ARPAE (Itálie)", short: "ARPAE", color: "#2a9d8f", flag: "🇮🇹" },
  { id: "geosphere_seamless", label: "GeoSphere AROME (Rakousko)", short: "GEO", color: "#f4978e", flag: "🇦🇹" },
  { id: "chmi_aladin_cz_1km", label: "ČHMÚ ALADIN (Česko, 1 km)", short: "ČHMÚ", color: "#ff5470", flag: "🇨🇿" },
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

export function modelFlag(id: string): string {
  return modelById(id)?.flag ?? "🌍";
}
