export type IconKind =
  | "clear"
  | "partly"
  | "cloudy"
  | "overcast"
  | "fog"
  | "drizzle"
  | "rain"
  | "snow"
  | "sleet"
  | "thunder";

interface CodeInfo {
  label: string;
  icon: IconKind;
}

// Mapování WMO weather code (Open-Meteo) na český popis a typ ikony.
const CODES: Record<number, CodeInfo> = {
  0: { label: "Jasno", icon: "clear" },
  1: { label: "Skoro jasno", icon: "partly" },
  2: { label: "Polojasno", icon: "partly" },
  3: { label: "Zataženo", icon: "overcast" },
  45: { label: "Mlha", icon: "fog" },
  48: { label: "Mrznoucí mlha", icon: "fog" },
  51: { label: "Slabé mrholení", icon: "drizzle" },
  53: { label: "Mrholení", icon: "drizzle" },
  55: { label: "Silné mrholení", icon: "drizzle" },
  56: { label: "Mrznoucí mrholení", icon: "sleet" },
  57: { label: "Silné mrznoucí mrholení", icon: "sleet" },
  61: { label: "Slabý déšť", icon: "rain" },
  63: { label: "Déšť", icon: "rain" },
  65: { label: "Vydatný déšť", icon: "rain" },
  66: { label: "Mrznoucí déšť", icon: "sleet" },
  67: { label: "Silný mrznoucí déšť", icon: "sleet" },
  71: { label: "Slabé sněžení", icon: "snow" },
  73: { label: "Sněžení", icon: "snow" },
  75: { label: "Vydatné sněžení", icon: "snow" },
  77: { label: "Sněhová zrna", icon: "snow" },
  80: { label: "Slabé přeháňky", icon: "rain" },
  81: { label: "Přeháňky", icon: "rain" },
  82: { label: "Silné přeháňky", icon: "rain" },
  85: { label: "Sněhové přeháňky", icon: "snow" },
  86: { label: "Silné sněhové přeháňky", icon: "snow" },
  95: { label: "Bouřka", icon: "thunder" },
  96: { label: "Bouřka s kroupami", icon: "thunder" },
  99: { label: "Silná bouřka s kroupami", icon: "thunder" },
};

export function describeWeather(code: number): CodeInfo {
  return CODES[code] ?? { label: "Neznámé", icon: "cloudy" };
}
