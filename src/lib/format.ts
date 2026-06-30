import { getLang } from "./i18n";

const DAY_NAMES_CS = ["Ne", "Po", "Út", "St", "Čt", "Pá", "So"];
const DAY_NAMES_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_LONG_CS = [
  "Neděle",
  "Pondělí",
  "Úterý",
  "Středa",
  "Čtvrtek",
  "Pátek",
  "Sobota",
];
const DAY_LONG_EN = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function dayNames() {
  return getLang() === "en" ? DAY_NAMES_EN : DAY_NAMES_CS;
}
function dayLong() {
  return getLang() === "en" ? DAY_LONG_EN : DAY_LONG_CS;
}

export function shortDay(iso: string): string {
  return dayNames()[new Date(iso).getDay()];
}

export function longDay(iso: string): string {
  return dayLong()[new Date(iso).getDay()];
}

export function dayAndDate(iso: string): string {
  const d = new Date(iso);
  return `${dayLong()[d.getDay()]} ${d.getDate()}. ${d.getMonth() + 1}.`;
}

export function dayHeader(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const en = getLang() === "en";
  if (isSameDay(d, today)) return en ? "Today" : "Dnes";
  if (isSameDay(d, tomorrow)) return en ? "Tomorrow" : "Zítra";
  if (isSameDay(d, yesterday)) return en ? "Yesterday" : "Včera";
  return `${dayLong()[d.getDay()]}, ${d.getDate()}.${d.getMonth() + 1}.`;
}

export function dateKey(iso: string): string {
  return iso.slice(0, 10);
}

// Lokální datum jako "YYYY-MM-DD" (pro porovnávání s daily.time).
export function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function todayISO(): string {
  return isoDate(new Date());
}

export function hourLabel(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours()}:00`;
}

export function clockTime(date: Date): string {
  return date.toLocaleTimeString(getLang() === "en" ? "en-GB" : "cs-CZ", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function isSameHour(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate() &&
    a.getHours() === b.getHours()
  );
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// Vrátí světovou stranu ve stupních jako označení.
export function windDirLabel(deg: number): string {
  const dirs =
    getLang() === "en"
      ? ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
      : ["S", "SV", "V", "JV", "J", "JZ", "Z", "SZ"];
  return dirs[Math.round(deg / 45) % 8];
}

const DIR_GENITIVE_CS = [
  "severu",
  "severovýchodu",
  "východu",
  "jihovýchodu",
  "jihu",
  "jihozápadu",
  "západu",
  "severozápadu",
];
const DIR_FROM_EN = [
  "north",
  "northeast",
  "east",
  "southeast",
  "south",
  "southwest",
  "west",
  "northwest",
];

// Beaufortova stupnice – slovní popis síly větru (podle rychlosti v m/s).
export function windStrength(ms: number): string {
  const en = getLang() === "en";
  if (ms < 0.3) return en ? "Calm" : "Bezvětří";
  if (ms < 1.6) return en ? "Light air" : "Vánek";
  if (ms < 3.4) return en ? "Light breeze" : "Slabý vítr";
  if (ms < 5.5) return en ? "Gentle breeze" : "Mírný vítr";
  if (ms < 8) return en ? "Moderate breeze" : "Dosti čerstvý vítr";
  if (ms < 10.8) return en ? "Fresh breeze" : "Čerstvý vítr";
  if (ms < 13.9) return en ? "Strong breeze" : "Silný vítr";
  if (ms < 17.2) return en ? "Near gale" : "Prudký vítr";
  if (ms < 20.8) return en ? "Gale" : "Bouřlivý vítr";
  if (ms < 24.5) return en ? "Strong gale" : "Vichřice";
  if (ms < 28.5) return en ? "Storm" : "Silná vichřice";
  if (ms < 32.7) return en ? "Violent storm" : "Mohutná vichřice";
  return en ? "Hurricane" : "Orkán";
}

// Celý popis "Slabý vítr od severovýchodu" ve stylu yr.no.
export function windDescription(ms: number, deg: number): string {
  const en = getLang() === "en";
  if (ms < 0.3) return en ? "Calm" : "Bezvětří";
  const idx = Math.round(deg / 45) % 8;
  return en
    ? `${windStrength(ms)} from the ${DIR_FROM_EN[idx]}`
    : `${windStrength(ms)} od ${DIR_GENITIVE_CS[idx]}`;
}
