const DAY_NAMES = ["Ne", "Po", "Út", "St", "Čt", "Pá", "So"];
const DAY_NAMES_LONG = [
  "Neděle",
  "Pondělí",
  "Úterý",
  "Středa",
  "Čtvrtek",
  "Pátek",
  "Sobota",
];

export function shortDay(iso: string): string {
  return DAY_NAMES[new Date(iso).getDay()];
}

export function longDay(iso: string): string {
  return DAY_NAMES_LONG[new Date(iso).getDay()];
}

export function dayAndDate(iso: string): string {
  const d = new Date(iso);
  return `${DAY_NAMES_LONG[d.getDay()]} ${d.getDate()}. ${d.getMonth() + 1}.`;
}

export function dayHeader(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (isSameDay(d, today)) return "Dnes";
  if (isSameDay(d, tomorrow)) return "Zítra";
  if (isSameDay(d, yesterday)) return "Včera";
  return `${DAY_NAMES_LONG[d.getDay()]}, ${d.getDate()}.${d.getMonth() + 1}.`;
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
  return date.toLocaleTimeString("cs-CZ", {
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

// Vrátí světovou stranu ve stupních jako české označení.
export function windDirLabel(deg: number): string {
  const dirs = ["S", "SV", "V", "JV", "J", "JZ", "Z", "SZ"];
  return dirs[Math.round(deg / 45) % 8];
}

const DIR_GENITIVE = [
  "severu",
  "severovýchodu",
  "východu",
  "jihovýchodu",
  "jihu",
  "jihozápadu",
  "západu",
  "severozápadu",
];

// Beaufortova stupnice – český slovní popis síly větru (podle rychlosti v m/s).
export function windStrength(ms: number): string {
  if (ms < 0.3) return "Bezvětří";
  if (ms < 1.6) return "Vánek";
  if (ms < 3.4) return "Slabý vítr";
  if (ms < 5.5) return "Mírný vítr";
  if (ms < 8) return "Dosti čerstvý vítr";
  if (ms < 10.8) return "Čerstvý vítr";
  if (ms < 13.9) return "Silný vítr";
  if (ms < 17.2) return "Prudký vítr";
  if (ms < 20.8) return "Bouřlivý vítr";
  if (ms < 24.5) return "Vichřice";
  if (ms < 28.5) return "Silná vichřice";
  if (ms < 32.7) return "Mohutná vichřice";
  return "Orkán";
}

// Celý popis "Slabý vítr od severovýchodu" ve stylu yr.no.
export function windDescription(ms: number, deg: number): string {
  if (ms < 0.3) return "Bezvětří";
  const dir = DIR_GENITIVE[Math.round(deg / 45) % 8];
  return `${windStrength(ms)} od ${dir}`;
}
