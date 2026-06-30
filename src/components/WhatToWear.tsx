import { useState } from "react";
import type { DailyPoint, HourlyPoint } from "../types";
import { describeWeather } from "../lib/weatherCodes";
import { tr } from "../lib/i18n";
import { tempTier, type Tier } from "../lib/tiers";
import { useStoredState } from "../lib/useStoredState";
import BestWindow from "./BestWindow";
import OutfitTester from "./OutfitTester";

interface Props {
  day: DailyPoint;
  // Pocitová teplota dne (pro výběr oblečení je relevantnější než reálná).
  feelsMax: number;
  feelsMin: number;
  // Srážky během bdění (6–24 h) – noční déšť deštník nevyžaduje.
  wakeRainSum: number;
  wakeRainProb: number;
  // Hodinová data pro výpočet nejlepšího okna na ven.
  hourly: HourlyPoint[];
  date: string;
}

export type ClothKind =
  | "tshirt"
  | "longsleeve"
  | "shorts"
  | "pants"
  | "sweater"
  | "warmsweater"
  | "jacket"
  | "coat"
  | "downvest"
  | "downjacket"
  | "beanie"
  | "gloves"
  | "scarf"
  | "umbrella"
  | "raincoat"
  | "cap"
  | "sunglasses"
  | "sunscreen"
  | "boots";

// Co člověk zrovna dělá. Pohyb tělo zahřívá (běh nejvíc), klid ochlazuje –
// promítá se to do pocitové teploty, se kterou se oblečení skládá.
export type Activity = "sit" | "walk" | "run";

export const ACTIVITY_OFFSET: Record<Activity, number> = {
  sit: -3,
  walk: 0,
  run: 6,
};

export const ACTIVITY_LABEL: Record<Activity, string> = {
  sit: "Sedím",
  walk: "Chodím",
  run: "Běhám",
};

type Accent = Tier;

export interface OutfitItem {
  kind: ClothKind;
  label: string;
  note?: string;
}

export interface OutfitFlags {
  rainLikely: boolean;
  extremeRain: boolean;
  snowLikely: boolean;
  windy: boolean;
  cold: boolean;
  sunny: boolean;
}

export interface Outfit {
  accent: Accent;
  summary: string;
  items: OutfitItem[];
  flags: OutfitFlags;
}

function rainChance(prob: number): string {
  if (prob >= 80) return "určitě";
  if (prob >= 60) return "spíš ano";
  if (prob >= 45) return "možná";
  return "spíš ne";
}

export function buildOutfit(
  day: DailyPoint,
  feelsMax: number,
  feelsMin: number,
  wakeRainSum: number,
  wakeRainProb: number,
  activity: Activity = "walk",
): Outfit {
  // Oblečení volíme podle pocitové teploty (vítr/vlhkost ji posouvají) a navíc
  // ji posuneme podle aktivity – při pohybu je člověku tepleji, v klidu chladněji.
  const offset = ACTIVITY_OFFSET[activity];
  const high = feelsMax + offset;
  const low = feelsMin + offset;
  const fullSum = day.precipitationSum;
  const windMax = day.windSpeedMax;
  const uv = day.uvIndexMax;
  const icon = describeWeather(day.weatherCode).icon;

  // Zanedbatelný déšť přes den → deštník neřešíme. Buď spadne málo (pár kapek),
  // nebo je pravděpodobnost tak nejistá, že nemá smysl deštník tahat.
  const negligibleRain = wakeRainSum < 0.5 || wakeRainProb < 35;
  // „Mordor“ – vydatný déšť/bouřka (i kdyby spadl převážně v noci).
  const extremeRain = fullSum >= 12 || (icon === "thunder" && fullSum >= 5);
  // Deštník dává smysl jen při znatelném úhrnu přes den (ne kvůli jedné kapce
  // s 50% pravděpodobností), nebo při vysoké pravděpodobnosti s reálným deštěm.
  const rainLikely =
    extremeRain ||
    (!negligibleRain &&
      (wakeRainSum >= 1.5 ||
        (wakeRainProb >= 55 && wakeRainSum >= 0.5) ||
        (["rain", "drizzle", "thunder"].includes(icon) && wakeRainSum >= 0.8)));

  const snowLikely =
    ["snow", "sleet"].includes(icon) ||
    (high <= 1 && (fullSum > 0 || wakeRainProb >= 40));
  const windy = windMax >= 9;
  const cold = high < 9;
  const sunny = uv >= 6 && !rainLikely;

  const items: OutfitItem[] = [];
  const add = (kind: ClothKind, label: string, note?: string) => {
    if (!items.some((i) => i.kind === kind)) items.push({ kind, label, note });
  };

  const accent = tempTier(high);
  let summary: string;

  switch (accent) {
    case "hot":
      summary = "Bude horko – obleč se lehce";
      add("tshirt", "Triko");
      add("shorts", "Kraťasy");
      break;
    case "warm":
      summary = "Příjemně teplo";
      add("tshirt", "Triko");
      add("shorts", "Kraťasy");
      break;
    case "mild":
      summary = "Akorát – nic extrémního";
      // Chladnější „akorát“ dny sedí spíš dlouhý rukáv než tílko/triko.
      if (high < 19) add("longsleeve", "Triko (dlouhý rukáv)");
      else add("tshirt", "Triko");
      add("pants", "Dlouhé kalhoty");
      break;
    case "cool":
      summary = "Spíš chladno";
      // Teplejší chladné dny: dlouhý rukáv jako spodní vrstva pod mikinu.
      if (high >= 12) add("longsleeve", "Triko (dlouhý rukáv)", "spodní vrstva");
      add("sweater", "Mikina");
      add("pants", "Dlouhé kalhoty");
      break;
    case "cold":
      summary = "Zima – pořádně se obleč";
      add("warmsweater", "Teplý svetr");
      add("pants", "Dlouhé kalhoty");
      add("beanie", "Čepice");
      break;
    case "freezing":
      summary = "Mrzne – navlékni vrstvy";
      add("warmsweater", "Teplý svetr");
      add("beanie", "Čepice");
      add("scarf", "Šála");
      add("gloves", "Rukavice");
      break;
  }

  // Peřová izolace jádra podle efektivní pocitovky a aktivity: při pohybu stačí
  // vesta (ruce se hýbou a topí se samy), v klidu je lepší bunda s rukávy.
  if (activity === "run") {
    if (high < 12) add("downvest", "Peřová vesta", "drží jádro v teple");
  } else if (high < 11) {
    const needsJacket = activity === "sit" || high < 4;
    if (needsJacket) add("downjacket", "Peřová bunda", "zateplí i ruce");
    else add("downvest", "Peřová vesta", "drží jádro v teple");
  }

  // Mikina k triku: buď chladnější ráno/večer (nízké minimum), nebo jen mírné
  // denní maximum kolem 20 °C, kdy se lehká vrstva navrch často hodí.
  if (accent === "warm" || accent === "mild") {
    const coolEdges = low < 15;
    const mildDay = accent === "mild" && high <= 20;
    if (coolEdges || mildDay) {
      add("sweater", "Mikina", low < 12 ? "na ráno a večer" : "pro jistotu");
    }
  }

  if (rainLikely) {
    const chance =
      extremeRain || wakeRainSum >= 3 ? "určitě" : rainChance(wakeRainProb);
    summary = high >= 16 ? "Vezmi si deštník, může pršet" : summary;
    add("umbrella", "Deštník", chance);
    if (windy || cold) add("raincoat", "Nepromokavá bunda", "s kapucí");
  } else if (cold && !negligibleRain && wakeRainSum >= 0.1) {
    // Zima a slabý déšť/mrholení přes den – nepromokavá bunda zahřeje i ochrání.
    add("raincoat", "Nepromokavá bunda");
  }
  if (snowLikely) {
    add("boots", "Pevné boty");
    add("beanie", "Čepice");
  }
  if (windy && accent !== "freezing") {
    summary = !rainLikely && high >= 16 ? "Bude foukat – vezmi větrovku" : summary;
    add("jacket", "Větrovka", "neprofoukne");
  }
  if (sunny) {
    summary = high >= 22 ? "Praží slunce – chraň se před UV" : summary;
    add("cap", "Kšiltovka");
    add("sunglasses", "Sluneční brýle");
    add("sunscreen", "Opalovací krém");
  }

  return {
    accent,
    summary,
    items,
    flags: { rainLikely, extremeRain, snowLikely, windy, cold, sunny },
  };
}

export default function WhatToWear({
  day,
  feelsMax,
  feelsMin,
  wakeRainSum,
  wakeRainProb,
  hourly,
  date,
}: Props) {
  const [activity, setActivity] = useStoredState<Activity>(
    "wear.activity",
    "walk",
  );
  const outfit = buildOutfit(
    day,
    feelsMax,
    feelsMin,
    wakeRainSum,
    wakeRainProb,
    activity,
  );
  const [howOpen, setHowOpen] = useState(false);

  return (
    <section className={`card wear-card wear-${outfit.accent}`}>
      <h2 className="card-title">
        {tr("Co si vzít na sebe")}
        <button
          type="button"
          className="wear-how-btn"
          onClick={() => setHowOpen(true)}
          title={tr("Jak to počítám")}
        >
          {tr("Jak to počítám?")}
        </button>
      </h2>
      <ActivityPicker value={activity} onChange={setActivity} />
      <div className="wear-grid">
        {outfit.items.map((it) => (
          <div className="wear-item" key={it.kind + it.label}>
            <ClothIcon kind={it.kind} />
            <span className="wear-item-label">{tr(it.label)}</span>
            {it.note && <span className="wear-item-note">{tr(it.note)}</span>}
          </div>
        ))}
      </div>
      <p className="wear-summary">{tr(outfit.summary)}</p>
      <BestWindow hourly={hourly} date={date} />

      {howOpen && (
        <OutfitTester
          onClose={() => setHowOpen(false)}
          initial={{
            feelsMax: Math.round(feelsMax),
            feelsMin: Math.round(feelsMin),
            precip: Math.round(wakeRainSum * 10) / 10,
            rainProb: Math.round(wakeRainProb),
            wind: Math.round(day.windSpeedMax),
            uv: Math.round(day.uvIndexMax),
            code: day.weatherCode,
            activity,
          }}
        />
      )}
    </section>
  );
}

export function ActivityPicker({
  value,
  onChange,
}: {
  value: Activity;
  onChange: (a: Activity) => void;
}) {
  return (
    <div className="wear-activity" role="group" aria-label={tr("Aktivita")}>
      {(["sit", "walk", "run"] as Activity[]).map((a) => (
        <button
          key={a}
          type="button"
          className={`wear-act ${value === a ? "on" : ""}`}
          aria-pressed={value === a}
          onClick={() => onChange(a)}
        >
          <ActivityIcon kind={a} />
          <span>{tr(ACTIVITY_LABEL[a])}</span>
        </button>
      ))}
    </div>
  );
}

export function ActivityIcon({ kind }: { kind: Activity }) {
  const common = {
    width: 24,
    height: 24,
    viewBox: "0 0 48 48",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.4,
    strokeLinejoin: "round" as const,
    strokeLinecap: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "sit":
      return (
        <svg {...common}>
          <circle cx="22" cy="11" r="4" />
          <path d="M18 17v10h10" />
          <path d="M28 27v14M18 27l-4 8M28 34h8" />
        </svg>
      );
    case "walk":
      return (
        <svg {...common}>
          <circle cx="26" cy="10" r="4" />
          <path d="M26 15l-4 9 6 5v13" />
          <path d="M22 24l-6 3M28 29l6 4M22 42l6-8" />
        </svg>
      );
    case "run":
      return (
        <svg {...common}>
          <circle cx="28" cy="10" r="4" />
          <path d="M28 15l-6 7 4 6-3 12" />
          <path d="M22 22l-8 2M26 28l7 5M23 40l-6 3" />
        </svg>
      );
  }
}

export function ClothIcon({ kind }: { kind: ClothKind }) {
  const common = {
    width: 40,
    height: 40,
    viewBox: "0 0 48 48",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinejoin: "round" as const,
    strokeLinecap: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "tshirt":
      return (
        <svg {...common}>
          <path d="M18 8l-10 6 4 7 5-3v18h22V18l5 3 4-7-10-6c-2 4-18 4-20 0z" />
        </svg>
      );
    case "longsleeve":
      return (
        <svg {...common}>
          <path d="M18 8L8 13l-3 15 5 1 3-10v22h22V19l3 10 5-1-3-15-10-5c-2 4-18 4-20 0z" />
        </svg>
      );
    case "shorts":
      return (
        <svg {...common}>
          <path d="M11 11h26v6l-3 13h-8l-2-10-2 10h-8l-3-13z" />
          <path d="M24 17v4" />
        </svg>
      );
    case "pants":
      return (
        <svg {...common}>
          <path d="M16 8h16v7l-2 26h-6l-1-24-1 24h-6l-2-26z" />
          <path d="M24 15v5" />
        </svg>
      );
    case "sweater":
      return (
        <svg {...common}>
          <path d="M16 13l-8 5 4 8 4-2v16h16V24l4 2 4-8-8-5c-1 3-15 3-16 0z" />
          <path d="M19 14c-2-7 12-7 10 0" />
          <path d="M22 16v5M26 16v5" />
          <path d="M18 31h12" />
        </svg>
      );
    case "warmsweater":
      return (
        <svg {...common}>
          <path d="M17 10l-9 5 3 9 5-2v18h16V22l5 2 3-9-9-5z" />
          <path d="M17 10c1 3 13 3 14 0" />
          <path d="M19 25l5 3 5-3M19 31l5 3 5-3" />
        </svg>
      );
    case "jacket":
      return (
        <svg {...common}>
          <path d="M18 8l-10 6 4 7 5-3v18h22V18l5 3 4-7-10-6c-2 4-18 4-20 0z" />
          <path d="M24 10v32" />
        </svg>
      );
    case "coat":
      return (
        <svg {...common}>
          <path d="M19 8l-9 6 3 6 4-2v24h22V18l4 2 3-6-9-6c-1 4-17 4-18 0z" />
          <path d="M24 12v30M28 20h8M28 28h8" />
        </svg>
      );
    case "downvest":
      return (
        <svg {...common}>
          <path d="M18 9c1 3 11 3 12 0l4 4v29H14V13z" />
          <path d="M24 11v31" />
          <path d="M15 19h6M27 19h6M15 26h6M27 26h6M15 33h6M27 33h6" />
        </svg>
      );
    case "downjacket":
      return (
        <svg {...common}>
          <path d="M17 9c2 3 12 3 14 0l9 5-3 8-4-2v22H15V20l-4 2-3-8z" />
          <path d="M24 10v34" />
          <path d="M16 18h6M26 18h6M16 25h6M26 25h6M16 32h6M26 32h6" />
        </svg>
      );
    case "beanie":
      return (
        <svg {...common}>
          <path d="M9 30c0-15 30-15 30 0z" />
          <path d="M7 30h34v5H7z" />
        </svg>
      );
    case "gloves":
      return (
        <svg {...common}>
          <path d="M16 22v-4c0-2 3-2 3 0v3c0-3 3-3 3 0v1c0-2 3-2 3 0v2c0-2 3-2 3 0v8c0 6-4 9-9 9s-9-3-9-9c0-3 2-4 3-4z" />
          <path d="M16 36h12" />
        </svg>
      );
    case "scarf":
      return (
        <svg {...common}>
          <path d="M14 12c6 6 14 6 20 0l3 5c-7 6-19 6-26 0z" />
          <path d="M21 22v16h6V22" />
        </svg>
      );
    case "umbrella":
      return (
        <svg {...common}>
          <path d="M6 24c1-12 35-12 36 0z" />
          <path d="M24 24v14c0 3-4 3-5 1" />
        </svg>
      );
    case "raincoat":
      return (
        <svg {...common}>
          <path d="M18 14c0-5 12-5 12 0" />
          <path d="M18 14l-9 6 4 7 5-3v18h12V24l5 3 4-7-9-6c-2 4-10 4-12 0z" />
        </svg>
      );
    case "cap":
      return (
        <svg {...common}>
          <path d="M12 27c0-11 20-13 25-3" />
          <path d="M12 27h21" />
          <path d="M33 27c5-1 11 0 11 4H33z" />
        </svg>
      );
    case "sunglasses":
      return (
        <svg {...common}>
          <path d="M7 19h13v5c0 5-13 5-13 0zM28 19h13v5c0 5-13 5-13 0zM20 21h8" />
          <path d="M7 19l-2-4M41 19l2-4" />
        </svg>
      );
    case "sunscreen":
      return (
        <svg {...common}>
          <path d="M20 10h8v5h-8zM17 15h14v25H17z" />
          <path d="M21 22h6M21 28h6" />
        </svg>
      );
    case "boots":
      return (
        <svg {...common}>
          <path d="M18 8h7v20h6c4 0 6 3 6 7v3H18z" />
          <path d="M18 32h19" />
        </svg>
      );
  }
}
