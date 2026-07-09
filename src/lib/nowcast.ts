import type { Minutely15 } from "../types";
import { getLang } from "./i18n";
import { clockTime } from "./format";

// Krátkodobá předpověď srážek („za 20 min začne pršet") z 15min dat Open-Meteo.
// Není to radar – jde o modelovou předpověď, ale s 15min krokem funguje dobře
// jako nowcast na nejbližší ~2 hodiny.

export interface Nowcast {
  kind: "starting" | "stopping";
  text: string;
}

const WET = 0.1; // mm za 15 min → bereme jako „prší"
const WINDOW_MIN = 120; // díváme se max 2 h dopředu

function rel(fromMs: number, toMs: number): string {
  const en = getLang() === "en";
  const min = Math.round((toMs - fromMs) / 60_000 / 5) * 5;
  if (min <= 0) return en ? "now" : "hned teď";
  if (min < 60) return en ? `in ${min} min` : `za ${min} min`;
  return en
    ? `around ${clockTime(new Date(toMs))}`
    : `kolem ${clockTime(new Date(toMs))}`;
}

export function computeNowcast(m: Minutely15 | undefined, now = Date.now()): Nowcast | null {
  if (!m || !m.time.length) return null;
  const times = m.time.map((t) => new Date(t).getTime());
  const p = m.precipitation;

  // Aktuální slot = poslední, jehož čas už začal.
  let i = -1;
  for (let k = 0; k < times.length; k++) {
    if (times[k] <= now) i = k;
    else break;
  }
  if (i < 0) i = 0;

  const horizon = now + WINDOW_MIN * 60_000;
  const wetNow = (p[i] ?? 0) >= WET;
  const en = getLang() === "en";

  if (!wetNow) {
    // Hledáme první budoucí mokrý slot v okně.
    for (let k = i + 1; k < times.length && times[k] <= horizon; k++) {
      if ((p[k] ?? 0) >= WET) {
        return {
          kind: "starting",
          text: en
            ? `Rain ${rel(now, times[k])}`
            : `Za chvíli déšť – ${rel(now, times[k])}`,
        };
      }
    }
    return null;
  }

  // Prší teď → hledáme, kdy ustane (aspoň 2 sloty v kuse sucho).
  for (let k = i + 1; k < times.length && times[k] <= horizon; k++) {
    const dry = (p[k] ?? 0) < WET;
    const dryNext = (p[k + 1] ?? 0) < WET;
    if (dry && dryNext) {
      return {
        kind: "stopping",
        text: en
          ? `Rain stops ${rel(now, times[k])}`
          : `Déšť ustane ${rel(now, times[k])}`,
      };
    }
  }
  return {
    kind: "stopping",
    text: en ? "Rain continues for 2+ h" : "Déšť potrvá i příští 2 h",
  };
}
