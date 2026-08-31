import { useState } from "react";
import type { DailyPoint, HourlyPoint } from "../types";
import { describeWeather } from "../lib/weatherCodes";
import { tr } from "../lib/i18n";
import { tempTier, type Tier } from "../lib/tiers";
import { useStoredState } from "../lib/useStoredState";
import {
  ACTIVITY_OFFSET,
  ACTIVITY_LABEL,
  activeIndex,
  scalePos,
  BOOTS_STOPS,
  BOOTS_STOPS_RUN,
  BOTTOM_STOPS,
  HEAD_STOPS,
  JACKET_STOPS,
  RAIN_STOPS,
  SUN_STOPS,
  TOP_STOPS,
  type Activity,
  type ClothKind,
  type ScaleStop,
} from "../lib/outfit";

// Stupnice a typy oblečení bydlí v ../lib/outfit (používá je i meteogram);
// re-export drží stávající importy z této komponenty funkční.
export {
  ACTIVITY_OFFSET,
  ACTIVITY_LABEL,
} from "../lib/outfit";
export type { Activity, ClothKind } from "../lib/outfit";
export { ClothIcon } from "./ClothIcon";
import { ClothIcon } from "./ClothIcon";
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

interface ScaleDef {
  key: string;
  title: string;
  stops: ScaleStop[];
  value: number;
  band?: [number, number];
  readout: string;
  // Kumulativní osa: potřeba je vše až po aktuální úroveň (např. sluneční
  // ochrana – brýle + kšiltovka + krém současně), ne „buď/anebo".
  cumulative?: boolean;
  // Volby, které se berou jako „nezajímavý default" (např. tenisky) – osa se pak
  // schová pod „Zobrazit více" stejně jako u „nic/netřeba".
  mutedKinds?: ClothKind[];
}

function WearScale({ title, stops, value, band, readout, cumulative }: ScaleDef) {
  const centers = stops.map((s) => s.center);
  const n = stops.length;
  const fVal = scalePos(value, centers);
  const activeIdx = activeIndex(value, stops);
  // U kumulativní osy svítí všechny volby od první „reálné" (mimo „none") až po
  // aktuální úroveň; jinak jen jedna aktivní zarážka.
  const isActive = (i: number) =>
    cumulative ? i >= 1 && i <= activeIdx : i === activeIdx;
  const pickText = cumulative
    ? stops
        .filter((_, i) => isActive(i))
        .map((s) => tr(s.label))
        .join(" + ")
    : tr(stops[activeIdx].label);
  let bandStyle: { left: string; right: string } | null = null;
  // Popisky min/max u proužku rozsahu (teplejší kraj vlevo, chladnější vpravo).
  let bandLabels: {
    leftPct: number;
    rightPct: number;
    leftTemp: number;
    rightTemp: number;
  } | null = null;
  if (band) {
    const a = scalePos(band[0], centers) * 100;
    const b = scalePos(band[1], centers) * 100;
    const leftPct = Math.min(a, b);
    const rightPct = Math.max(a, b);
    bandStyle = { left: `${leftPct}%`, right: `${100 - rightPct}%` };
    bandLabels = {
      leftPct,
      rightPct,
      leftTemp: Math.round(Math.max(band[0], band[1])),
      rightTemp: Math.round(Math.min(band[0], band[1])),
    };
  }
  return (
    <div className="wear-scale">
      <div className="wear-scale-head">
        <span className="wear-scale-title">{tr(title)}</span>
        <span className="wear-scale-pick">{pickText}</span>
      </div>
      <div className="wear-scale-track">
        {/* Úsek(y) aktuálního doporučení – „odkud kam" daný kus zasahuje. */}
        {(cumulative ? activeIdx >= 1 : true) && (
          <div
            className="wear-scale-zone"
            style={{
              left: `${((cumulative ? 1 : activeIdx) / n) * 100}%`,
              right: `${100 - ((activeIdx + 1) / n) * 100}%`,
            }}
          />
        )}
        {/* Předěly mezi jednotlivými kusy. */}
        {stops.slice(1).map((s, k) => (
          <span
            key={`div-${s.kind}-${k}`}
            className="wear-scale-div"
            style={{ left: `${((k + 1) / n) * 100}%` }}
          />
        ))}
        {/* Rozsah den/noc (pocitové min–max) jako tenký proužek pod tratí. */}
        {bandStyle && <div className="wear-scale-band" style={bandStyle} />}
        {bandLabels && (
          <>
            <span
              className="wear-scale-minmax"
              style={{ left: `${bandLabels.leftPct}%` }}
            >
              {bandLabels.leftTemp}°
            </span>
            {bandLabels.rightPct - bandLabels.leftPct > 6 && (
              <span
                className="wear-scale-minmax"
                style={{ left: `${bandLabels.rightPct}%` }}
              >
                {bandLabels.rightTemp}°
              </span>
            )}
          </>
        )}
        <div className="wear-scale-marker" style={{ left: `${fVal * 100}%` }}>
          <span className="wear-scale-temp">{readout}</span>
        </div>
      </div>
      <div
        className="wear-scale-stops"
        style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}
      >
        {stops.map((s, i) => (
          <div
            key={s.kind + s.label}
            className={`wear-scale-stop ${isActive(i) ? "active" : ""}`}
          >
            <span className="wear-scale-ic">
              <ClothIcon kind={s.kind} />
            </span>
            <span>{tr(s.label)}</span>
          </div>
        ))}
      </div>
    </div>
  );
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
  // Ve výchozím stavu ukazujeme jen „co na sebe"; detaily (shrnutí, škály,
  // nejlepší okno) jsou schované pod „Zobrazit více".
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Efektivní pocitová teplota (posunutá podle aktivity) pro osy oblečení –
  // stejný základ jako doporučení výše, ať k sobě značka a ikony sedí.
  const effHigh = feelsMax + ACTIVITY_OFFSET[activity];
  const effLow = feelsMin + ACTIVITY_OFFSET[activity];
  // Značku os řídíme stejnou hodnotou jako doporučení nahoře (buildOutfit staví
  // na pocitovém maximu), aby seznam položek a osy vždy ukazovaly totéž.
  const tempValue = effHigh;
  const tempBand: [number, number] = [effLow, effHigh];
  const tempReadout = `pocitově ${Math.round(effHigh)}°`;

  // Míra potřeby deště: suchý den drží značku vlevo, vydatný déšť/bouřka vpravo.
  const rainDry = wakeRainSum < 0.3;
  const rainScore = outfit.flags.extremeRain
    ? 95
    : rainDry
      ? 8
      : Math.max(wakeRainProb, wakeRainSum >= 3 ? 70 : 0);
  const uv = day.uvIndexMax;

  const scaleDefs: ScaleDef[] = [
    {
      key: "top",
      title: "Tělo",
      stops: TOP_STOPS,
      value: tempValue,
      band: tempBand,
      readout: tempReadout,
    },
    {
      key: "jacket",
      title: "Bunda",
      stops: JACKET_STOPS,
      value: tempValue,
      band: tempBand,
      readout: tempReadout,
    },
    {
      key: "bottom",
      title: "Nohy",
      stops: BOTTOM_STOPS,
      value: tempValue,
      band: tempBand,
      readout: tempReadout,
    },
    {
      key: "boots",
      title: "Boty",
      stops: activity === "run" ? BOOTS_STOPS_RUN : BOOTS_STOPS,
      value: tempValue,
      band: tempBand,
      readout: tempReadout,
      mutedKinds: ["sneakers"],
    },
    {
      key: "head",
      title: "Teplé doplňky",
      stops: HEAD_STOPS,
      value: tempValue,
      band: tempBand,
      readout: tempReadout,
      cumulative: true,
    },
    {
      key: "rain",
      title: "Déšť",
      stops: RAIN_STOPS,
      value: rainScore,
      readout: `${Math.round(wakeRainProb)} %`,
    },
    {
      key: "sun",
      title: "Slunce",
      stops: SUN_STOPS,
      value: uv,
      readout: `UV ${Math.round(uv)}`,
      cumulative: true,
    },
  ];
  // Osy, kde doporučení vyjde na „nic/netřeba" (nebo nezajímavý default jako
  // tenisky), schováme pod „Zobrazit více".
  const isMutedScale = (d: ScaleDef) => {
    const kind = d.stops[activeIndex(d.value, d.stops)].kind;
    return kind === "none" || (d.mutedKinds?.includes(kind) ?? false);
  };
  const shownScales = scaleDefs.filter((d) => !isMutedScale(d));
  const hiddenScales = scaleDefs.filter((d) => isMutedScale(d));

  // Seznam kusů nahoře je odvozený ze stejných os (aby seznam a osy vždy seděly).
  // U kumulativních os bereme vše až po aktivní úroveň, jinak jen aktivní volbu.
  const gridItems = scaleDefs.flatMap((d) => {
    const idx = activeIndex(d.value, d.stops);
    const chosen = d.cumulative ? d.stops.slice(1, idx + 1) : [d.stops[idx]];
    return chosen
      .filter((s) => s.kind !== "none")
      .map((s) => ({ kind: s.kind, label: s.label }));
  });

  return (
    <section className={`card wear-card wear-${outfit.accent} yr-has-more`}>
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
        {gridItems.map((it, i) => (
          <div className="wear-item" key={`${it.kind}-${it.label}-${i}`}>
            <ClothIcon kind={it.kind} />
            <span className="wear-item-label">{tr(it.label)}</span>
          </div>
        ))}
      </div>

      {detailsOpen && (
        <>
          <p className="wear-summary">{tr(outfit.summary)}</p>
          <div className="wear-scales">
            {[...shownScales, ...hiddenScales].map((d) => (
              <WearScale
                key={d.key}
                title={d.title}
                stops={d.stops}
                value={d.value}
                band={d.band}
                readout={d.readout}
              />
            ))}
          </div>
          <BestWindow hourly={hourly} date={date} />
        </>
      )}

      <button
        type="button"
        className="yr-more"
        aria-expanded={detailsOpen}
        aria-label={tr(detailsOpen ? "Zobrazit méně" : "Zobrazit více")}
        title={tr(detailsOpen ? "Zobrazit méně" : "Zobrazit více")}
        onClick={() => setDetailsOpen((v) => !v)}
      >
        <WearMoreChevron flipped={detailsOpen} />
      </button>

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

function WearMoreChevron({ flipped }: { flipped?: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      className={flipped ? "yr-more-ico flip" : "yr-more-ico"}
      aria-hidden="true"
    >
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
