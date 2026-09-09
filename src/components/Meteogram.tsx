import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import type { DailyPoint, HourlyPoint } from "../types";
import { describeWeather } from "../lib/weatherCodes";
import { tr, getLang } from "../lib/i18n";
import { cursorHourLabel, locDate, windDirLabel, zonedNow } from "../lib/format";
import { useStoredState } from "../lib/useStoredState";
import { ClothIcon } from "./ClothIcon";
import {
  ACTIVITY_LABEL,
  ACTIVITY_OFFSET,
  outfitAt,
  outfitExtras,
  outfitLabel,
  outfitLevelBounds,
  outfitLevelColor,
  type Activity,
  type OutfitPick,
} from "../lib/outfit";
import { tempColor } from "../lib/tempColor";
import { isLightPalette } from "../lib/themeState";
import { TIER_COLOR, TIER_LABEL, tempTier } from "../lib/tiers";
import {
  fetchModelSeries,
  fetchClimateNormals,
  normalDoy,
  type ModelSeries,
  type ClimateNormals,
} from "../lib/openMeteo";
import { WEATHER_MODELS, modelColor, modelLabel, modelShort } from "../lib/models";
import WeatherIcon from "./WeatherIcon";

interface Props {
  hourly: HourlyPoint[];
  activeDate?: string;
  lat?: number;
  lon?: number;
  model?: string;
  theme?: "light" | "dark";
  utcOffset?: number;
  /** Vnořený graf v režimu více meteogramů najednou. */
  embed?: boolean;
  parts?: "all" | "chrome" | "plot" | "head" | "axis" | "legend" | "frame" | "strip" | "daylines";
  multiMode?: boolean;
  openTabs?: Tab[];
  onToggleTab?: (t: Tab) => void;
  /** Který graf je v multi režimu zvýrazněný (klik na stat kartu). */
  focusTab?: Tab | null;
  onFocusTab?: (t: Tab) => void;
  hideLegend?: boolean;
  hideIcons?: boolean;
  fixedTab?: Tab;
  plotWidth?: number;
  cursor?: number;
  onCursorChange?: (index: number) => void;
  /** Začátek zobrazeného okna (YYYY-MM-DD). Drží se, dokud výběr dne zůstane uvnitř. */
  windowStart?: string;
  /** Hodnoty modelů pro legendu (model → hodnota). */
  modelValues?: Map<string, number>;
  /** Callback pro aktualizaci hodnot modelů z grafu. */
  onModelValues?: (values: Map<string, number>) => void;
}

export type { Tab };

// Mapování tabu na hodinovou proměnnou Open-Meteo (pro multimód).
const TAB_OM_VAR: Record<Tab, string> = {
  temp: "temperature_2m",
  feels: "apparent_temperature",
  precip: "precipitation",
  wind: "wind_speed_10m",
  cloud: "cloud_cover",
  humidity: "relative_humidity_2m",
  dewpoint: "dew_point_2m",
  pressure: "surface_pressure",
  uv: "uv_index",
  outfit: "apparent_temperature",
};

type Tab =
  | "temp"
  | "feels"
  | "precip"
  | "wind"
  | "cloud"
  | "humidity"
  | "dewpoint"
  | "pressure"
  | "uv"
  | "outfit";

const ALL_TABS: Tab[] = [
  "temp",
  "feels",
  "outfit",
  "precip",
  "wind",
  "uv",
  "cloud",
  "humidity",
  "dewpoint",
  "pressure",
];

function normalizeTabOrder(raw: Tab[]): Tab[] {
  const valid = raw.filter((t) => ALL_TABS.includes(t));
  const missing = ALL_TABS.filter((t) => !valid.includes(t));
  return [...valid, ...missing];
}

function isoAddDays(iso: string, delta: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + delta);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

// Posun okna jen když vybraný den vypadne ven – jinak zůstává začátek stejný.
// Začátek neseřezáváme na první hodinu dat: jinak výběr včerejška (nebo
// hlubší historie) hned spadne zpět na „dnes“ a do historie nejde vstoupit.
function meteogramWindowStart(
  prev: string | null,
  selected: string,
  nDays: number,
  hourly: HourlyPoint[],
): string {
  const days = Math.min(7, Math.max(1, nDays));
  const first = hourly[0]?.time.slice(0, 10);
  const last = hourly[hourly.length - 1]?.time.slice(0, 10);

  let start = prev;
  if (start && first && last && (start < first || start > last)) {
    start = null;
  }
  if (!start) start = selected;

  const end = isoAddDays(start, days - 1);
  if (selected < start) start = selected;
  else if (selected > end) start = isoAddDays(selected, -(days - 1));

  return start;
}

function useMeteogramWindowStart(
  hourly: HourlyPoint[],
  selected: string,
  nDays: number,
): string {
  const prevRef = useRef<string | null>(null);
  const start = meteogramWindowStart(prevRef.current, selected, nDays, hourly);
  prevRef.current = start;
  return start;
}

function clampExtremaY(
  curveY: number,
  kind: "max" | "min",
  top: number,
  height: number,
  curveBottom: number,
) {
  if (kind === "max") return Math.max(top + 10, curveY - 8);
  return Math.min(curveBottom + 12, height - 4, curveY + 14);
}

function moveTabBefore(
  arr: Tab[],
  id: Tab,
  targetId: Tab,
  after: boolean,
): Tab[] {
  const a = arr.filter((x) => x !== id);
  let idx = a.indexOf(targetId);
  if (idx < 0) return arr;
  if (after) idx += 1;
  a.splice(idx, 0, id);
  return a;
}

// Globální modely pro „pás nejistoty" (alternate predictions) u teploty. Když
// se rozcházejí, předpověď je méně jistá – pás to ukáže bez ruční konfigurace.
// Pás nejistoty počítáme ze všech dostupných modelů (stejná sada jako „vše"
// v porovnání). Modely, které pro danou lokalitu nevrací data (např. ČHMÚ
// ALADIN mimo ČR nebo hodiny mimo dosah), se při výpočtu obálky přeskočí.
const SPREAD_MODELS = WEATHER_MODELS.filter((m) => m.id !== "best_match").map(
  (m) => m.id,
);

const TAB_LABEL: Record<Tab, string> = {
  temp: "Teplota",
  feels: "Pocitová teplota",
  precip: "Srážky",
  wind: "Vítr",
  cloud: "Oblačnost",
  humidity: "Vlhkost",
  dewpoint: "Rosný bod",
  pressure: "Tlak",
  uv: "UV index",
  outfit: "Oblečení",
};

// Krátké vysvětlivky – k čemu je dobré danou veličinu sledovat.
const TAB_INFO: Record<Tab, string> = {
  temp: "Teplota vzduchu ve stínu (2 m nad zemí). Základ pro plánování dne.",
  feels: "Jak teplo/zima reálně je – zohledňuje vítr, vlhkost a slunce. Pro oblečení spolehlivější než samotná teplota.",
  precip: "Množství srážek (mm) a pravděpodobnost. Napoví, jestli a jak moc bude pršet.",
  wind: "Rychlost větru a nárazy. Silný vítr zesiluje pocit chladu a komplikuje cyklistiku či deštník.",
  cloud: "Pokrytí oblohy mraky (%). Nízké hodnoty = jasno a víc slunce (a v noci chladněji).",
  humidity: "Relativní vlhkost vzduchu (%). Vysoká v teple je dusno, v zimě zvyšuje pocit chladu; kolem 100 % hrozí mlha nebo rosa.",
  dewpoint: "Teplota, při níž vzduch nasytí vlhkost. Čím blíž je teplotě, tím dusněji je a tím spíš vznikne mlha/rosa. Nad ~16 °C bývá dusno.",
  pressure: "Tlak vzduchu. Klesající tlak často předchází zhoršení počasí (déšť, vítr), rostoucí naopak vyjasnění a klid.",
  uv: "Intenzita UV záření ze slunce. Vrcholí kolem poledne. Od hodnoty 3 se doporučuje ochrana (krém, brýle), od 6 je vysoká a od 8 velmi vysoká.",
  outfit: "Co si vzít na sebe hodinu po hodině. Osa je pocitová teplota upravená podle aktivity (v pohybu je člověku tepleji), čárkované linky ukazují, kdy se doporučení mění.",
};

const DEFAULT_PINNED: Record<Tab, boolean> = {
  temp: true,
  feels: false,
  precip: true,
  wind: true,
  cloud: true,
  humidity: false,
  dewpoint: false,
  pressure: false,
  uv: false,
  outfit: false,
};

// Pevné okno od 00:00 vybraného dne. Graf se vejde na šířku, nescrolluje.
const H = 264;
// Nahoře necháme dva řádky: název dne + plovoucí popisek vybrané hodiny.
const TOP_PAD = 48;
// Samostatná osa dnů nad zásobníkem grafů. Dva řádky jako v horním okraji
// jediného grafu (dny / „Teď"), ale bez prázdného místa, které v plném grafu
// patří kresbě.
const AXIS_H = 36;
// „Teď" v jedné rovině s .mg-cursor-tip (top −6px / −5px v CSS), nad popisky dnů.
const CURSOR_TIP_TOP_SINGLE = -6;
const CURSOR_TIP_TOP_AXIS = -5;
const AXIS_NOW_Y = CURSOR_TIP_TOP_AXIS;
const AXIS_DAY_Y = 30;
const SINGLE_DAY_LABEL_Y = 22;
const DAY_PILL_H = 14;
const DAY_PILL_Y_INSET = 10;
const SINGLE_NOW_Y = CURSOR_TIP_TOP_SINGLE;

function dayPillMidY(labelY: number): number {
  return labelY - DAY_PILL_Y_INSET + DAY_PILL_H / 2;
}
// Horní pruh pro „visící" mini srážky (u ostatních veličin než srážky).
const MINI_H = 46;
// Spodní okraj křivky – bez rezervy na hodinové popisky.
const CURVE_BOTTOM = H - 6;

const DAY_SHORT_CS = ["Ne", "Po", "Út", "St", "Čt", "Pá", "So"];
const DAY_SHORT_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
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
function dayShort() {
  return getLang() === "en" ? DAY_SHORT_EN : DAY_SHORT_CS;
}
function dayLong() {
  return getLang() === "en" ? DAY_LONG_EN : DAY_LONG_CS;
}

function estimateDayLabelWidth(text: string): number {
  return text.length * 6 + 12;
}

// Popisek úrovně detailu při zoomu, se správným skloňováním (1 den / 2 dny / 5 dní).
function daysLabel(n: number): string {
  if (getLang() === "en") return `${n} ${n === 1 ? "day" : "days"}`;
  if (n === 1) return "1 den";
  if (n < 5) return `${n} dny`;
  return `${n} dní`;
}

// Barva odchylky denního průměru od normálu podle její výraznosti (°C).
// Kladná = teple (světle oranžová → tmavě červená), záporná = chladně
// (světle modrá → tmavě modrá). Sytost i krytí rostou s velikostí odchylky.
function anomalyColor(diff: number): { fill: string; line: string } {
  const m = Math.min(1, Math.abs(diff) / 10); // nasycení dosáhne stropu u ~10 °C
  const warm = diff >= 0;
  const mild = warm ? [255, 176, 120] : [140, 205, 235];
  const strong = warm ? [200, 40, 30] : [30, 80, 210];
  const r = Math.round(mild[0] + (strong[0] - mild[0]) * m);
  const g = Math.round(mild[1] + (strong[1] - mild[1]) * m);
  const b = Math.round(mild[2] + (strong[2] - mild[2]) * m);
  const alpha = 0.18 + 0.34 * m;
  return { fill: `rgba(${r},${g},${b},${alpha})`, line: `rgb(${r},${g},${b})` };
}

// Normál interpolovaný mezi dnem a následujícím dnem podle hodiny v ISO čase –
// dá plynulou křivku (normál se mění den ode dne, ne skokem o půlnoci).
function interpNormal(arr: (number | null)[], iso: string): number | null {
  const doy = normalDoy(iso);
  const a = arr[doy];
  const b = arr[(doy + 1) % arr.length];
  const hour = Number(iso.slice(11, 13)) || 0;
  const frac = hour / 24;
  if (a == null) return b ?? null;
  if (b == null) return a;
  return a + (b - a) * frac;
}

function pickRepHour(pts: HourlyPoint[]): HourlyPoint {
  let rep = pts[0];
  let bestP = -1;
  for (const p of pts) {
    if (p.precipitation > bestP) {
      bestP = p.precipitation;
      rep = p;
    }
  }
  if (bestP <= 0) {
    rep = pts.reduce((a, b) => (b.weatherCode > a.weatherCode ? b : a), pts[0]);
  }
  return rep;
}

type WeatherIconSlot = {
  i: number;
  slot: number;
  code?: number;
  isDay?: boolean;
};

// Ikonky pásu bereme na celých hodinách dělitelných krokem – rozestup je pak
// vždy přesně `step * pph`. Při jedné ikoně na den nebereme půlnoc (měsíc),
// ale reprezentanta ze světlé části dne.
function buildWeatherIconSlots(
  points: HourlyPoint[],
  step: number,
  opts?: { narrow?: boolean; pph?: number; minGapPx?: number },
): WeatherIconSlot[] {
  if (!points.length || step < 1) return [];

  if (step >= 24) {
    const byDay = new Map<string, number[]>();
    const order: string[] = [];
    points.forEach((p, i) => {
      const key = p.time.slice(0, 10);
      let arr = byDay.get(key);
      if (!arr) {
        arr = [];
        byDay.set(key, arr);
        order.push(key);
      }
      arr.push(i);
    });
    const out: WeatherIconSlot[] = [];
    order.forEach((key, di) => {
      const idxs = byDay.get(key)!;
      const dayIdxs = idxs.filter((i) => points[i].isDay);
      const useIdxs = dayIdxs.length ? dayIdxs : idxs;
      const pts = useIdxs.map((i) => points[i]);
      const dayLight = pts.filter((p) => p.isDay);
      const rep = pickRepHour(dayLight.length ? dayLight : pts);
      const noon = useIdxs.find(
        (i) => locDate(points[i].time).getHours() === 12,
      );
      out.push({
        i: noon ?? useIdxs[Math.floor(useIdxs.length / 2)],
        slot: di,
        code: rep.weatherCode,
        isDay: dayLight.length > 0,
      });
      // Na úzkém displeji přidej noční ikonu, když se vejde vedle denní.
      if (opts?.narrow && opts.pph && dayIdxs.length) {
        const nightIdxs = idxs.filter((i) => !points[i].isDay);
        const minGap = opts.minGapPx ?? 22;
        const dayI = out[out.length - 1].i;
        const dayX = (dayI + 0.5) * opts.pph;
        const nightPick = nightIdxs.find(
          (i) => Math.abs((i + 0.5) * opts.pph! - dayX) >= minGap,
        );
        if (nightPick != null) {
          const np = points[nightPick];
          out.push({
            i: nightPick,
            slot: di + 0.5,
            code: np.weatherCode,
            isDay: false,
          });
        }
      }
    });
    return out;
  }

  const candidates: WeatherIconSlot[] = [];
  points.forEach((p, i) => {
    const hr = locDate(p.time).getHours();
    if (hr % step !== 0) return;
    candidates.push({ i, slot: hr / step, isDay: p.isDay });
  });

  if (!opts?.narrow || !opts.pph) return candidates;

  const minGap = opts.minGapPx ?? 22;
  const sorted = [...candidates].sort((a, b) => {
    if (a.isDay !== b.isDay) return a.isDay ? -1 : 1;
    return a.i - b.i;
  });
  const picked: WeatherIconSlot[] = [];
  for (const c of sorted) {
    const cx = (c.i + 0.5) * opts.pph;
    const fits = picked.every(
      (p) => Math.abs((p.i + 0.5) * opts.pph! - cx) >= minGap,
    );
    if (fits) picked.push(c);
  }
  return picked;
}

function iconNightClass(isDay: boolean) {
  return isDay ? "" : " night";
}

const LEGEND_VAL_CH: Record<Tab, number> = {
  temp: 7,
  feels: 7,
  outfit: 7,
  dewpoint: 7,
  precip: 8,
  wind: 7,
  uv: 3,
  cloud: 5,
  humidity: 5,
  pressure: 8,
};

function legendValCh(tab: Tab): number {
  return LEGEND_VAL_CH[tab];
}

function formatLegendValue(tab: Tab, v: number): string {
  switch (tab) {
    case "temp":
    case "feels":
    case "dewpoint":
      return `${Math.round(v)} °C`;
    case "precip":
      return `${fmtPrecip(v)} mm`;
    case "wind":
      return `${v.toFixed(0)} m/s`;
    case "cloud":
    case "humidity":
      return `${Math.round(v)} %`;
    case "pressure":
      return `${Math.round(v)} hPa`;
    case "uv":
      return `${Math.round(v)}`;
    case "outfit":
      return `${Math.round(v)} °C`;
  }
}

function ModelLegendValue({
  tab,
  value,
  feels,
  activity,
  legendValStyle,
}: {
  tab: Tab;
  value?: number | null;
  feels?: number | null;
  activity: Activity;
  legendValStyle: CSSProperties;
}) {
  if (tab === "outfit") {
    const raw =
      feels ??
      (value != null && Number.isFinite(value)
        ? value - ACTIVITY_OFFSET[activity]
        : null);
    if (raw == null || !Number.isFinite(raw)) {
      return <strong className="mg-legend-val">–</strong>;
    }
    const pick = outfitAt(raw, activity);
    const main = pick.jacket.kind === "none" ? pick.top.kind : pick.jacket.kind;
    const label =
      pick.jacket.kind === "none" ? pick.top.label : pick.jacket.label;
    const color = outfitLevelColor(pick.level);
    return (
      <strong
        className="mg-legend-outfit"
        style={{ color }}
        title={outfitLabel(pick.top, pick.jacket, tr)}
      >
        <span className="mg-legend-cloth">
          <ClothIcon kind={main} size={16} />
        </span>
        {tr(label)}
      </strong>
    );
  }
  return (
    <strong className="mg-legend-val" style={legendValStyle}>
      {value != null && Number.isFinite(value)
        ? formatLegendValue(tab, value)
        : "–"}
    </strong>
  );
}

export function MeteogramBody({
  hourly,
  activeDate,
  lat,
  lon,
  model = "best_match",
  theme = "dark",
  utcOffset,
  embed = false,
  parts: partsProp,
  multiMode = false,
  openTabs,
  onToggleTab,
  focusTab,
  onFocusTab,
  fixedTab,
  hideLegend = false,
  hideIcons = false,
  plotWidth: plotWidthProp,
  cursor: cursorProp,
  onCursorChange,
  windowStart: windowStartProp,
  modelValues,
  onModelValues,
}: Props) {
  const parts = partsProp ?? (embed ? "plot" : "all");
  const needsPlotSeries = parts === "all" || parts === "plot";
  const needsChartFetch = needsPlotSeries;
  const needsNowTick =
    parts === "all" || parts === "plot" || parts === "axis";
  const needsPlotUi = needsPlotSeries;
  const needsIconStrip = needsPlotUi || parts === "head";
  const [tab, setTab] = useStoredState<Tab>("zmoknu.mgTab", "temp");
  const [multiCharts, setMultiCharts] = useStoredState(
    "zmoknu.mgMultiCharts",
    false,
  );
  const [openTabsStored, setOpenTabsStored] = useStoredState<Tab[]>(
    "zmoknu.mgOpenTabs",
    ["temp"],
  );
  const effectiveOpenTabs = openTabs ?? openTabsStored;
  const chartTab = fixedTab ?? tab;
  const [compareModels, setCompareModels] = useStoredState<string[]>(
    "zmoknu.mgCompare",
    [],
  );
  const [modelSeries, setModelSeries] = useState<ModelSeries[]>([]);
  const [showSpread, setShowSpread] = useStoredState<boolean>(
    "zmoknu.mgSpread",
    true,
  );
  const [spreadSeries, setSpreadSeries] = useState<ModelSeries[]>([]);
  const [pinned, setPinned] = useStoredState<Record<Tab, boolean>>(
    "zmoknu.mgPinned2",
    DEFAULT_PINNED,
  );
  const [tabOrderRaw, setTabOrder] = useStoredState<Tab[]>(
    "zmoknu.mgTabOrder",
    ALL_TABS,
  );
  const tabOrder = useMemo(
    () => normalizeTabOrder(tabOrderRaw),
    [tabOrderRaw],
  );
  const tabOrderRef = useRef(tabOrder);
  tabOrderRef.current = tabOrder;
  // Stejný klíč jako karta „Co si vzít na sebe" – výběr aktivity je společný.
  const [activity, setActivity] = useStoredState<Activity>(
    "wear.activity",
    "walk",
  );
  const [days, setDays] = useStoredState<number>("zmoknu.mgDays", 2);
  const [nightShading, setNightShading] = useStoredState<boolean>(
    "zmoknu.mgNight",
    true,
  );
  const [showNormal, setShowNormal] = useStoredState<boolean>(
    "zmoknu.mgNormal",
    false,
  );
  const [showTypeInfo, setShowTypeInfo] = useStoredState<boolean>(
    "zmoknu.mgTypeInfo",
    true,
  );
  // UV bez oblačnosti (clear-sky) jako referenční čára – volitelné, výchozí vyp.
  const [showUvClearSky, setShowUvClearSky] = useStoredState<boolean>(
    "zmoknu.mgUvClearSky",
    false,
  );
  const [normals, setNormals] = useState<ClimateNormals | null>(null);
  const [normalLoading, setNormalLoading] = useState(false);
  const [normalError, setNormalError] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const [dragTab, setDragTab] = useState<Tab | null>(null);
  const tabRowRefs = useRef<Map<Tab, HTMLElement>>(new Map());
  const viewRef = useRef<HTMLDivElement>(null);
  const viewBtnRef = useRef<HTMLButtonElement>(null);
  const viewMenuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{
    top?: number;
    bottom?: number;
    right: number;
    maxH: number;
    width: number;
  } | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const [widthLocal, setWidthLocal] = useState(0);
  const width = plotWidthProp ?? widthLocal;

  const togglePin = (t: Tab) => {
    const next = !pinned[t];
    setPinned({ ...pinned, [t]: next });
    if (!next && (multiMode || multiCharts)) {
      setOpenTabsStored((cur) => {
        const filtered = cur.filter((x) => x !== t);
        if (filtered.length) return filtered;
        const fallback = tabOrder.filter((x) => x !== t && pinned[x]);
        if (fallback.length) return [fallback[0]];
        return tab === t ? ["temp"] : [tab];
      });
    }
  };

  const startTabDrag = (e: React.PointerEvent, id: Tab) => {
    e.preventDefault();
    e.stopPropagation();
    setDragTab(id);
    const move = (ev: PointerEvent) => {
      const { clientX: px, clientY: py } = ev;
      let targetId: Tab | null = null;
      let after = false;
      for (const [rid, el] of tabRowRefs.current) {
        const r = el.getBoundingClientRect();
        if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
          targetId = rid;
          after = px > r.left + r.width / 2;
          break;
        }
      }
      if (targetId && targetId !== id) {
        setTabOrder(
          normalizeTabOrder(
            moveTabBefore(tabOrderRef.current, id, targetId, after),
          ),
        );
      }
    };
    const up = () => {
      setDragTab(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // Menu vykreslujeme přes portál mimo kartu (karta má overflow:hidden a ořízla
  // by ho). Pozici počítáme synchronně (useLayoutEffect) ještě před vykreslením,
  // ať menu nikdy neproblikne na staré/mimo-obrazovkové pozici. Při zavření
  // pozici vynulujeme, takže se při dalším otevření spočítá vždy načisto.
  useLayoutEffect(() => {
    if (!viewOpen) {
      setMenuPos(null);
      return;
    }
    const place = () => {
      const b = viewBtnRef.current;
      if (!b) return;
      const r = b.getBoundingClientRect();
      const gap = 6;
      const margin = 8;
      const menuW = Math.min(600, window.innerWidth - margin * 2);
      let right = Math.max(margin, window.innerWidth - r.right);
      const menuLeft = window.innerWidth - right - menuW;
      if (menuLeft < margin) {
        right = window.innerWidth - menuW - margin;
      }
      const below = window.innerHeight - r.bottom - margin - gap;
      const above = r.top - margin - gap;
      if (below >= above) {
        const maxH = Math.min(Math.max(below, 120), 560);
        setMenuPos({ top: r.bottom + gap, right, maxH, width: menuW });
      } else {
        const maxH = Math.min(Math.max(above, 120), 560);
        setMenuPos({
          bottom: window.innerHeight - r.top + gap,
          right,
          maxH,
          width: menuW,
        });
      }
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [viewOpen]);

  // Zavření dropdownu při kliknutí/ťuknutí mimo. Klik na samotné tlačítko řeší
  // jeho onClick (toggle), proto ho tu explicitně ignorujeme – jinak by se menu
  // stihlo zavřít a hned zase otevřít (nebo naopak) a stav by se rozešel.
  useEffect(() => {
    if (!viewOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (viewBtnRef.current?.contains(t)) return;
      if (viewMenuRef.current?.contains(t)) return;
      setViewOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [viewOpen]);

  // Změř šířku plochy grafu (bez scrollu se vše vejde na tuto šířku).
  useEffect(() => {
    if (plotWidthProp != null || parts === "chrome") return;
    const el = plotRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidthLocal(e.contentRect.width);
    });
    ro.observe(el);
    setWidthLocal(el.clientWidth);
    return () => ro.disconnect();
  }, [plotWidthProp, parts]);

  const todayStr = isoLocal(zonedNow(utcOffset));

  // Počet zobrazených dní volí uživatel (1–7) v nabídce zobrazení dat nebo
  // pinch gestem nad grafem.
  const windowHours = Math.min(7, Math.max(1, days)) * 24;

  // Okno drží začátek, dokud vybraný den zůstane uvnitř. Mimo období se
  // posune o minimum (výběr na začátek / konec okna).
  const points = useMemo(() => {
    const base = windowStartProp || activeDate || todayStr;
    let start = hourly.findIndex(
      (h) => h.time.slice(0, 10) === base && locDate(h.time).getHours() === 0,
    );
    if (start === -1) start = hourly.findIndex((h) => h.time.slice(0, 10) >= base);
    if (start === -1) start = 0;
    return hourly.slice(start, start + windowHours);
  }, [hourly, windowStartProp, activeDate, todayStr, windowHours]);

  const activeMissing = useMemo(() => {
    if (!activeDate || !points.length) return false;
    return !points.some((p) => p.time.slice(0, 10) === activeDate);
  }, [activeDate, points]);

  const isCloud = chartTab === "cloud";
  const isPrecip = chartTab === "precip";
  const isCompactPlot = multiMode && parts === "plot";
  const layoutH = isCompactPlot ? 176 : H;
  const layoutTopPad = isCompactPlot ? 8 : TOP_PAD;
  const layoutMiniH = isCompactPlot ? 26 : MINI_H;
  const layoutCurveBottom = isCompactPlot ? layoutH - 4 : CURVE_BOTTOM;
  const layoutCurveTop = isPrecip ? layoutTopPad : layoutTopPad + layoutMiniH;
  const layoutPrecipBaseline = layoutH - 4;
  // Svislé linky (půlnoc, „teď", kurzor) a denní pruhy vedeme v zásobníku
  // grafů přes celou výšku dlaždice, ať na sebe grafy navazují bez mezer a
  // zvýrazněný den tvoří jeden nepřerušený sloupec.
  const layoutGridBottom = isCompactPlot ? layoutH : layoutH - 4;
  const layoutShadeTop = isCompactPlot ? 0 : layoutTopPad - 10;

  const pph = points.length > 0 && width > 0 ? width / points.length : 0;
  const x = (i: number) => (i + 0.5) * pph;
  // Půlnoc / hranice dne = levý okraj hodinového sloupce (0:00, 24:00).
  const xBound = (i: number) => i * pph;

  // Krok ikon počasí (v hodinách) podle dostupného místa – při více dnech
  // (menší pph) se ikony ředí, ať se nepřekrývají. Na úzkém displeji jeden
  // řádek: nejdřív denní hodiny, noční jen když se vejdou.
  const iconsNarrow = width > 0 && width < 520;
  const iconMinGap = iconsNarrow ? 22 : 26;
  const iconStep = useMemo(() => {
    if (!pph) return 2;
    for (const s of [2, 3, 4, 6, 12]) {
      if (s * pph >= iconMinGap) return s;
    }
    return 24;
  }, [pph, iconMinGap]);
  // Šipky větru v jedné řadě – potřebují víc místa než ikony ve dvou řadách.
  const windIconStep = useMemo(() => {
    if (!pph) return 3;
    for (const s of [2, 3, 4, 6, 12]) {
      if (s * pph >= 20) return s;
    }
    return 24;
  }, [pph]);
  // Šipky směru větru: u jediného grafu na tabu „vítr", v multi režimu přímo
  // v dlaždici vítru (společný pás nahoře zůstává ikonám počasí).
  const showWindStrip =
    chartTab === "wind" && (!multiMode || isCompactPlot);
  const weatherIconStep = showWindStrip ? windIconStep : iconStep;
  const weatherIconSlots = useMemo(
    () =>
      buildWeatherIconSlots(points, weatherIconStep, {
        narrow: iconsNarrow,
        pph,
        minGapPx: iconMinGap,
      }),
    [points, weatherIconStep, iconsNarrow, pph, iconMinGap],
  );
  const iconsZigzag = !iconsNarrow && weatherIconStep * pph < 24;

  // Multimód: stáhni hodinovou řadu pro aktuální veličinu z vybraných modelů.
  const omVar = TAB_OM_VAR[chartTab];
  useEffect(() => {
    if (!needsChartFetch) return;
    // best_match je globální model (hlavní čára), v porovnání ho neduplikujeme.
    const cmp = compareModels.filter((m) => m !== "best_match");
    if (!cmp.length || lat == null || lon == null) {
      setModelSeries([]);
      return;
    }
    let cancelled = false;
    fetchModelSeries(lat, lon, omVar, cmp)
      .then((s) => {
        if (!cancelled) setModelSeries(s);
      })
      .catch(() => {
        if (!cancelled) setModelSeries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [needsChartFetch, compareModels, lat, lon, omVar]);

  // Pás nejistoty (alternate predictions): stáhni globální modely pro teplotu
  // / pocitovou a z jejich rozptylu vykresli pásmo kolem hlavní čáry.
  const spreadEnabled =
    needsChartFetch &&
    showSpread &&
    (chartTab === "temp" || chartTab === "feels" || chartTab === "precip");
  useEffect(() => {
    if (!needsChartFetch || !spreadEnabled || lat == null || lon == null) {
      setSpreadSeries([]);
      return;
    }
    let cancelled = false;
    fetchModelSeries(lat, lon, omVar, SPREAD_MODELS)
      .then((s) => {
        if (!cancelled) setSpreadSeries(s);
      })
      .catch(() => {
        if (!cancelled) setSpreadSeries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [needsChartFetch, spreadEnabled, lat, lon, omVar]);

  // Historický normál (ERA5, 30 let) – stáhne se jednou pro lokalitu při zapnutí.
  useEffect(() => {
    if (
      !needsChartFetch ||
      !showNormal ||
      chartTab !== "temp" ||
      lat == null ||
      lon == null
    ) {
      setNormalLoading(false);
      setNormalError(false);
      return;
    }
    let cancelled = false;
    setNormalLoading(true);
    setNormalError(false);
    fetchClimateNormals(lat, lon)
      .then((n) => {
        if (cancelled) return;
        setNormals(n);
        setNormalLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setNormals(null);
        setNormalError(true);
        setNormalLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [needsChartFetch, showNormal, chartTab, lat, lon]);

  const toggleCompare = (id: string) =>
    setCompareModels(
      compareModels.includes(id)
        ? compareModels.filter((m) => m !== id)
        : [...compareModels, id],
    );

  // Modely dostupné pro porovnání (bez „Automaticky") a zda jsou vybrané všechny.
  const compareIds = useMemo(
    () => WEATHER_MODELS.filter((m) => m.id !== "best_match").map((m) => m.id),
    [],
  );
  const allCompared = compareIds.every((id) => compareModels.includes(id));

  // „Teď" počítáme v zóně lokality: časy bodů (locDate) i aktuální čas
  // (zonedNow) mají stejný posun zařízení, takže porovnání sedí i v cizí zóně.
  // Tik jednou za minutu posouvá značku i při dlouho otevřené appce.
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    if (!needsNowTick) return;
    const id = window.setInterval(() => setNowTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, [needsNowTick]);

  // Index "teď" – jen když je aktuální čas uvnitř okna.
  const nowIndex = useMemo(() => {
    if (!points.length) return -1;
    const now = zonedNow(utcOffset).getTime();
    const first = locDate(points[0].time).getTime();
    const last = locDate(points[points.length - 1].time).getTime();
    if (now < first - 1_800_000 || now > last + 1_800_000) return -1;
    let best = 0;
    let bestDiff = Infinity;
    points.forEach((p, i) => {
      const diff = Math.abs(locDate(p.time).getTime() - now);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    });
    return best;
  }, [points, utcOffset, nowTick]);

  // Spojitá X pozice "teď" (posouvá se podle času, ne skokově po hodinách).
  const nowX = useMemo(() => {
    if (!points.length || !pph) return -1;
    const now = zonedNow(utcOffset).getTime();
    const first = locDate(points[0].time).getTime();
    const last = locDate(points[points.length - 1].time).getTime();
    if (now < first - 1_800_000 || now > last + 1_800_000) return -1;
    const fi = (now - first) / 3_600_000;
    return x(fi);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, pph, utcOffset, nowTick]);

  const [cursorLocal, setCursorLocal] = useState(0);
  const cursor = cursorProp ?? cursorLocal;
  const setCursor = onCursorChange ?? setCursorLocal;
  const cursorIdxRef = useRef(0);
  const pointerRaf = useRef(0);
  const pendingPointerX = useRef<number | null>(null);
  const cursorInit = useRef(false);
  useEffect(() => {
    if (cursorProp != null) return;
    setCursorLocal(nowIndex >= 0 ? nowIndex : Math.min(12, points.length - 1));
  }, [nowIndex, points.length, cursorProp]);
  useEffect(() => {
    if (
      parts !== "chrome" ||
      cursorProp == null ||
      !onCursorChange ||
      !points.length ||
      cursorInit.current
    ) {
      return;
    }
    cursorInit.current = true;
    onCursorChange(
      nowIndex >= 0 ? nowIndex : Math.min(12, points.length - 1),
    );
  }, [parts, cursorProp, onCursorChange, nowIndex, points.length]);

  const precipMax = useMemo(
    () => Math.max(1, ...points.map((p) => p.precipitation)),
    [points],
  );

  const activeKey = activeDate || todayStr;
  const isActiveDayEdge = (i: number) => {
    const d = points[i]?.time.slice(0, 10);
    const prev = i > 0 ? points[i - 1].time.slice(0, 10) : null;
    return d === activeKey || prev === activeKey;
  };

  // Popisek dne: „Dnes"/„Zítra"/„Včera", jinak den + datum (plný název, pokud se vejde).
  const dayLabelFor = (
    b: { date: Date; dateStr: string },
    bandWidthPx?: number,
  ) => {
    if (b.dateStr === todayStr) return tr("Dnes");
    const diff = Math.round(
      (Date.parse(b.dateStr) - Date.parse(todayStr)) / 86400000,
    );
    if (diff === 1) return tr("Zítra");
    if (diff === -1) return tr("Včera");
    const datePart = `${b.date.getDate()}.${b.date.getMonth() + 1}.`;
    const longLabel = `${dayLong()[b.date.getDay()]}, ${datePart}`;
    if (
      bandWidthPx != null &&
      bandWidthPx >= estimateDayLabelWidth(longLabel)
    ) {
      return longLabel;
    }
    return `${dayShort()[b.date.getDay()]}, ${datePart}`;
  };

  const renderActiveDayOverlay = (
    segment: "top" | "head" | "chrome" | "stack" | "full",
  ) => {
    const band = dayBands.find((b) => b.dateStr === activeKey);
    if (!band || !pph) return null;
    const left = band.startI * pph;
    const w = (band.endI + 1) * pph - left;
    if (w <= 0) return null;
    const showBottomEdge = segment === "stack" || segment === "full";
    const iconStripH = showWindStrip ? 26 : showOutfitStrip ? 30 : iconsZigzag ? 36 : 22;
    const edgeTop =
      segment === "full"
        ? iconStripH + dayPillMidY(SINGLE_DAY_LABEL_Y)
        : segment === "chrome"
          ? dayPillMidY(AXIS_DAY_Y)
          : undefined;
    return (
      <div
        className={`mg-active-day-col seg-${segment}`}
        style={{
          left,
          width: w,
          ...(edgeTop != null
            ? { ["--mg-ad-edge-top" as string]: `${edgeTop}px` }
            : null),
        }}
        aria-hidden="true"
      >
        <span className="mg-ad-edge mg-ad-edge-l" />
        <span className="mg-ad-edge mg-ad-edge-r" />
        {showBottomEdge && <span className="mg-ad-edge mg-ad-edge-b" />}
      </div>
    );
  };

  const renderActiveDayTopBracket = (
    bandLeft: number,
    bandRight: number,
    cx: number,
    labelY: number,
    pillW: number,
  ) => {
    const pillY = labelY - DAY_PILL_Y_INSET;
    const midY = pillY + DAY_PILL_H / 2;
    const pillLeft = cx - pillW / 2;
    const pillRight = cx + pillW / 2;
    const leftD = `M ${bandLeft} ${midY} H ${pillLeft}`;
    const rightD = `M ${pillRight} ${midY} H ${bandRight}`;
    return (
      <g className="mg-day-bracket" aria-hidden="true">
        <path d={leftD} />
        <path d={rightD} />
      </g>
    );
  };

  const renderStormOverlays = () => {
    if (!pph || !stormBars.length) return null;
    return (
      <div className="mg-storm-layer" aria-hidden="true">
        {stormBars.map((b) => {
          const left = x(b.startI) - pph * 0.5;
          const width = Math.max(0, x(b.endI) + pph * 0.5 - left);
          const op = isPrecip
            ? 0.16 + 0.34 * (Math.max(0, b.prob) / 100)
            : 0.09 + 0.2 * (Math.max(0, b.prob) / 100);
          return (
            <div
              key={`storm-ol-${b.startI}`}
              className="mg-storm-bar"
              style={{ left, width }}
            >
              <div className="mg-storm-bar-fill" style={{ opacity: op }} />
              <StormBoltMark hail={b.hail} />
            </div>
          );
        })}
      </div>
    );
  };

  const renderDayBoundaries = () => {
    if (!pph) return null;
    return (
      <div className="mg-day-dividers" aria-hidden="true">
        {points.map((p, i) => {
          const h = locDate(p.time).getHours();
          if (h !== 0 || isActiveDayEdge(i) || xBound(i) <= 0) return null;
          return (
            <span
              key={`day-div-${i}`}
              className="mg-day-divider"
              style={{ left: xBound(i) }}
            />
          );
        })}
      </div>
    );
  };

  const renderPlotHairs = () => {
    if (!pph) return null;
    const cursorX = x(ci);
    const hideNowHair = nowX >= 0 && Math.abs(nowX - cursorX) < 3;
    return (
      <>
        {nowX >= 0 && !hideNowHair && (
          <span
            className="mg-plot-hair now"
            style={{
              left: nowX,
              ["--now" as string]:
                theme === "light"
                  ? "rgba(196,124,0,0.95)"
                  : "rgba(255,209,102,0.9)",
            }}
            aria-hidden="true"
          />
        )}
        <span
          className="mg-plot-hair"
          style={{ left: cursorX }}
          aria-hidden="true"
        />
      </>
    );
  };

  const renderPlotHairsSvg = (height = layoutH) => {
    if (!pph) return null;
    const cursorX = x(ci);
    const hideNowHair = nowX >= 0 && Math.abs(nowX - cursorX) < 3;
    const nowColor =
      theme === "light" ? "rgba(196,124,0,0.95)" : "rgba(255,209,102,0.9)";
    return (
      <g
        className="mg-hairs-svg"
        style={{ ["--now" as string]: nowColor }}
        aria-hidden="true"
      >
        {nowX >= 0 && !hideNowHair && (
          <line
            x1={nowX}
            y1={0}
            x2={nowX}
            y2={height}
            className="mg-hair-line now"
          />
        )}
        <line
          x1={cursorX}
          y1={0}
          x2={cursorX}
          y2={height}
          className="mg-hair-line"
        />
      </g>
    );
  };

  const renderDayLabelsOverlay = () => {
    if (isCompactPlot || !pph) return null;
    return dayBands.map((b, bi) => {
      const left = b.startI * pph;
      const right = (b.endI + 1) * pph;
      const isToday = b.dateStr === todayStr;
      const isActive = b.dateStr === activeKey;
      const label = dayLabelFor(b, right - left);
      const cx = (left + right) / 2;
      return (
        <g key={`dl-${bi}`}>
          {renderDayPillLabel(
            cx,
            SINGLE_DAY_LABEL_Y,
            label,
            isToday,
            isActive,
            isActive ? left : undefined,
            isActive ? right : undefined,
          )}
        </g>
      );
    });
  };

  const renderPlotValueLabels = () => {
    if (!pph) return null;
    const hasNowPill =
      !isCompactPlot && nowX >= 0 && Math.abs(nowX - x(ci)) > 44;
    const hasCursorDot =
      !isCloud && !isPrecip && Number.isFinite(series.primary[ci]);
    const valueLabels = isCloud ? null : isPrecip ? (
      precipBars
        .filter((b) => precipLabelSet.has(b.startI))
        .map((b) => {
          const cx = (x(b.startI) + x(b.endI)) / 2;
          const top = yPrecip(b.value);
          return (
            <text
              key={`pl-${b.startI}`}
              x={cx}
              y={Math.max(layoutTopPad + 8, top - 5)}
              className="mg-extrema precip"
              textAnchor="middle"
              opacity={0.45 + 0.55 * (Math.max(0, b.prob) / 100)}
            >
              {fmtPrecip(b.value)}
            </text>
          );
        })
    ) : (
      <>
        {valueLabelList.map((e) => (
          <text
            key={`ex-${e.i}`}
            x={x(e.i)}
            y={clampExtremaY(
              yCurve(labelValues[e.i]),
              e.kind,
              layoutTopPad,
              layoutH,
              layoutCurveBottom,
            )}
            className={`mg-extrema ${labelColor}`}
            textAnchor="middle"
            fill={
              chartTab === "wind"
                ? windBandColor(labelValues[e.i])
                : undefined
            }
          >
            {series.fmt(labelValues[e.i])}
          </text>
        ))}
        {gustLabelList.map((e) => {
          const gv = series.secondary![e.i];
          if (!Number.isFinite(gv)) return null;
          return (
            <text
              key={`gust-${e.i}`}
              x={x(e.i)}
              y={clampExtremaY(
                yCurve(gv),
                e.kind,
                layoutTopPad,
                layoutH,
                layoutCurveBottom,
              )}
              className="mg-extrema gust"
              textAnchor="middle"
              fill={windBandColor(gv)}
            >
              {series.fmt(gv)}
            </text>
          );
        })}
      </>
    );
    if (!valueLabels && !hasNowPill && !hasCursorDot) return null;
    return (
      <svg
        width={width || 1}
        height={layoutH}
        className="mg-svg mg-svg-labels"
        aria-hidden="true"
      >
        {valueLabels}
        {hasCursorDot && (
          <circle
            cx={x(ci)}
            cy={yCurve(series.primary[ci])}
            r="4.5"
            fill="#fff"
            stroke={
              chartTab === "temp" || chartTab === "feels"
                ? tempColor(series.primary[ci])
                : chartTab === "uv"
                  ? uvColor(series.primary[ci])
                  : chartTab === "wind"
                    ? windBandColor(series.primary[ci])
                    : series.stroke
            }
            strokeWidth="2"
          />
        )}
        {hasNowPill && (
          <g
            transform={`translate(${Math.max(17, Math.min(width - 17, nowX))}, ${SINGLE_NOW_Y})`}
          >
            <rect
              x={-16}
              y={0}
              width={32}
              height={14}
              rx="7"
              fill={theme === "light" ? "#b9750a" : "rgba(255,209,102,0.92)"}
            />
            <text
              x={0}
              y={7}
              className="mg-nowlabel"
              textAnchor="middle"
              dominantBaseline="central"
              fill={theme === "light" ? "#fff" : undefined}
            >
              {tr("Teď")}
            </text>
          </g>
        )}
      </svg>
    );
  };

  const renderCursorTip = () => {
    if (!pph) return null;
    return (
      <div
        className="mg-cursor-tip"
        style={{ left: x(ci) }}
        aria-hidden="true"
      >
        {cursorHourLabel(active.time, utcOffset)}
      </div>
    );
  };

  const renderDayPillLabel = (
    cx: number,
    y: number,
    label: string,
    isToday: boolean,
    isActive: boolean,
    bandLeft?: number,
    bandRight?: number,
  ) => {
    const pillW = Math.max(28, estimateDayLabelWidth(label));
    const pillY = y - DAY_PILL_Y_INSET;
    const textY = pillY + DAY_PILL_H / 2;
    return (
      <g>
        {isActive &&
          bandLeft != null &&
          bandRight != null &&
          renderActiveDayTopBracket(bandLeft, bandRight, cx, y, pillW)}
        <rect
          className={`mg-day-pill${isActive ? "" : " inactive"}`}
          x={cx - pillW / 2}
          y={pillY}
          width={pillW}
          height={DAY_PILL_H}
          rx={DAY_PILL_H / 2}
        />
        <text
          x={cx}
          y={textY}
          className={`mg-daylabel${isActive ? " selected" : ""}${isToday ? " today" : ""}`}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {label}
        </text>
      </g>
    );
  };

  const dayBands = useMemo(() => {
    const bands: { startI: number; endI: number; date: Date; dateStr: string }[] =
      [];
    if (!points.length) return bands;
    let startI = 0;
    for (let i = 1; i <= points.length; i++) {
      const prevStr = points[i - 1].time.slice(0, 10);
      const curStr = i < points.length ? points[i].time.slice(0, 10) : null;
      if (curStr !== prevStr) {
        bands.push({
          startI,
          endI: i - 1,
          date: locDate(points[i - 1].time),
          dateStr: prevStr,
        });
        startI = i;
      }
    }
    return bands;
  }, [points]);

  // Noční úseky = souvislé běhy hodin s isDay === false. Hranice klademe na
  // půl hodiny mezi denní a noční hodinou, což zhruba odpovídá východu/západu.
  const nightBands = useMemo(() => {
    const bands: { startI: number; endI: number }[] = [];
    if (!points.length) return bands;
    let run: { startI: number; endI: number } | null = null;
    points.forEach((p, i) => {
      if (!p.isDay) {
        if (!run) run = { startI: i, endI: i };
        else run.endI = i;
      } else if (run) {
        bands.push(run);
        run = null;
      }
    });
    if (run) bands.push(run);
    return bands;
  }, [points]);

  // Geometrie nočních pásů (levý/pravý okraj v px) pro vykreslení.
  const nightShades = useMemo(() => {
    if (!pph || !nightShading) return [];
    return nightBands.map((b, bi) => ({
      id: `night-${bi}`,
      left: Math.max(0, x(b.startI) - pph / 2),
      right: Math.min(width, x(b.endI) + pph / 2),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nightBands, pph, width, nightShading]);

  const daytimeBands = useMemo(() => {
    const bands: { startI: number; endI: number }[] = [];
    if (!points.length) return bands;
    let run: { startI: number; endI: number } | null = null;
    points.forEach((p, i) => {
      if (p.isDay) {
        if (!run) run = { startI: i, endI: i };
        else run.endI = i;
      } else if (run) {
        bands.push(run);
        run = null;
      }
    });
    if (run) bands.push(run);
    return bands;
  }, [points]);

  const dayShades = useMemo(() => {
    if (!pph || !nightShading) return [];
    return daytimeBands.map((b, bi) => ({
      id: `iday-${bi}`,
      left: Math.max(0, x(b.startI) - pph / 2),
      right: Math.min(width, x(b.endI) + pph / 2),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daytimeBands, pph, width, nightShading]);

  const renderIconStripShades = () => {
    if (!pph) return null;
    return (
      <>
        {dayBands.map((b, bi) => {
          if (b.dateStr !== activeKey || b.dateStr < todayStr) return null;
          const left = b.startI * pph;
          const width = (b.endI + 1) * pph - left;
          return (
            <span
              key={`iact-${bi}`}
              className="mg-icons-shade active"
              style={{ left, width }}
              aria-hidden="true"
            />
          );
        })}
        {dayBands.map((b, bi) => {
          if (b.dateStr >= todayStr) return null;
          const left = b.startI * pph;
          const width = (b.endI + 1) * pph - left;
          return (
            <span
              key={`ipast-${bi}`}
              className="mg-icons-shade past"
              style={{ left, width }}
              aria-hidden="true"
            />
          );
        })}
        {nightShading &&
          dayShades.map((s) => (
            <span
              key={s.id}
              className="mg-icons-shade day"
              style={{
                left: s.left,
                width: Math.max(0, s.right - s.left),
              }}
              aria-hidden="true"
            />
          ))}
        {nightShading &&
          nightShades.map((s) => (
            <span
              key={s.id}
              className="mg-icons-shade night"
              style={{
                left: s.left,
                width: Math.max(0, s.right - s.left),
              }}
              aria-hidden="true"
            />
          ))}
      </>
    );
  };

  const baseSeries = useMemo(
    () =>
      needsPlotSeries
        ? buildSeries(chartTab, points, activity)
        : buildSeries("temp", points.slice(0, 1), activity),
    [needsPlotSeries, chartTab, points, activity],
  );

  // Historický normál kreslíme jen u skutečné teploty (naše data jsou teplotní).
  // Hodnotu plynule interpolujeme mezi dny podle hodiny, aby se čára viditelně
  // měnila den ode dne (ne plochý schod na den).
  const normalData = useMemo(() => {
    if (!showNormal || !normals || chartTab !== "temp") return null;
    const mean = points.map((p) => interpNormal(normals.mean, p.time));
    const max = points.map((p) => interpNormal(normals.max, p.time));
    const min = points.map((p) => interpNormal(normals.min, p.time));
    if (!mean.some((v) => v != null)) return null;
    return { mean, max, min };
  }, [showNormal, normals, chartTab, points]);

  // Osa Y musí pojmout i normál (pásmo min–max), ať čára nevyjede z grafu.
  const series = useMemo(() => {
    if (!normalData) return baseSeries;
    let { min, max } = baseSeries;
    for (const arr of [normalData.min, normalData.max]) {
      for (const v of arr) {
        if (v != null && Number.isFinite(v)) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
    }
    return { ...baseSeries, min, max };
  }, [baseSeries, normalData]);

  const precipBars = useMemo(() => {
    const bars: { startI: number; endI: number; value: number; prob: number }[] =
      [];
    let i = 0;
    while (i < points.length) {
      const v = points[i].precipitation;
      if (v <= 0) {
        i++;
        continue;
      }
      let j = i;
      let prob = points[i].precipitationProbability;
      while (
        j + 1 < points.length &&
        Math.abs(points[j + 1].precipitation - v) < 0.01
      ) {
        j++;
        prob = Math.max(prob, points[j].precipitationProbability);
      }
      bars.push({ startI: i, endI: j, value: v, prob });
      i = j + 1;
    }
    return bars;
  }, [points]);

  // Které srážkové sloupce popisovat hodnotou: hlavně ty pravděpodobnější
  // (prob ≥ 50 %). Když žádný takový není (např. model bez pravděpodobnosti),
  // popíšeme aspoň ten s největším úhrnem, ať graf není bez čísel.
  const precipLabelSet = useMemo(() => {
    const probable = precipBars.filter((b) => b.prob >= 50);
    const chosen = probable.length
      ? probable
      : precipBars.slice().sort((a, b) => b.value - a.value).slice(0, 1);
    return new Set(chosen.map((b) => b.startI));
  }, [precipBars]);

  // Rozptyl srážek napříč modely (zobrazení nejistoty přímo v grafu, jen na
  // záložce Srážky se zapnutým přepínačem). Pro každou hodinu min/max/medián
  // úhrnu z modelů (+ hlavní čára). Srážky mají nesymetrické rozdělení, takže
  // rozptyl ukazujeme jako rozpětí (min–max), ne jako symetrickou odchylku.
  const precipSpread = useMemo(() => {
    if (!isPrecip || !spreadEnabled || spreadSeries.length < 2) return null;
    return points.map((p) => {
      const vals: number[] = [];
      for (const ms of spreadSeries) {
        const v = ms.byTime.get(p.time);
        if (v != null && Number.isFinite(v)) vals.push(v);
      }
      if (Number.isFinite(p.precipitation)) vals.push(p.precipitation);
      if (vals.length < 2) return null;
      vals.sort((a, b) => a - b);
      const half = vals.length / 2;
      const median =
        vals.length % 2
          ? vals[(vals.length - 1) / 2]
          : (vals[half - 1] + vals[half]) / 2;
      return { min: vals[0], max: vals[vals.length - 1], median };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPrecip, spreadEnabled, spreadSeries, points]);

  const precipSpreadMax = useMemo(() => {
    if (!precipSpread) return 0;
    let m = 0;
    for (const r of precipSpread) if (r) m = Math.max(m, r.max);
    return m;
  }, [precipSpread]);

  // Nejvyšší hodinový úhrn napříč porovnávanými modely (jen v tabu srážek),
  // ať se srážková osa roztáhne i pro čáry modelů a nepřetečou mimo graf.
  const compareMaxPrecip = useMemo(() => {
    if (!isPrecip || !modelSeries.length) return 0;
    let m = 0;
    for (const p of points) {
      for (const ms of modelSeries) {
        const v = ms.byTime.get(p.time);
        if (v != null && Number.isFinite(v)) m = Math.max(m, v);
      }
    }
    return m;
  }, [isPrecip, modelSeries, points]);

  // Bouřkové úseky (WMO 95/96/99) – zvýrazníme je ve srážkovém grafu,
  // průhlednost pruhu odpovídá pravděpodobnosti srážek v daném úseku.
  const stormBars = useMemo(() => {
    const isStorm = (c: number) => c === 95 || c === 96 || c === 99;
    const bars: {
      startI: number;
      endI: number;
      prob: number;
      hail: boolean;
    }[] = [];
    let i = 0;
    while (i < points.length) {
      if (!isStorm(points[i].weatherCode)) {
        i++;
        continue;
      }
      let j = i;
      let prob = points[i].precipitationProbability;
      let hail = points[i].weatherCode !== 95;
      while (j + 1 < points.length && isStorm(points[j + 1].weatherCode)) {
        j++;
        prob = Math.max(prob, points[j].precipitationProbability);
        hail = hail || points[j].weatherCode !== 95;
      }
      bars.push({ startI: i, endI: j, prob, hail });
      i = j + 1;
    }
    return bars;
  }, [points]);

  // Horní okraj křivky. U ostatních veličin než srážky posuneme křivku pod
  // horní pruh s mini srážkami, aby se nepřekrývaly. U tabu srážek kreslíme
  // odshora jako dřív.
  const curveTop = layoutCurveTop;

  const yCurve = (v: number) => {
    const t = (v - series.min) / Math.max(0.001, series.max - series.min);
    return layoutCurveBottom - t * (layoutCurveBottom - curveTop);
  };

  // U tabu srážek kreslíme sloupce od úplného spodku grafu (víc místa). Když je
  // zapnutý rozptyl modelů a některý model „vidí" víc srážek než hlavní čára,
  // roztáhneme měřítko, aby se úsečky nejistoty vešly (sdílené se sloupci).
  const PRECIP_BASELINE = layoutPrecipBaseline;
  const precipPeak = Math.max(precipSpreadMax, compareMaxPrecip);
  const precipScaleMax =
    precipPeak > series.max ? niceMax(precipPeak) : series.max;
  const yPrecip = (v: number) =>
    PRECIP_BASELINE -
    (v / Math.max(0.001, precipScaleMax)) * (PRECIP_BASELINE - layoutTopPad);

  // Srážky: vodorovné prahové čáry intenzity (mírný / silný déšť).
  const precipThresholds = useMemo(() => {
    if (!isPrecip) return [];
    return PRECIP_BANDS.filter((b) => b.v < precipScaleMax).map((b) => ({
      ...b,
      y: yPrecip(b.v),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPrecip, precipScaleMax]);

  // Čára s mezerami: kde chybí data (NaN), pero se zvedne a po datech se
  // začne kreslit znovu (nová „M"). Nekreslíme tedy propad na 0.
  const buildLine = (values: number[]) => {
    let d = "";
    let pen = false;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"} ${x(i)} ${yCurve(v)} `;
      pen = true;
    }
    return d.trim();
  };

  const linePath = useMemo(() => {
    if (!needsPlotSeries || !pph) return "";
    return buildLine(series.primary);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsPlotSeries, series, points.length, pph]);

  const secondaryPath = useMemo(() => {
    if (!needsPlotSeries || !series.secondary || !pph) return "";
    return buildLine(series.secondary);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsPlotSeries, series, points.length, pph]);

  const refLinePath = useMemo(() => {
    if (!needsPlotSeries || !series.refLine || !pph) return "";
    return buildLine(series.refLine.values);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsPlotSeries, series, points.length, pph]);

  const extraPaths = useMemo(() => {
    if (!needsPlotSeries || !series.extras || !pph) return [];
    return series.extras.map((ex) => ({
      color: ex.color,
      d: buildLine(ex.values),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsPlotSeries, series, points.length, pph]);

  // Normál: pásmo min–max (obvyklý rozsah) pro kontext.
  const normalBandPath = useMemo(() => {
    if (!normalData || !pph) return "";
    const { max, min } = normalData;
    let d = "";
    let started = false;
    for (let i = 0; i < max.length; i++) {
      const v = max[i];
      if (v == null) continue;
      d += `${started ? "L" : "M"} ${x(i)} ${yCurve(v)} `;
      started = true;
    }
    for (let i = min.length - 1; i >= 0; i--) {
      const v = min[i];
      if (v == null) continue;
      d += `L ${x(i)} ${yCurve(v)} `;
    }
    if (!started) return "";
    d += "Z";
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalData, pph, series]);

  // Rozdíl PRŮMĚRNÝCH teplot po dnech: pro každý den spočítáme denní průměr
  // předpovědi a denní normál, vyznačíme obě úrovně vodorovně a plochu mezi
  // nimi obarvíme (teple = tepleji než obvykle, chladně = chladněji).
  const anomalyDays = useMemo(() => {
    if (!normalData || chartTab !== "temp" || !pph) return null;
    const segs: {
      x0: number;
      x1: number;
      yActual: number;
      yNormal: number;
      fill: string;
      line: string;
    }[] = [];
    for (const b of dayBands) {
      let sa = 0;
      let ca = 0;
      let sn = 0;
      let cn = 0;
      for (let i = b.startI; i <= b.endI; i++) {
        const a = points[i]?.temperature;
        if (a != null && Number.isFinite(a)) {
          sa += a;
          ca++;
        }
        const n = normalData.mean[i];
        if (n != null && Number.isFinite(n)) {
          sn += n;
          cn++;
        }
      }
      if (!ca || !cn) continue;
      const aAvg = sa / ca;
      const nAvg = sn / cn;
      const col = anomalyColor(aAvg - nAvg);
      segs.push({
        x0: b.startI * pph,
        x1: (b.endI + 1) * pph,
        yActual: yCurve(aAvg),
        yNormal: yCurve(nAvg),
        fill: col.fill,
        line: col.line,
      });
    }
    return segs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalData, chartTab, points, dayBands, pph, series]);

  // Multimód: čáry jednotlivých modelů pro aktuální veličinu (stejná osa Y).
  const compareLines = useMemo(() => {
    if (!needsPlotSeries || !modelSeries.length || !pph || isCloud) return [];
    // U srážek kreslíme čáry na srážkovou osu (yPrecip), jinak na osu veličiny.
    const yFn = isPrecip ? yPrecip : yCurve;
    // Osa grafu oblečení je pocitovka posunutá o aktivitu – modely vracejí
    // surovou pocitovku, takže jim posun musíme přičíst taky.
    const vOff = chartTab === "outfit" ? ACTIVITY_OFFSET[activity] : 0;
    return modelSeries
      .map((ms) => {
        let d = "";
        let pen = false;
        points.forEach((p, i) => {
          const raw = ms.byTime.get(p.time);
          const v = raw == null ? null : raw + vOff;
          if (v == null) {
            pen = false;
            return;
          }
          d += `${pen ? "L" : "M"} ${x(i)} ${yFn(v)} `;
          pen = true;
        });
        return { model: ms.model, color: modelColor(ms.model), d: d.trim() };
      })
      .filter((l) => l.d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    modelSeries,
    points,
    pph,
    isCloud,
    series,
    isPrecip,
    precipScaleMax,
    chartTab,
    activity,
  ]);

  // Alternativní předpovědi jako vrstvené percentilové pásy: v každou hodinu
  // seřadíme hodnoty všech modelů (+ hlavní čáru) a vykreslíme několik vnořených
  // obálek. Užší, hustě obsazené percentily se překrývají a jsou bělejší (modely
  // se shodují), zatímco ustřelený model roztáhne jen slabý vnější okraj.
  const spreadBands = useMemo(() => {
    if (!spreadEnabled || spreadSeries.length < 2 || !pph)
      return [] as { d: string; op: number }[];
    const perPoint: { i: number; sorted: number[] }[] = [];
    points.forEach((p, i) => {
      const vals: number[] = [];
      for (const ms of spreadSeries) {
        const v = ms.byTime.get(p.time);
        if (v != null && Number.isFinite(v)) vals.push(v);
      }
      const main = series.primary[i];
      if (Number.isFinite(main)) vals.push(main);
      if (vals.length < 2) return;
      vals.sort((a, b) => a - b);
      perPoint.push({ i, sorted: vals });
    });
    if (perPoint.length < 2) return [];
    const q = (s: number[], p: number) => {
      const idx = p * (s.length - 1);
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      return s[lo] + (s[hi] - s[lo]) * (idx - lo);
    };
    // Symetrické percentilové páry od plného rozpětí (0–100 %) k jádru (37,5–62,5 %).
    // Vrstvy se sčítají, takže střed vyjde výrazně bělejší než okraje.
    const LEVELS = [
      { lo: 0.0, hi: 1.0, op: 0.06 },
      { lo: 0.125, hi: 0.875, op: 0.07 },
      { lo: 0.25, hi: 0.75, op: 0.08 },
      { lo: 0.375, hi: 0.625, op: 0.09 },
    ];
    return LEVELS.map(({ lo, hi, op }) => {
      let d = "";
      perPoint.forEach((pt, k) => {
        d += `${k === 0 ? "M" : "L"} ${x(pt.i)} ${yCurve(q(pt.sorted, hi))} `;
      });
      for (let k = perPoint.length - 1; k >= 0; k--) {
        d += `L ${x(perPoint[k].i)} ${yCurve(q(perPoint[k].sorted, lo))} `;
      }
      return { d: `${d}Z`, op };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spreadEnabled, spreadSeries, points, pph, series]);

  // Rozptyl srážek jako jemný pás (obálka min–max napříč modely), podobně
  // nenápadný jako plocha nejistoty u teploty. Kde je pás úzký, modely se
  // shodují; kde se rozšíří, rozcházejí se (někdy déšť, jindy sucho).
  const precipSpreadArea = useMemo(() => {
    if (!isPrecip || !precipSpread || !pph) return null;
    let any = false;
    const bot: [number, number][] = [];
    let top = "";
    points.forEach((p, i) => {
      const r = precipSpread[i];
      const maxV = r ? r.max : p.precipitation;
      const minV = r ? Math.max(0, r.min) : p.precipitation;
      if (r && r.max - r.min >= 0.05) any = true;
      top += `${i === 0 ? "M" : "L"} ${x(i)} ${yPrecip(maxV)} `;
      bot.push([x(i), yPrecip(minV)]);
    });
    if (!any) return null;
    let d = top;
    for (let i = bot.length - 1; i >= 0; i--) d += `L ${bot[i][0]} ${bot[i][1]} `;
    return `${d}Z`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPrecip, precipSpread, points, pph, precipScaleMax]);

  const cloudBands = useMemo(() => {
    if (!isCloud || !pph) return [];
    const layers = [
      { values: points.map((p) => p.cloudHigh), color: "#e7edf8", label: "vysoká" },
      { values: points.map((p) => p.cloudMid), color: "#aeb9d2", label: "střední" },
      { values: points.map((p) => p.cloudLow), color: "#6f8ac9", label: "nízká" },
    ];
    const bandH = (layoutCurveBottom - curveTop) / 3;
    return layers.map((l, idx) => {
      const centerY = curveTop + bandH * (idx + 0.5);
      const half = bandH * 0.42;
      let d = "";
      l.values.forEach((v, i) => {
        d += `${i === 0 ? "M" : "L"} ${x(i)} ${centerY - (v / 100) * half} `;
      });
      for (let i = l.values.length - 1; i >= 0; i--) {
        d += `L ${x(i)} ${centerY + (l.values[i] / 100) * half} `;
      }
      d += "Z";
      return { d, color: l.color, label: l.label, centerY };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCloud, points, pph]);

  const tempLineStops = useMemo(() => {
    if (chartTab !== "temp" && chartTab !== "feels") return [];
    const n = 12;
    const out: { offset: number; color: string }[] = [];
    for (let k = 0; k <= n; k++) {
      const off = k / n;
      const t = series.max - off * (series.max - series.min);
      out.push({ offset: off, color: tempColor(t) });
    }
    return out;
  }, [chartTab, series.min, series.max, theme]);

  // UV: „tvrdý" vertikální gradient – čára mění barvu podle pásma (ne plynule).
  const uvLineStops = useMemo(() => {
    if (chartTab !== "uv") return [];
    const { min, max } = series;
    const span = Math.max(0.001, max - min);
    const offOf = (v: number) => (max - v) / span;
    const stops: { offset: number; color: string }[] = [
      { offset: 0, color: uvBandColor(max) },
    ];
    for (const b of [8, 6, 3]) {
      if (b > min && b < max) {
        const o = offOf(b);
        stops.push({ offset: o, color: uvBandColor(b + 0.001) });
        stops.push({ offset: o, color: uvBandColor(b - 0.001) });
      }
    }
    stops.push({ offset: 1, color: uvBandColor(min) });
    return stops;
  }, [chartTab, series.min, series.max]);

  // Vítr: barva čáry podle síly (stejné prahy jako WIND_BANDS).
  const windLineStops = useMemo(() => {
    if (chartTab !== "wind") return [];
    const { min, max } = series;
    const span = Math.max(0.001, max - min);
    const offOf = (v: number) => (max - v) / span;
    const stops: { offset: number; color: string }[] = [
      { offset: 0, color: windBandColor(max) },
    ];
    for (const b of [15, 10, 5]) {
      if (b > min && b < max) {
        const o = offOf(b);
        stops.push({ offset: o, color: windBandColor(b + 0.001) });
        stops.push({ offset: o, color: windBandColor(b - 0.001) });
      }
    }
    stops.push({ offset: 1, color: windBandColor(min) });
    return stops;
  }, [chartTab, series.min, series.max]);

  // Oblečení: „tvrdý" gradient – čára mění barvu na hranicích vrstev, takže
  // je z barvy poznat, co si vzít, i bez čtení popisků.
  const outfitLineStops = useMemo(() => {
    if (chartTab !== "outfit") return [];
    const { min, max } = series;
    const span = Math.max(0.001, max - min);
    const offOf = (v: number) => (max - v) / span;
    const levelAt = (t: number) => outfitAt(t, "walk").level;
    const stops: { offset: number; color: string }[] = [
      { offset: 0, color: outfitLevelColor(levelAt(max)) },
    ];
    for (const b of outfitLevelBounds()) {
      if (b.from > min && b.from < max) {
        const o = offOf(b.from);
        stops.push({ offset: o, color: outfitLevelColor(b.level - 1) });
        stops.push({ offset: o, color: outfitLevelColor(b.level) });
      }
    }
    stops.push({ offset: 1, color: outfitLevelColor(levelAt(min)) });
    return stops;
  }, [chartTab, series.min, series.max]);

  // Oblečení: vodorovné pásy jednotlivých vrstev + jejich hranice. `outfitAt`
  // pracuje s efektivní teplotou, což je přesně hodnota na ose tohoto grafu.
  const outfitZones = useMemo(() => {
    if (chartTab !== "outfit" || !pph) return [];
    const bounds = outfitLevelBounds();
    const { min, max } = series;
    const out: {
      level: number;
      color: string;
      boundary: number | null;
    }[] = [];
    bounds.forEach((b, i) => {
      const tMax = i === 0 ? Infinity : b.from;
      const tMin = i === bounds.length - 1 ? -Infinity : bounds[i + 1].from;
      const hiClip = Math.min(tMax, max);
      const loClip = Math.max(tMin, min);
      if (hiClip <= loClip) return;
      out.push({
        level: b.level,
        color: outfitLevelColor(b.level),
        boundary: tMin > min && tMin < max ? yCurve(tMin) : null,
      });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartTab, pph, series.min, series.max, layoutCurveBottom, layoutCurveTop]);

  // Oblečení: souvislé úseky se stejnou vrstvou – do pásu nad grafem dáme
  // jednu ikonku na úsek (ne po pevných hodinách), ať je vidět „od kdy do kdy".
  const outfitSegments = useMemo(() => {
    if (chartTab !== "outfit" || !points.length) return [];
    const segs: { startI: number; endI: number; pick: OutfitPick }[] = [];
    let gap = false;
    points.forEach((p, i) => {
      if (!Number.isFinite(p.apparentTemperature)) {
        gap = true;
        return;
      }
      const pick = outfitAt(p.apparentTemperature, activity);
      const last = segs[segs.length - 1];
      if (!gap && last && last.pick.level === pick.level) last.endI = i;
      else segs.push({ startI: i, endI: i, pick });
      gap = false;
    });
    return segs;
  }, [chartTab, points, activity]);

  // UV: vodorovné prahové čáry (odkud je záření nebezpečnější).
  const uvThresholds = useMemo(() => {
    if (chartTab !== "uv" || !pph) return [];
    return UV_BANDS.filter((b) => b.v > series.min && b.v < series.max).map(
      (b) => ({ ...b, y: yCurve(b.v) }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartTab, pph, series.min, series.max]);

  // Vítr: vodorovné prahové čáry (střední / silný / velmi silný vítr).
  const windThresholds = useMemo(() => {
    if (chartTab !== "wind" || !pph) return [];
    return WIND_BANDS.filter((b) => b.v > series.min && b.v < series.max).map(
      (b) => ({ ...b, y: yCurve(b.v) }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartTab, pph, series.min, series.max]);

  // Rosný bod: vodorovné prahové čáry (od kdy je dusno).
  const dewThresholds = useMemo(() => {
    if (chartTab !== "dewpoint" || !pph) return [];
    return DEW_BANDS.filter((b) => b.v > series.min && b.v < series.max).map(
      (b) => ({ ...b, y: yCurve(b.v) }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartTab, pph, series.min, series.max]);

  // Souvislé úseky s rizikem mlhy (teplota blízko rosného bodu) – ukazují se
  // v grafu vlhkosti a rosného bodu jako podbarvený pruh s ikonkou mlhy.
  const fogSegments = useMemo(() => {
    if (!(chartTab === "dewpoint" || chartTab === "humidity") || !pph) return [];
    const segs: { startI: number; endI: number }[] = [];
    let start = -1;
    points.forEach((p, i) => {
      // V grafu ukazujeme jen výraznější riziko (přísnější práh než u statu).
      const risk = fogRisk(p.temperature, p.dewPoint, 1);
      if (risk && start < 0) start = i;
      if (!risk && start >= 0) {
        segs.push({ startI: start, endI: i - 1 });
        start = -1;
      }
    });
    if (start >= 0) segs.push({ startI: start, endI: points.length - 1 });
    return segs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartTab, pph, points]);

  const labelValues = series.primary;
  const labelColor = chartTab === "feels" ? "feels" : "";
  // Minimální rozestup popisků v hodinách odvozený od skutečné šířky (px),
  // aby se na úzké obrazovce (malé pph) hodnoty nepřekrývaly.
  const minGapHours = pph > 0 ? Math.max(2, Math.ceil(40 / pph)) : 2;
  // Pravý okraj je rezervovaný pro popisky prahů („střední", „silný"…).
  const rightLegendPad =
    chartTab === "wind" || chartTab === "uv" || chartTab === "dewpoint"
      ? 118
      : 0;
  const valueLabelList = useMemo(() => {
    if (chartTab === "outfit") return [];
    const all = valueLabels(points, labelValues, minGapHours);
    if (!rightLegendPad || width <= 0 || points.length === 0) return all;
    const px = width / points.length;
    return all.filter((e) => (e.i + 0.5) * px < width - rightLegendPad);
  }, [points, labelValues, minGapHours, rightLegendPad, width]);
  // Popisky nárazů větru – stejný výběr extremů jako u rychlosti.
  const gustLabelList = useMemo(() => {
    if (chartTab !== "wind" || !series.secondary) return [];
    const all = valueLabels(points, series.secondary, minGapHours);
    if (!rightLegendPad || width <= 0 || points.length === 0) return all;
    const px = width / points.length;
    return all.filter((e) => (e.i + 0.5) * px < width - rightLegendPad);
  }, [chartTab, series.secondary, points, minGapHours, rightLegendPad, width]);

  // Rozsah z alternativních předpovědí (min–max napříč modely) v daném bodě –
  // pro popisek u teploty, např. „17° (15–20°)". Vrací null, když je pás vypnutý
  // nebo je rozptyl zanedbatelný.
  const spreadRangeAt = useMemo(() => {
    if (!spreadEnabled || spreadSeries.length < 2) return null;
    return (i: number): { min: number; max: number } | null => {
      const p = points[i];
      if (!p) return null;
      const vals: number[] = [];
      for (const ms of spreadSeries) {
        const v = ms.byTime.get(p.time);
        if (v != null && Number.isFinite(v)) vals.push(v);
      }
      const main = series.primary[i];
      if (Number.isFinite(main)) vals.push(main);
      if (vals.length < 2) return null;
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      if (max - min < 1) return null;
      return { min, max };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spreadEnabled, spreadSeries, points, series]);

  const pressing = useRef(false);
  // Aktivní dotyky (pointerId → poloha) pro rozpoznání pinch gesta nad grafem.
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef<{ startDist: number; startDays: number } | null>(null);
  // Na telefonu: nejdřív zjistíme směr gesta (x = scrub grafu, y = scroll stránky).
  const touchAxis = useRef<"pending" | "x" | "y" | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  // Aktuální počet dní pro nativní wheel listener (mimo React uzávěr).
  const daysRef = useRef(days);
  daysRef.current = days;

  // Krátká nápověda o úrovni detailu při zoomu (např. „3 dny").
  const [daysHint, setDaysHint] = useState<number | null>(null);
  const daysHintTimer = useRef<number | null>(null);
  const showDaysHint = (n: number) => {
    setDaysHint(n);
    if (daysHintTimer.current) window.clearTimeout(daysHintTimer.current);
    daysHintTimer.current = window.setTimeout(() => setDaysHint(null), 900);
  };
  const showDaysHintRef = useRef(showDaysHint);
  showDaysHintRef.current = showDaysHint;
  useEffect(
    () => () => {
      if (daysHintTimer.current) window.clearTimeout(daysHintTimer.current);
    },
    [],
  );

  // Když prst zvedneš mimo graf (u pinche skoro vždycky), pointerup/cancel na
  // element nedojde a `pointers` si ho drží dál. Další dotyk pak vypadá jako
  // druhý prst pokračujícího pinche – a gesto „přestane fungovat". Úklid proto
  // věsíme i na window, kam událost dorazí vždy.
  useEffect(() => {
    if (parts === "chrome" || parts === "legend" || parts === "frame" || parts === "strip" || parts === "daylines") return;
    const release = (e: PointerEvent) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.delete(e.pointerId);
      if (pointers.current.size < 2) {
        pinch.current = null;
        if (plotRef.current) plotRef.current.style.touchAction = "";
      }
      if (pointers.current.size === 0) {
        pressing.current = false;
        touchAxis.current = null;
        touchStart.current = null;
      }
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, [parts]);

  // Pinch na trackpadu (macOS) přichází jako wheel s ctrlKey. React onWheel je
  // pasivní (nejde preventDefault kvůli zoomu stránky), proto nativní listener.
  useEffect(() => {
    if (parts === "chrome" || parts === "legend" || parts === "frame" || parts === "strip" || parts === "daylines") return;
    const el = plotRef.current;
    if (!el) return;
    let accum = 0;
    const STEP = 18; // citlivost gesta
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // jen pinch / ctrl+kolečko, běžný scroll necháme
      e.preventDefault();
      accum += e.deltaY;
      let next = daysRef.current;
      if (accum <= -STEP) {
        accum = 0;
        next = Math.max(1, daysRef.current - 1); // roztažení = přiblížit
      } else if (accum >= STEP) {
        accum = 0;
        next = Math.min(7, daysRef.current + 1); // sevření = oddálit
      }
      if (next !== daysRef.current) {
        setDays(next);
        showDaysHintRef.current(next);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setDays, parts]);

  useEffect(
    () => () => {
      if (pointerRaf.current) cancelAnimationFrame(pointerRaf.current);
    },
    [],
  );

  function applyPointer(clientX: number) {
    const el = plotRef.current;
    if (!el || !pph || !points.length) return;
    const rect = el.getBoundingClientRect();
    const px = clientX - rect.left;
    const i = Math.max(0, Math.min(points.length - 1, Math.floor(px / pph)));
    if (i === cursorIdxRef.current) return;
    cursorIdxRef.current = i;
    setCursor(i);
  }

  function handlePointer(clientX: number) {
    pendingPointerX.current = clientX;
    if (pointerRaf.current) return;
    pointerRaf.current = requestAnimationFrame(() => {
      pointerRaf.current = 0;
      const px = pendingPointerX.current;
      if (px == null) return;
      applyPointer(px);
    });
  }

  if (!points.length) return null;

  // Kurzor může být po zmenšení okna (méně dní) mimo rozsah – ořízneme,
  // ať nesáhneme na points[cursor], které už neexistuje.
  const ci = Math.min(Math.max(0, cursor), points.length - 1);
  cursorIdxRef.current = ci;
  const active = points[ci];

  // Předej hodnoty modelů pro aktuální čas do rodiče (pro legendu v multi režimu).
  useEffect(() => {
    if (!onModelValues || !modelSeries.length || ci < 0) return;
    const vals = new Map<string, number>();
    for (const ms of modelSeries) {
      const v = ms.byTime.get(active.time);
      if (v != null) vals.set(ms.model, v);
    }
    onModelValues(vals);
  }, [onModelValues, modelSeries, ci, active.time]);

  // Statistika pro den pod kurzorem: denní průměr předpovědi vs. normál a rozdíl.
  const normalStats = useMemo(() => {
    if (!normalData) return null;
    const band =
      dayBands.find((b) => ci >= b.startI && ci <= b.endI) ?? dayBands[0];
    if (!band) return null;
    let sa = 0;
    let ca = 0;
    let sn = 0;
    let cn = 0;
    for (let i = band.startI; i <= band.endI; i++) {
      const a = points[i]?.temperature;
      if (a != null && Number.isFinite(a)) {
        sa += a;
        ca++;
      }
      const n = normalData.mean[i];
      if (n != null && Number.isFinite(n)) {
        sn += n;
        cn++;
      }
    }
    const actual = ca ? sa / ca : null;
    const normal = cn ? sn / cn : null;
    const diff = actual != null && normal != null ? actual - normal : null;
    return { actual, normal, diff };
  }, [normalData, dayBands, points, ci]);

  // Tendence tlaku za poslední ~3 h (pro trendovou šipku ve stats).
  const pressureDelta = active.pressure - points[Math.max(0, ci - 3)].pressure;

  const gradId = (name: string) => `${name}-${chartTab}`;
  // Hodnoty v legendě mají rezervovanou šířku, ať se lišta při přejíždění
  // grafem nerozskakuje (viz legendValCh).
  const legendValStyle: CSSProperties = {
    width: `${legendValCh(chartTab)}ch`,
  };

  const modelCompareLegendItems =
    compareLines.length > 0 ? (
      <>
        <span className="mg-legend-item" title={modelLabel(model)}>
          <span
            className="mg-legend-line"
            style={{ background: series.stroke }}
          />
          {modelShort(model)}
          <ModelLegendValue
            tab={chartTab}
            feels={
              chartTab === "outfit" ? active.apparentTemperature : undefined
            }
            value={
              chartTab === "outfit" ? undefined : series.primary[ci]
            }
            activity={activity}
            legendValStyle={legendValStyle}
          />
          {model === "best_match" && !multiMode && (
            <InfoHint
              text={tr(
                "„Automaticky“ volí nejlepší model dle lokality (v ČR ICON, pro vzdálenější dny ECMWF).",
              )}
            />
          )}
        </span>
        {compareLines.map((cl) => {
          const v = modelSeries
            .find((ms) => ms.model === cl.model)
            ?.byTime.get(active.time);
          return (
            <span className="mg-legend-item" key={`lg-${cl.model}`}>
              <span
                className="mg-legend-line dashed"
                style={{ background: cl.color }}
              />
              {modelShort(cl.model)}
              <ModelLegendValue
                tab={chartTab}
                feels={chartTab === "outfit" ? v : undefined}
                value={chartTab === "outfit" ? undefined : v}
                activity={activity}
                legendValStyle={legendValStyle}
              />
            </span>
          );
        })}
      </>
    ) : null;

  const chromeContent = (parts === "all" || parts === "chrome") && (
    <>
      <div className="mg-head">
        <div className="mg-head-title">
          <h2 className="card-title" style={{ margin: 0 }}>
            Meteogram
          </h2>
        </div>
        <div className="mg-dataview" ref={viewRef}>
          <button
            ref={viewBtnRef}
            type="button"
            className={`mg-view-btn ${viewOpen ? "active" : ""}`}
            onClick={() => setViewOpen((o) => !o)}
            aria-expanded={viewOpen}
            aria-label={tr("Nastavení meteogramu")}
            title={tr("Nastavení meteogramu")}
          >
            <GearGlyph />
          </button>
          {viewOpen &&
            menuPos &&
            createPortal(
              <div
                ref={viewMenuRef}
                className="mg-view-menu"
                role="menu"
                style={{
                  position: "fixed",
                  right: menuPos.right,
                  width: menuPos.width,
                  ...(menuPos.bottom != null
                    ? { bottom: menuPos.bottom }
                    : { top: menuPos.top ?? 0 }),
                  maxHeight: menuPos.maxH,
                }}
              >
              <div className="mg-view-menu-body">
              <div className="mg-view-days">
                <div className="mg-view-days-head">
                  <span>{tr("Počet dní")}</span>
                  <strong>
                    {days}{" "}
                    {getLang() === "en"
                      ? days === 1
                        ? "day"
                        : "days"
                      : days === 1
                        ? "den"
                        : days < 5
                          ? "dny"
                          : "dní"}
                  </strong>
                </div>
                <input
                  type="range"
                  min={1}
                  max={7}
                  step={1}
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                  aria-label={tr("Počet zobrazených dní")}
                  style={
                    { "--fill": `${((days - 1) / 6) * 100}%` } as CSSProperties
                  }
                />
              </div>
              <div className="mg-view-toggles">
              <label className="mg-view-toggle">
                <input
                  type="checkbox"
                  checked={nightShading}
                  onChange={(e) => setNightShading(e.target.checked)}
                />
                <span>{tr("Rozlišit den a noc")}</span>
              </label>
              <label className="mg-view-toggle">
                <input
                  type="checkbox"
                  checked={showTypeInfo}
                  onChange={(e) => setShowTypeInfo(e.target.checked)}
                />
                <span>{tr("Vysvětlivky u typů")}</span>
              </label>
              <label className="mg-view-toggle">
                <input
                  type="checkbox"
                  checked={multiCharts}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setOpenTabsStored((cur) => {
                        const valid = cur.filter((t) => ALL_TABS.includes(t));
                        return valid.length ? valid : [tab];
                      });
                      setMultiCharts(true);
                    } else {
                      setMultiCharts(false);
                    }
                  }}
                />
                <span>{tr("Více meteogramů současně")}</span>
              </label>
              {tab === "uv" && (
                <label className="mg-view-toggle">
                  <input
                    type="checkbox"
                    checked={showUvClearSky}
                    onChange={(e) => setShowUvClearSky(e.target.checked)}
                  />
                  <span>{tr("UV bez oblačnosti")}</span>
                </label>
              )}
              <label className="mg-view-toggle">
                <input
                  type="checkbox"
                  checked={showNormal}
                  onChange={(e) => setShowNormal(e.target.checked)}
                />
                <span>{tr("Historický normál (30 let)")}</span>
                {showNormal && normalLoading && (
                  <span
                    className="spinner mg-view-spinner"
                    role="status"
                    aria-label={tr("Načítám…")}
                  />
                )}
                <InfoHint
                  text={tr(
                    "Průměrná teplota pro daný den z let 1995–2024 (ERA5). Zobrazí se u grafu teploty.",
                  )}
                />
              </label>
              {(tab === "temp" || tab === "feels" || tab === "precip") && (
                <label className="mg-view-toggle">
                  <input
                    type="checkbox"
                    checked={showSpread}
                    onChange={(e) => setShowSpread(e.target.checked)}
                  />
                  <span>{tr("Alternativní předpovědi (modely)")}</span>
                  {spreadEnabled && spreadSeries.length === 0 && (
                    <span
                      className="spinner mg-view-spinner"
                      role="status"
                      aria-label={tr("Načítám…")}
                    />
                  )}
                  <InfoHint
                    text={
                      tab === "precip"
                        ? tr(
                            "Svislé úsečky ukazují rozpětí úhrnu srážek napříč modely v danou hodinu. Krátká = modely se shodují, dlouhá = rozcházejí se (někdy déšť, jindy sucho).",
                          )
                        : tr(
                            "Plocha ukazuje rozpětí světových modelů v danou hodinu. Úzká = shoda, široká = modely se rozcházejí a předpověď je méně jistá.",
                          )
                    }
                  />
                </label>
              )}
              </div>
              {(multiMode ? openTabs?.includes("outfit") : tab === "outfit") && (
                <div className="mg-view-activity">
                  <div className="mg-view-activity-head">
                    <span>{tr("Aktivita")}</span>
                    <div className="mg-view-activity-btns">
                      {(["sit", "walk", "run"] as Activity[]).map((a) => (
                        <button
                          key={a}
                          type="button"
                          className={`mg-view-act ${activity === a ? "active" : ""}`}
                          onClick={() => setActivity(a)}
                          aria-pressed={activity === a}
                        >
                          {tr(ACTIVITY_LABEL[a])}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="mg-view-hint">
                    {tr(
                      "V pohybu je člověku tepleji. Aktivita posune pocitovou teplotu, ze které se oblečení skládá (sdílí se s kartou „Co si vzít na sebe“).",
                    )}
                  </div>
                </div>
              )}
              {showNormal && normalError && (
                <div className="mg-view-hint mg-view-hint-error" role="alert">
                  {tr(
                    "Historický normál se nepodařilo načíst. Zkus to prosím znovu.",
                  )}
                </div>
              )}
              <div className="mg-view-section">
                <div className="mg-view-hint">
                  {multiMode || multiCharts
                    ? tr(
                        "Přetáhni pořadí. Klikni na dlaždici pro přidání nebo odebrání grafu.",
                      )
                    : tr(
                        "Přetáhni pořadí. Špendlík připne hodnotu nad graf.",
                      )}
                </div>
                <div className="mg-view-tab-grid">
                {tabOrder.map((t) => (
                <div
                  key={t}
                  ref={(el) => {
                    if (el) tabRowRefs.current.set(t, el);
                    else tabRowRefs.current.delete(t);
                  }}
                  className={`mg-view-row${multiMode || multiCharts ? " no-pin" : ""} ${dragTab === t ? "dragging" : ""} ${(multiMode || multiCharts ? effectiveOpenTabs.includes(t) : tab === t) ? "active" : ""}`}
                >
                  <button
                    type="button"
                    className="mg-view-handle"
                    onPointerDown={(e) => startTabDrag(e, t)}
                    aria-label={tr("Přetáhnout")}
                    title={tr("Přetáhnout")}
                  >
                    <GripGlyph />
                  </button>
                  <button
                    type="button"
                    className="mg-view-pick"
                    onClick={() => {
                      if (multiMode && onToggleTab) {
                        onToggleTab(t);
                      } else if (multiCharts) {
                        setOpenTabsStored((cur) => {
                          const base = cur.filter((x) => ALL_TABS.includes(x));
                          const open = base.length ? base : [tab];
                          if (open.includes(t)) {
                            if (open.length === 1) return open;
                            return open.filter((x) => x !== t);
                          }
                          return [...open, t];
                        });
                      } else {
                        setTab(t);
                        setViewOpen(false);
                      }
                    }}
                  >
                    <TabGlyph tab={t} />
                    <span>{tr(TAB_LABEL[t])}</span>
                  </button>
                  {!multiMode && !multiCharts && (
                    <button
                      type="button"
                      className={`mg-view-pin ${pinned[t] ? "on" : ""}`}
                      onClick={() => togglePin(t)}
                      aria-pressed={pinned[t]}
                      title={pinned[t] ? tr("Odepnout") : tr("Připnout nad graf")}
                    >
                      <PinGlyph filled={!!pinned[t]} />
                    </button>
                  )}
                </div>
              ))}
                </div>
              </div>

              <div className="mg-view-compare">
                <div className="mg-view-compare-head">
                  <span>{tr("Porovnat modely (multimód)")}</span>
                  {!isCloud && (
                    <span className="mg-view-compare-actions">
                      {!allCompared && (
                        <button
                          type="button"
                          className="mg-view-clear"
                          onClick={() => setCompareModels(compareIds)}
                        >
                          {tr("Vše")}
                        </button>
                      )}
                      {compareModels.length > 0 && (
                        <button
                          type="button"
                          className="mg-view-clear"
                          onClick={() => setCompareModels([])}
                        >
                          {tr("Zrušit")}
                        </button>
                      )}
                    </span>
                  )}
                </div>
                {isCloud ? (
                  <p className="mg-view-compare-note">
                    {tr("Porovnání modelů není u oblačnosti dostupné.")}
                  </p>
                ) : (
                  <div className="mg-view-compare-list">
                    {WEATHER_MODELS.filter((m) => m.id !== "best_match").map((m) => (
                      <label key={m.id} className="mg-view-model">
                        <input
                          type="checkbox"
                          checked={compareModels.includes(m.id)}
                          onChange={() => toggleCompare(m.id)}
                        />
                        <span>
                          {m.flag} {tr(m.label)}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              </div>
              </div>,
              document.body,
            )}
        </div>
      </div>

      {activeMissing && (
        <div className="mg-missing">
          {tr(
            "Pro {label} meteogram není k dispozici – hodinová data sahají jen několik dní dopředu.",
            { label: dayShortLabel(activeDate!) },
          )}
        </div>
      )}

      {active && !multiMode && (
        <StatReadout
          p={active}
          tab={tab}
          activity={activity}
          tabOrder={tabOrder}
          multiSelect={multiMode}
          activeTabs={openTabs}
          onTab={multiMode && onToggleTab ? onToggleTab : setTab}
          pressureDelta={pressureDelta}
          visible={(t) =>
            multiMode ? !!openTabs?.includes(t) : pinned[t] || tab === t
          }
          range={spreadRangeAt ? spreadRangeAt(ci) : null}
        />
      )}

      {showTypeInfo && (
        <p className="mg-typeinfo">{tr(TAB_INFO[tab])}</p>
      )}
    </>
  );

  const windStrip = needsPlotUi && showWindStrip ? (
    <div className="mg-icons mg-icons-below wind">
      {renderIconStripShades()}
      {pph > 0 &&
        points.map((p, i) => {
          const hr = locDate(p.time).getHours();
          if (hr % weatherIconStep !== 0) return null;
          if (!Number.isFinite(p.windDirection)) return null;
          const strength = Math.max(p.windSpeed || 0, p.windGusts || 0);
          return (
            <span
              key={p.time}
              className={`mg-icon mg-winddir${iconNightClass(p.isDay)}`}
              style={{
                left: x(i),
                color: windBandColor(strength),
              }}
              title={tr("vítr od {dir}", {
                dir: windDirLabel(p.windDirection),
              })}
            >
              <WindDirArrow deg={p.windDirection} />
            </span>
          );
        })}
    </div>
  ) : null;

  const showOutfitStrip =
    chartTab === "outfit" && (!multiMode || isCompactPlot);
  const iconStripBelow = showWindStrip || showOutfitStrip;
  const layoutShadeBottom = iconStripBelow
    ? layoutH
    : isCompactPlot
      ? layoutGridBottom
      : layoutH;
  const layoutShadeHeight = layoutShadeBottom - layoutShadeTop;
  const outfitStrip = needsPlotUi && showOutfitStrip ? (
    <div className="mg-icons mg-icons-below mg-icons-outfit">
      {renderIconStripShades()}
      {pph > 0 &&
        outfitSegments.map((seg) => {
          const left = seg.startI * pph;
          const right = (seg.endI + 1) * pph;
          const w = right - left;
          if (w < 24) return null;
          const { top, jacket } = seg.pick;
          const main = jacket.kind === "none" ? top.kind : jacket.kind;
          const color = outfitLevelColor(seg.pick.level);
          const midI = Math.floor((seg.startI + seg.endI) / 2);
          const segIsDay = points[midI]?.isDay ?? true;
          return (
            <span
              key={`ofs-${seg.startI}`}
              className={`mg-icon mg-outfit-icon${iconNightClass(segIsDay)}`}
              style={{ left: (left + right) / 2, color }}
              title={outfitLabel(top, jacket, tr)}
            >
              <ClothIcon kind={main} size={20} />
              <i style={{ background: color }} />
            </span>
          );
        })}
    </div>
  ) : null;

  const iconStrip =
    needsIconStrip && !hideIcons && !showWindStrip && !showOutfitStrip ? (
    <div className={`mg-icons${iconsZigzag ? " zigzag" : ""}`}>
      {renderIconStripShades()}
      {pph > 0 &&
        weatherIconSlots.map(({ i, slot, code, isDay }) => {
          const p = points[i];
          if (!p) return null;
          const weatherCode = code ?? p.weatherCode;
          const iconIsDay = isDay ?? p.isDay;
          return (
            <span
              key={p.time}
              className={`mg-icon${
                iconsZigzag ? (slot % 2 === 0 ? " row-a" : " row-b") : ""
              }${iconNightClass(iconIsDay)}`}
              style={{
                left: Math.max(10, Math.min(width - 10, x(i))),
              }}
            >
              {Number.isFinite(weatherCode) ? (
                <WeatherIcon
                  kind={describeWeather(weatherCode).icon}
                  isDay={iconIsDay}
                  size={20}
                />
              ) : (
                <span className="mg-icon-missing">?</span>
              )}
            </span>
          );
        })}
    </div>
  ) : null;

  const plotContent =
    parts !== "chrome" &&
    parts !== "head" &&
    parts !== "axis" &&
    parts !== "legend" &&
    parts !== "frame" &&
    parts !== "strip" &&
    parts !== "daylines" && (
    <>
      {!hideLegend &&
        !multiMode &&
        (compareLines.length > 0 || normalData) && (
        <div
          className={
            compareLines.length > 0 ? "mg-compare-legend-wrap" : undefined
          }
        >
          <div
            className={`mg-legend${compareLines.length > 0 ? " mg-compare-legend" : ""}`}
          >
          {compareLines.length === 0 && (
            <span className="mg-legend-item" title={modelLabel(model)}>
              <span
                className="mg-legend-line"
                style={{ background: series.stroke }}
              />
              {modelLabel(model)}
              <ModelLegendValue
                tab={chartTab}
                feels={
                  chartTab === "outfit" ? active.apparentTemperature : undefined
                }
                value={
                  chartTab === "outfit" ? undefined : series.primary[ci]
                }
                activity={activity}
                legendValStyle={legendValStyle}
              />
              {model === "best_match" && (
                <InfoHint
                  text={tr(
                    "„Automaticky“ volí nejlepší model dle lokality (v ČR ICON, pro vzdálenější dny ECMWF).",
                  )}
                />
              )}
            </span>
          )}
          {modelCompareLegendItems}
          {normalData && normalStats && (
            <>
              <span
                className="mg-legend-item"
                title={tr(
                  "Průměrná teplota pro daný den z let 1995–2024 (ERA5).",
                )}
              >
                <span
                  className="mg-legend-line dotted"
                  style={{ background: "#9aa7bd" }}
                />
                {tr("Průměr 1995–2024")}
                <strong className="mg-legend-val" style={legendValStyle}>
                  {normalStats.normal != null
                    ? formatLegendValue(chartTab, normalStats.normal)
                    : "–"}
                </strong>
              </span>
              <span
                className="mg-legend-item"
                title={tr("Průměr předpovědi pro tento den.")}
              >
                <span
                  className="mg-legend-line dotted"
                  style={{
                    background:
                      (normalStats.diff ?? 0) >= 0 ? "#ff8a5b" : "#63c7e0",
                  }}
                />
                {tr("Aktuální průměr")}
                <strong className="mg-legend-val" style={legendValStyle}>
                  {normalStats.actual != null
                    ? formatLegendValue(chartTab, normalStats.actual)
                    : "–"}
                </strong>
              </span>
              {normalStats.diff != null && (
                <span
                  className="mg-legend-item"
                  title={tr("Odchylka od historického normálu.")}
                >
                  {tr("Odchylka")}
                  <strong
                    className="mg-legend-val"
                    style={{
                      ...legendValStyle,
                      color: normalStats.diff >= 0 ? "#ff8a5b" : "#63c7e0",
                    }}
                  >
                    {normalStats.diff >= 0 ? "+" : ""}
                    {formatLegendValue(chartTab, normalStats.diff)}
                  </strong>
                </span>
              )}
            </>
          )}
          </div>
        </div>
      )}

      <div
        className="meteogram-plot"
        ref={plotRef}
        onPointerDown={(e) => {
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          // Druhý prst = pinch: zrušíme scrubování a zapamatujeme výchozí stav.
          if (pointers.current.size >= 2) {
            pressing.current = false;
            touchAxis.current = null;
            touchStart.current = null;
            const [a, b] = [...pointers.current.values()];
            pinch.current = { startDist: ptDist(a, b), startDays: days };
            // Oba prsty si zachytíme: při pinchi se běžně rozjedou mimo graf a
            // bez capture by nám další pointermove/up chodily jinému prvku.
            for (const id of pointers.current.keys()) {
              try {
                e.currentTarget.setPointerCapture(id);
              } catch {
                /* prst už mezitím pustil */
              }
            }
            // Pinch nesmí spustit svislý scroll stránky.
            e.currentTarget.style.touchAction = "none";
            return;
          }
          // Dotyk: nejdřív necháme prohlížeči šanci na svislý scroll (pan-y).
          // Capture a scrub až když je gesto jasně vodorovné.
          if (e.pointerType === "touch") {
            touchStart.current = { x: e.clientX, y: e.clientY };
            touchAxis.current = "pending";
            pressing.current = false;
            return;
          }
          pressing.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          handlePointer(e.clientX);
        }}
        onPointerMove={(e) => {
          if (pointers.current.has(e.pointerId)) {
            pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          }
          // Pinch nad grafem mění počet dní: roztažení = přiblížit (méně dní),
          // sevření = oddálit (více dní). Rozsah 1–7.
          if (pinch.current && pointers.current.size >= 2) {
            const [a, b] = [...pointers.current.values()];
            const d = ptDist(a, b);
            if (d > 0 && pinch.current.startDist > 0) {
              const raw =
                pinch.current.startDays * (pinch.current.startDist / d);
              const next = Math.max(1, Math.min(7, Math.round(raw)));
              if (next !== days) {
                setDays(next);
                showDaysHint(next);
              } else {
                showDaysHint(next); // ať se nápověda drží po celou dobu gesta
              }
            }
            return;
          }
          // Rozhodnutí osy u jednoho prstu (jen touch).
          if (
            e.pointerType === "touch" &&
            touchAxis.current === "pending" &&
            touchStart.current
          ) {
            const dx = e.clientX - touchStart.current.x;
            const dy = e.clientY - touchStart.current.y;
            if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
            if (Math.abs(dx) > Math.abs(dy) * 1.15) {
              touchAxis.current = "x";
              pressing.current = true;
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                /* ignore */
              }
              handlePointer(e.clientX);
            } else {
              touchAxis.current = "y";
              pressing.current = false;
            }
            return;
          }
          if (e.pointerType === "touch" && touchAxis.current === "y") return;
          // Myš scrubuje při přejezdu; dotyk/pero jen během tažení.
          if (e.pointerType === "mouse" || pressing.current) handlePointer(e.clientX);
        }}
        onPointerUp={(e) => {
          // Krátký tap na graf = výběr hodiny (bez tažení).
          if (
            e.pointerType === "touch" &&
            touchAxis.current === "pending" &&
            touchStart.current
          ) {
            const dx = e.clientX - touchStart.current.x;
            const dy = e.clientY - touchStart.current.y;
            if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
              handlePointer(e.clientX);
            }
          }
          pointers.current.delete(e.pointerId);
          if (pointers.current.size < 2) {
            pinch.current = null;
            e.currentTarget.style.touchAction = "";
          }
          pressing.current = false;
          touchAxis.current = null;
          touchStart.current = null;
        }}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId);
          if (pointers.current.size < 2) {
            pinch.current = null;
            e.currentTarget.style.touchAction = "";
          }
          pressing.current = false;
          touchAxis.current = null;
          touchStart.current = null;
        }}
      >
        {daysHint != null && (
          <div className="mg-zoomhint" aria-hidden="true">
            {daysLabel(daysHint)}
          </div>
        )}
        {isCompactPlot && (
          <div className="mg-plot-tag" aria-hidden="true">
            {tr(TAB_LABEL[chartTab])}
          </div>
        )}
        {!multiMode && renderActiveDayOverlay("full")}
        {iconStrip}
        {!multiMode && windStrip}
        {!multiMode && outfitStrip}
        {renderStormOverlays()}
        {!multiMode && renderDayBoundaries()}

        <div className="mg-plot-chart">
        <svg width={width || 1} height={layoutH} className="mg-svg">
          <defs>
            <linearGradient id={gradId("grad-primary")} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={series.fill} stopOpacity="0.55" />
              <stop offset="100%" stopColor={series.fill} stopOpacity="0.04" />
            </linearGradient>
            {(chartTab === "temp" || chartTab === "feels") && (
              <linearGradient
                id={gradId("grad-templine")}
                gradientUnits="userSpaceOnUse"
                x1="0"
                y1={curveTop}
                x2="0"
                y2={layoutCurveBottom}
              >
                {tempLineStops.map((s, i) => (
                  <stop
                    key={i}
                    offset={`${(s.offset * 100).toFixed(1)}%`}
                    stopColor={s.color}
                  />
                ))}
              </linearGradient>
            )}
            {chartTab === "uv" && (
              <linearGradient
                id={gradId("grad-uvline")}
                gradientUnits="userSpaceOnUse"
                x1="0"
                y1={curveTop}
                x2="0"
                y2={layoutCurveBottom}
              >
                {uvLineStops.map((s, i) => (
                  <stop
                    key={i}
                    offset={`${(s.offset * 100).toFixed(1)}%`}
                    stopColor={s.color}
                  />
                ))}
              </linearGradient>
            )}
            {chartTab === "outfit" && (
              <linearGradient
                id={gradId("grad-outfitline")}
                gradientUnits="userSpaceOnUse"
                x1="0"
                y1={curveTop}
                x2="0"
                y2={layoutCurveBottom}
              >
                {outfitLineStops.map((s, i) => (
                  <stop
                    key={i}
                    offset={`${(s.offset * 100).toFixed(1)}%`}
                    stopColor={s.color}
                  />
                ))}
              </linearGradient>
            )}
            {chartTab === "wind" && (
              <linearGradient
                id={gradId("grad-windline")}
                gradientUnits="userSpaceOnUse"
                x1="0"
                y1={curveTop}
                x2="0"
                y2={layoutCurveBottom}
              >
                {windLineStops.map((s, i) => (
                  <stop
                    key={i}
                    offset={`${(s.offset * 100).toFixed(1)}%`}
                    stopColor={s.color}
                  />
                ))}
              </linearGradient>
            )}
          </defs>

          {/* denní/noční pruhy – u pásů ikon pod grafem táhneme až na spodek SVG,
              aby pozadí navazovalo bez mezery nad šipkami větru / oblečením. */}
          {pph > 0 &&
            nightShading &&
            dayShades.map((s) => (
              <rect
                key={s.id}
                x={s.left}
                y={layoutShadeTop}
                width={Math.max(0, s.right - s.left)}
                height={layoutShadeHeight}
                fill={
                  theme === "light"
                    ? "rgba(255,255,255,0.42)"
                    : "rgba(255,255,255,0.035)"
                }
              />
            ))}
          {pph > 0 &&
            nightShading &&
            nightShades.map((s) => (
              <rect
                key={s.id}
                x={s.left}
                y={layoutShadeTop}
                width={Math.max(0, s.right - s.left)}
                height={layoutShadeHeight}
                fill={theme === "light" ? "rgba(30,45,80,0.08)" : "rgba(0,0,8,0.26)"}
              />
            ))}

          {/* denní pruhy + oddělovače – popisky jen mimo kompaktní multi grafy */}
          {!isCompactPlot &&
            pph > 0 &&
            dayBands.map((b, bi) => {
              const left = b.startI * pph;
              const right = (b.endI + 1) * pph;
              const isPast = b.dateStr < todayStr;
              const fill = isPast
                ? theme === "light"
                  ? "rgba(20,30,55,0.07)"
                  : "rgba(0,0,0,0.22)"
                : "transparent";
              const bandTop = layoutTopPad - 10;
              const bandBottom = layoutH;
              return (
                <g key={`band-${bi}`}>
                  <rect
                    x={left}
                    y={bandTop}
                    width={right - left}
                    height={bandBottom - bandTop}
                    fill={fill}
                  />
                </g>
              );
            })}

          {/* srážkové sloupce – malý pruh nahoře, „visí" od horního okraje
              křivkové plochy dolů (u ostatních veličin než srážky) */}
          {pph > 0 &&
            !isPrecip &&
            precipBars.map((b) => {
              const top = layoutTopPad;
              const scale = Math.max(2, precipMax);
              const norm = Math.min(1, Math.pow(b.value / scale, 0.6));
              const hb = Math.max(4, norm * (layoutMiniH - 16));
              const left = x(b.startI) - pph * 0.42;
              const right = x(b.endI) + pph * 0.42;
              // Krytí podle pravděpodobnosti: méně jisté srážky jsou světlejší.
              const opacity = 0.18 + 0.82 * (Math.max(0, b.prob) / 100);
              return (
                <rect
                  key={`p-${b.startI}`}
                  x={left}
                  y={top}
                  width={right - left}
                  height={hb}
                  rx="2"
                  fill="#1f7bff"
                  opacity={opacity}
                />
              );
            })}

          {/* hodnoty u malého pruhu – hlavně u pravděpodobnějších srážek */}
          {pph > 0 &&
            !isPrecip &&
            (() => {
              const top = layoutTopPad;
              const scale = Math.max(2, precipMax);
              let lastX = -Infinity;
              const out: { cx: number; y: number; v: number; prob: number }[] =
                [];
              for (const b of precipBars) {
                if (!precipLabelSet.has(b.startI)) continue;
                const cx = (x(b.startI) + x(b.endI)) / 2;
                if (cx - lastX < 28) continue;
                lastX = cx;
                const norm = Math.min(1, Math.pow(b.value / scale, 0.6));
                const hb = Math.max(4, norm * (layoutMiniH - 16));
                out.push({ cx, y: top + hb + 11, v: b.value, prob: b.prob });
              }
              return out.map((l, i) => (
                <text
                  key={`psl-${i}`}
                  x={l.cx}
                  y={l.y}
                  className="mg-precip-mini-val"
                  textAnchor="middle"
                  opacity={0.45 + 0.55 * (Math.max(0, l.prob) / 100)}
                >
                  {fmtPrecip(l.v)}
                </text>
              ));
            })()}

          {isCompactPlot &&
            pph > 0 &&
            dayBands.map((b, bi) => {
              const left = b.startI * pph;
              const right = (b.endI + 1) * pph;
              const isPast = b.dateStr < todayStr;
              const fill = isPast
                ? theme === "light"
                  ? "rgba(20,30,55,0.07)"
                  : "rgba(0,0,0,0.22)"
                : "transparent";
              const bandTop = 0;
              const bandBottom = layoutGridBottom;
              return (
                <g key={`band-bg-${bi}`}>
                  <rect
                    x={left}
                    y={bandTop}
                    width={right - left}
                    height={bandBottom - bandTop}
                    fill={fill}
                  />
                </g>
              );
            })}

          {isCloud ? (
            <>
              {cloudBands.map((b, i) => (
                <g key={`cloud-${i}`}>
                  <line
                    x1={0}
                    y1={b.centerY}
                    x2={width}
                    y2={b.centerY}
                    stroke="rgba(255,255,255,0.08)"
                    strokeWidth="1"
                  />
                  <path d={b.d} fill={b.color} opacity="0.92" />
                </g>
              ))}
              {/* Popisky pásem (nízká/střední/vysoká) u pravého okraje – stejně
                  jako prahy u ostatních veličin. Oblačnost nekreslí extrémy, takže
                  se tu nemají s čím potkat. */}
              {cloudBands.map((b, i) => (
                <text
                  key={`cl-${i}`}
                  x={width - 6}
                  y={b.centerY - (layoutCurveBottom - layoutTopPad) / 6 + 4}
                  className="mg-bandlabel"
                  textAnchor="end"
                >
                  {tr(b.label)}
                </text>
              ))}
            </>
          ) : isPrecip ? (
            pph > 0 && (
              <>
                {precipThresholds.map((t) => (
                  <g key={`pth-${t.v}`}>
                    <line
                      x1={0}
                      y1={t.y}
                      x2={width}
                      y2={t.y}
                      stroke={t.color}
                      className="mg-threshold-line"
                    />
                    <text
                      x={width - 6}
                      y={t.y - 4}
                      className="mg-uv-thlabel mg-threshold-label"
                      textAnchor="end"
                      fill={t.color}
                    >
                      {tr(t.label)} ({t.v}+ mm)
                    </text>
                  </g>
                ))}
                {/* rozptyl modelů: jemný pás min–max úhrnu pod sloupci
                    (nenápadný, jako plocha nejistoty u teploty). Úzký = shoda,
                    široký = modely se rozcházejí. */}
                {precipSpreadArea && (
                  <path d={precipSpreadArea} className="mg-precip-spread" />
                )}
                {/* porovnání modelů: hodinové čáry úhrnu (jako u teploty).
                    Kreslíme je pod sloupce, ať hlavní modré sloupce zůstanou navrchu. */}
                {compareLines.map((cl) => (
                  <path
                    key={`cmp-p-${cl.model}`}
                    d={cl.d}
                    fill="none"
                    stroke={cl.color}
                    strokeWidth="1.6"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    strokeDasharray="4 3"
                    opacity="0.85"
                  />
                ))}
                {/* velké srážkové sloupce – od spodku grafu */}
                {precipBars.map((b) => {
                  const top = yPrecip(b.value);
                  const hb = Math.max(2, PRECIP_BASELINE - top);
                  const left = x(b.startI) - pph * 0.42;
                  const right = x(b.endI) + pph * 0.42;
                  // Krytí podle pravděpodobnosti: méně jisté srážky jsou světlejší.
                  const opacity = 0.3 + 0.7 * (Math.max(0, b.prob) / 100);
                  return (
                    <rect
                      key={`pb-${b.startI}`}
                      x={left}
                      y={top}
                      width={right - left}
                      height={hb}
                      rx="2"
                      fill="#1f7bff"
                      opacity={opacity}
                    />
                  );
                })}
                {/* hodnoty nad sloupci – v mg-svg-labels nad kurzorem */}
              </>
            )
          ) : (
            pph > 0 && (
              <>
                {spreadBands.map((b, i) => (
                  <path
                    key={`sp-${i}`}
                    d={b.d}
                    className="mg-spread"
                    fillOpacity={b.op}
                  />
                ))}
                {fogSegments.map((s, i) => {
                  const left = x(s.startI) - pph * 0.5;
                  const right = x(s.endI) + pph * 0.5;
                  const cx = (left + right) / 2;
                  return (
                    <g key={`fog-${i}`}>
                      <rect
                        x={left}
                        y={curveTop}
                        width={Math.max(0, right - left)}
                        height={layoutCurveBottom - curveTop}
                        fill="rgba(174,188,207,0.16)"
                      />
                      <g
                        transform={`translate(${cx} ${layoutCurveBottom - 20})`}
                        opacity="0.9"
                      >
                        <path
                          d="M-7 -3h14M-7 0h14M-7 3h11"
                          stroke="#c3d0e0"
                          strokeWidth="1.7"
                          strokeLinecap="round"
                        />
                        <text
                          y="15"
                          className="mg-uv-thlabel"
                          textAnchor="middle"
                          fill="#c3d0e0"
                        >
                          {tr("mlha")}
                        </text>
                      </g>
                    </g>
                  );
                })}
                {chartTab === "outfit" &&
                  outfitZones.map((z) =>
                    z.boundary != null ? (
                      <line
                        key={`ozone-${z.level}`}
                        x1={0}
                        y1={z.boundary}
                        x2={width}
                        y2={z.boundary}
                        stroke={z.color}
                        className="mg-threshold-line"
                      />
                    ) : null,
                  )}
                {uvThresholds.map((t) => (
                  <g key={`uvth-${t.v}`}>
                    <line
                      x1={0}
                      y1={t.y}
                      x2={width}
                      y2={t.y}
                      stroke={t.color}
                      className="mg-threshold-line"
                    />
                    <text
                      x={width - 6}
                      y={t.y - 4}
                      className="mg-uv-thlabel mg-threshold-label"
                      textAnchor="end"
                      fill={t.color}
                    >
                      {tr(t.label)} ({t.v}+)
                    </text>
                  </g>
                ))}
                {windThresholds.map((t) => (
                  <g key={`windth-${t.v}`}>
                    <line
                      x1={0}
                      y1={t.y}
                      x2={width}
                      y2={t.y}
                      stroke={t.color}
                      className="mg-threshold-line"
                    />
                    <text
                      x={width - 6}
                      y={t.y - 4}
                      className="mg-uv-thlabel mg-threshold-label"
                      textAnchor="end"
                      fill={t.color}
                    >
                      {tr(t.label)} ({t.v}+ m/s)
                    </text>
                  </g>
                ))}
                {dewThresholds.map((t) => (
                  <g key={`dewth-${t.v}`}>
                    <line
                      x1={0}
                      y1={t.y}
                      x2={width}
                      y2={t.y}
                      stroke={t.color}
                      className="mg-threshold-line"
                    />
                    <text
                      x={width - 6}
                      y={t.y - 4}
                      className="mg-uv-thlabel mg-threshold-label"
                      textAnchor="end"
                      fill={t.color}
                    >
                      {tr(t.label)} ({t.v}+°)
                    </text>
                  </g>
                ))}
                {normalBandPath && (
                  <path
                    d={normalBandPath}
                    fill="rgba(150,165,190,0.14)"
                    stroke="none"
                  />
                )}
                {anomalyDays?.map((s, i) => (
                  <g key={`anom-${i}`}>
                    <rect
                      x={s.x0}
                      y={Math.min(s.yActual, s.yNormal)}
                      width={Math.max(0, s.x1 - s.x0)}
                      height={Math.abs(s.yActual - s.yNormal)}
                      fill={s.fill}
                    />
                    {/* denní normál (obvyklý průměr) */}
                    <line
                      x1={s.x0}
                      y1={s.yNormal}
                      x2={s.x1}
                      y2={s.yNormal}
                      stroke="#9aa7bd"
                      strokeWidth="1.6"
                      strokeDasharray="1.5 4"
                      strokeLinecap="round"
                    />
                    {/* denní průměr předpovědi */}
                    <line
                      x1={s.x0}
                      y1={s.yActual}
                      x2={s.x1}
                      y2={s.yActual}
                      stroke={s.line}
                      strokeWidth="2"
                      strokeDasharray="2 2"
                      strokeLinecap="round"
                    />
                  </g>
                ))}
                {compareLines.map((cl) => (
                  <path
                    key={`cmp-${cl.model}`}
                    d={cl.d}
                    fill="none"
                    stroke={cl.color}
                    strokeWidth="1.6"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    strokeDasharray="4 3"
                    opacity="0.85"
                  />
                ))}
                {secondaryPath && (
                  <path
                    d={secondaryPath}
                    fill="none"
                    stroke={
                      chartTab === "wind"
                        ? `url(#${gradId("grad-windline")})`
                        : series.secondaryColor
                    }
                    strokeWidth="2.4"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    strokeDasharray="1.5 4"
                    opacity="0.95"
                  />
                )}
                {showUvClearSky && series.refLine && refLinePath && (
                  <>
                    <path
                      d={refLinePath}
                      fill="none"
                      stroke={series.refLine.color}
                      strokeWidth="1.8"
                      strokeDasharray="1.5 4"
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      opacity="0.85"
                    />
                    <text
                      x={x(0) + 4}
                      y={Math.max(
                        curveTop + 10,
                        yCurve(series.refLine.values[0]) - 6,
                      )}
                      className="mg-uv-thlabel"
                      fill={series.refLine.color}
                    >
                      {tr(series.refLine.label)}
                    </text>
                  </>
                )}
                {/* obrys (halo) pod hlavní čárou – kontrast vůči ploše
                    alternativních předpovědí. V light režimu je plocha tmavá,
                    proto je obrys světlý. */}
                <path
                  d={linePath}
                  fill="none"
                  stroke={
                    theme === "light"
                      ? "rgba(238,242,248,0.9)"
                      : "rgba(11,18,32,0.85)"
                  }
                  strokeWidth="6"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <path
                  d={linePath}
                  fill="none"
                  stroke={
                    chartTab === "temp" || chartTab === "feels"
                      ? `url(#${gradId("grad-templine")})`
                      : chartTab === "uv"
                        ? `url(#${gradId("grad-uvline")})`
                        : chartTab === "wind"
                          ? `url(#${gradId("grad-windline")})`
                          : chartTab === "outfit"
                            ? `url(#${gradId("grad-outfitline")})`
                            : series.stroke
                  }
                  strokeWidth="4"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {extraPaths.map((ex, i) => (
                  <path
                    key={`extra-${i}`}
                    d={ex.d}
                    fill="none"
                    stroke={ex.color}
                    strokeWidth="2.3"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    opacity="0.95"
                  />
                ))}
              </>
            )
          )}

          {/* Rám a popisek vybraného dne – při zapnuté ploše alternativní
              předpovědi ho kreslíme až tady (nad plochou), aby ji zvýraznění
              nikdy nepřekryla. */}
          {renderPlotHairsSvg()}
          {renderDayLabelsOverlay()}

        </svg>
        {renderPlotValueLabels()}
        {!multiMode && renderCursorTip()}
        </div>
        {/* Šipky směru větru / ikonky oblečení – v multi režimu pod grafem. */}
        {multiMode && windStrip}
        {multiMode && outfitStrip}
      </div>
    </>
  );

  if (parts === "legend") {
    if (!multiMode || !openTabs?.length) return null;
    return (
      <>
        <StatReadout
          p={active}
          tab={onFocusTab != null ? (focusTab ?? null) : (focusTab ?? tab)}
          activity={activity}
          tabOrder={tabOrder}
          activeTabs={openTabs}
          onTab={onFocusTab ?? setTab}
          pressureDelta={pressureDelta}
          visible={(t) => openTabs.includes(t)}
          range={null}
          shrinkMode
          readOnly={!onFocusTab}
        />
        {compareModels.length > 0 && (
          <div className="mg-compare-legend-wrap">
            <div className="mg-legend mg-compare-legend">
              {compareModels
                .filter((m) => m !== "best_match")
                .map((m) => {
                  const v = modelValues?.get(m);
                  const legendTab = focusTab ?? openTabs?.[0] ?? "temp";
                  return (
                    <span className="mg-legend-item" key={`cmp-${m}`}>
                      <span
                        className="mg-legend-line dashed"
                        style={{ background: modelColor(m) }}
                      />
                      {modelShort(m)}
                      <ModelLegendValue
                        tab={legendTab}
                        feels={legendTab === "outfit" ? v : undefined}
                        value={legendTab === "outfit" ? undefined : v}
                        activity={activity}
                        legendValStyle={{
                          width: `${legendValCh(legendTab)}ch`,
                        }}
                      />
                    </span>
                  );
                })}
            </div>
          </div>
        )}
      </>
    );
  }

  if (parts === "head") {
    if (!points.length || !iconStrip) return null;
    return (
      <div className="mg-plot-head">
        {iconStrip}
        {renderStormOverlays()}
        {renderPlotHairs()}
      </div>
    );
  }

  if (parts === "strip") {
    if (!multiMode || !points.length) return null;
    return renderActiveDayOverlay("chrome");
  }

  if (parts === "frame") {
    if (!multiMode || !points.length) return null;
    return renderActiveDayOverlay("stack");
  }

  if (parts === "daylines") {
    if (!multiMode || !points.length || !pph) return null;
    return renderDayBoundaries();
  }

  if (parts === "axis") {
    if (!points.length || !pph) return null;
    // Názvy dnů u spodku osy; „Teď" a kurzor o řádek výš, ať nepřekrývají Dnes/Zítra.
    const dayY = AXIS_DAY_Y;
    const nowY = AXIS_NOW_Y;
    // Značka „Teď" má vlastní řádek, tooltip kurzoru sedí vlevo nahoře nad čárou.
    const nowPillX =
      nowX >= 0 ? Math.max(17, Math.min(width - 17, nowX)) : null;
    return (
      <div className="mg-plot-axis">
        <svg
          width={width || 1}
          height={AXIS_H}
          overflow="visible"
          className="mg-svg mg-svg-axis"
        >
          {renderPlotHairsSvg(AXIS_H)}
          {dayBands.map((b, bi) => {
            const left = b.startI * pph;
            const right = (b.endI + 1) * pph;
            const isToday = b.dateStr === todayStr;
            const isActive = b.dateStr === activeKey;
            const label = dayLabelFor(b, right - left);
            const cx = (left + right) / 2;
            return (
              <g key={`ax-${bi}`}>
                {renderDayPillLabel(
                  cx,
                  dayY,
                  label,
                  isToday,
                  isActive,
                  isActive ? left : undefined,
                  isActive ? right : undefined,
                )}
              </g>
            );
          })}
          {nowX >= 0 && (
            <>
              {nowPillX != null && Math.abs(nowX - x(ci)) > 44 && (
                <g transform={`translate(${nowPillX}, ${nowY})`}>
                  <rect
                    x={-16}
                    y={0}
                    width={32}
                    height={14}
                    rx="7"
                    fill={theme === "light" ? "#b9750a" : "rgba(255,209,102,0.92)"}
                  />
                  <text
                    x={0}
                    y={7}
                    className="mg-nowlabel"
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill={theme === "light" ? "#fff" : undefined}
                  >
                    {tr("Teď")}
                  </text>
                </g>
              )}
            </>
          )}
        </svg>
        {renderCursorTip()}
      </div>
    );
  }

  if (parts === "plot") {
    const isFocused =
      multiMode && focusTab != null && focusTab === chartTab;
    return (
      <div
        className={`mg-plot-stack-item${isFocused ? " focused" : ""}`}
        data-mg-chart={chartTab}
        aria-label={multiMode ? tr(TAB_LABEL[chartTab]) : undefined}
      >
        {!multiMode && (
          <h3 className="mg-plot-label">{tr(TAB_LABEL[chartTab])}</h3>
        )}
        {plotContent}
      </div>
    );
  }

  if (parts === "chrome") {
    return chromeContent;
  }

  return (
    <section className="card meteogram-card">
      {chromeContent}
      {plotContent}
    </section>
  );
}

function MeteogramMulti(props: Props) {
  const [tab, setTab] = useStoredState<Tab>("zmoknu.mgTab", "temp");
  const [openTabsRaw, setOpenTabs] = useStoredState<Tab[]>(
    "zmoknu.mgOpenTabs",
    ["temp"],
  );
  const [tabOrderRaw] = useStoredState<Tab[]>("zmoknu.mgTabOrder", ALL_TABS);
  const tabOrder = useMemo(
    () => normalizeTabOrder(tabOrderRaw),
    [tabOrderRaw],
  );
  const openTabs = useMemo(() => {
    const valid = openTabsRaw.filter((t) => ALL_TABS.includes(t));
    const list = valid.length ? valid : [tab];
    return [...list].sort(
      (a, b) => tabOrder.indexOf(a) - tabOrder.indexOf(b),
    );
  }, [openTabsRaw, tab, tabOrder]);
  const [highlightTab, setHighlightTab] = useState<Tab | null>(null);
  const [cursor, setCursor] = useState(0);
  const deferredCursor = useDeferredValue(cursor);
  const [modelValues, setModelValues] = useState<Map<string, number>>(
    () => new Map(),
  );
  const stackRef = useRef<HTMLDivElement>(null);
  const stickySentinelRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const [plotWidth, setPlotWidth] = useState(0);
  const shrinkRaf = useRef(0);
  const shrinkVal = useRef(-1);

  useEffect(() => {
    const SHRINK_RANGE = 72;

    const update = () => {
      shrinkRaf.current = 0;
      const sentinel = stickySentinelRef.current;
      const legend = legendRef.current;
      if (!sentinel || !legend) return;

      const stickyTop =
        parseFloat(
          getComputedStyle(
            document.querySelector(".app") ?? document.documentElement,
          ).getPropertyValue("--header-h"),
        ) || 0;

      const anchor = sentinel.getBoundingClientRect().bottom - stickyTop;
      const next = Math.min(1, Math.max(0, 1 - anchor / SHRINK_RANGE));
      if (Math.abs(next - shrinkVal.current) < 0.004) return;
      shrinkVal.current = next;
      legend.style.setProperty("--stats-shrink", String(next));
    };

    const schedule = () => {
      if (!shrinkRaf.current) {
        shrinkRaf.current = requestAnimationFrame(update);
      }
    };

    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (shrinkRaf.current) cancelAnimationFrame(shrinkRaf.current);
    };
  }, []);

  useEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setPlotWidth(e.contentRect.width);
    });
    ro.observe(el);
    setPlotWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [openTabs.length]);

  const toggleTab = (t: Tab) => {
    setTab(t);
    const base = openTabs.filter((x: Tab) => ALL_TABS.includes(x));
    const cur = base.length ? base : [tab];
    if (cur.includes(t)) {
      if (cur.length === 1) return;
      setOpenTabs(cur.filter((x: Tab) => x !== t));
    } else {
      setOpenTabs([...cur, t]);
    }
  };

  const focusChart = (t: Tab) => {
    if (!openTabs.includes(t)) return;
    if (highlightTab === t) {
      setHighlightTab(null);
      return;
    }
    setHighlightTab(t);
    setTab(t);
    requestAnimationFrame(() => {
      const root = stackRef.current;
      const target = root?.querySelector(
        `[data-mg-chart="${t}"]`,
      ) as HTMLElement | null;
      const sticky = root?.querySelector(
        ".mg-plots-sticky",
      ) as HTMLElement | null;
      if (!target || !sticky) return;

      const stickyBottom = sticky.getBoundingClientRect().bottom;
      const targetTop = target.getBoundingClientRect().top;
      const gap = 6;
      const delta = targetTop - stickyBottom - gap;
      if (Math.abs(delta) > 2) {
        window.scrollBy({ top: delta, behavior: "smooth" });
      }
    });
  };

  return (
    <section className="card meteogram-card meteogram-card-multi">
      <MeteogramBody
        {...props}
        parts="chrome"
        multiMode
        openTabs={openTabs}
        onToggleTab={toggleTab}
        focusTab={highlightTab}
        onFocusTab={focusChart}
        cursor={cursor}
        onCursorChange={setCursor}
      />
      <div ref={stackRef} className="mg-plots-wrap">
        <div ref={stickySentinelRef} className="mg-sticky-sentinel" aria-hidden="true" />
        <div className="mg-plots-sticky">
          <div ref={legendRef} className="mg-sticky-legend">
            <MeteogramBody
              {...props}
              parts="legend"
              multiMode
              openTabs={openTabs}
              focusTab={highlightTab}
              onFocusTab={focusChart}
              cursor={cursor}
              onCursorChange={setCursor}
              modelValues={modelValues}
            />
          </div>
          {plotWidth > 0 && (
            <div className="mg-plot-chrome">
              <MeteogramBody
                {...props}
                parts="strip"
                multiMode
                plotWidth={plotWidth}
                cursor={cursor}
                onCursorChange={setCursor}
              />
              <MeteogramBody
                {...props}
                parts="axis"
                multiMode
                plotWidth={plotWidth}
                cursor={cursor}
                onCursorChange={setCursor}
              />
              <MeteogramBody
                {...props}
                parts="head"
                multiMode
                plotWidth={plotWidth}
                cursor={cursor}
                onCursorChange={setCursor}
              />
            </div>
          )}
        </div>
        {plotWidth > 0 && (
          <div className="mg-plots-graphs">
            <MeteogramBody
              {...props}
              parts="frame"
              multiMode
              plotWidth={plotWidth}
              cursor={cursor}
              onCursorChange={setCursor}
            />
            <div className="mg-plots-stack">
              {openTabs.map((t, i) => (
                <MeteogramBody
                  key={t}
                  {...props}
                  parts="plot"
                  multiMode
                  fixedTab={t}
                  focusTab={highlightTab}
                  hideLegend
                  hideIcons
                  cursor={deferredCursor}
                  onCursorChange={setCursor}
                  plotWidth={plotWidth}
                  onModelValues={i === 0 ? setModelValues : undefined}
                />
              ))}
            </div>
          </div>
        )}
        {plotWidth > 0 && (
          <MeteogramBody
            {...props}
            parts="daylines"
            multiMode
            plotWidth={plotWidth}
            cursor={cursor}
            onCursorChange={setCursor}
          />
        )}
      </div>
    </section>
  );
}

export default function Meteogram(props: Props) {
  const [multiCharts] = useStoredState("zmoknu.mgMultiCharts", false);
  const [days] = useStoredState("zmoknu.mgDays", 2);
  const todayStr = isoLocal(zonedNow(props.utcOffset));
  const windowStart = useMeteogramWindowStart(
    props.hourly,
    props.activeDate || todayStr,
    Math.min(7, Math.max(1, days)),
  );
  const next = { ...props, windowStart };
  if (!props.embed && !props.parts && multiCharts) {
    return <MeteogramMulti {...next} />;
  }
  return <MeteogramBody {...next} />;
}

// Stručný přehled vybraného dne nad meteogramem.
export function DaySummary({
  day,
  feelsMax,
  feelsMin,
  hideTone,
}: {
  day: DailyPoint;
  feelsMax?: number;
  feelsMin?: number;
  hideTone?: boolean;
}) {
  const info = describeWeather(day.weatherCode);
  // Den bez dat (např. ČHMÚ mimo horizont): nekreslíme falešné 0, jen „?".
  const noData = !Number.isFinite(day.weatherCode);
  const prob = day.precipitationProbabilityMax ?? 0;
  const precipOp = day.precipitationSum > 0 ? 0.3 + 0.7 * (prob / 100) : 0.4;
  const hasFeels =
    Number.isFinite(feelsMax ?? NaN) && Number.isFinite(feelsMin ?? NaN);
  const tier = tempTier(feelsMax ?? day.tempMax);
  return (
    <div className="mg-daysum">
      {noData ? (
        <span className="mg-daysum-missing">?</span>
      ) : (
        <WeatherIcon kind={info.icon} isDay size={36} />
      )}
      <div className="mg-daysum-main">
        <strong className="mg-daysum-temp">
          <span
            style={
              Number.isFinite(day.tempMin)
                ? { color: tempColor(day.tempMin) }
                : undefined
            }
          >
            {Number.isFinite(day.tempMin) ? `${Math.round(day.tempMin)}°` : "?"}
          </span>
          <span className="mg-daysum-sep"> / </span>
          <span
            style={
              Number.isFinite(day.tempMax)
                ? { color: tempColor(day.tempMax) }
                : undefined
            }
          >
            {Number.isFinite(day.tempMax) ? `${Math.round(day.tempMax)}°` : "?"}
          </span>
        </strong>
        {hasFeels && (
          <span className="mg-daysum-feels">
            {tr("pocitově")} {Math.round(feelsMin!)}° / {Math.round(feelsMax!)}°
          </span>
        )}
      </div>
      {!hideTone && !noData && (
        <span
          className="mg-daysum-tone"
          style={{ background: TIER_COLOR[tier] }}
        >
          {tr(TIER_LABEL[tier])}
        </span>
      )}
      {!noData && (
        <div className="mg-daysum-precip" style={{ opacity: precipOp }}>
          <span className="mg-daysum-precip-main">
            <span className="mg-daysum-drops">
              {Array.from({
                length: Math.max(1, dropsFor(day.precipitationSum)),
              }).map((_, i) => (
                <DropMini key={i} />
              ))}
            </span>
            <strong>{fmtPrecip(day.precipitationSum)} mm</strong>
          </span>
          <span
            className="mg-daysum-prob"
            style={prob > 0 ? undefined : { visibility: "hidden" }}
          >
            {prob > 0 ? tr("{prob}% šance", { prob }) : tr("0% šance")}
          </span>
        </div>
      )}
    </div>
  );
}

function DropMini() {
  return (
    <svg width="12" height="15" viewBox="0 0 11 14" aria-hidden="true">
      <path
        d="M5.5 0S0 6 0 9.2A5.5 5.5 0 0 0 11 9.2C11 6 5.5 0 5.5 0z"
        fill={isLightPalette() ? "#0f6fe0" : "#3b9bff"}
      />
    </svg>
  );
}

// Počet sloupců stats mřížky – rovnoměrné řádky (např. 6+5 místo 8+3).
function bestStatCols(count: number, maxCols: number): number {
  if (count <= 0) return 0;
  const cap = Math.min(Math.max(1, maxCols), count);
  let best = 1;
  let bestScore = Infinity;
  for (let c = 1; c <= cap; c++) {
    const rows = Math.ceil(count / c);
    const waste = c * rows - count;
    const lastRow = count - c * (rows - 1);
    const skinnyLast =
      rows > 1 && lastRow < Math.max(2, Math.ceil(c * 0.55));
    const score = waste + (skinnyLast ? (c - lastRow) * 6 : 0);
    if (score < bestScore || (score === bestScore && c > best)) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

// Panel s ikonami pro hodinu pod kurzorem – pevné rozložení, nehýbe se.
function StatReadout({
  p,
  tab,
  activity,
  tabOrder,
  multiSelect,
  activeTabs,
  onTab,
  pressureDelta,
  visible,
  range,
  compact = false,
  shrinkMode = false,
  readOnly = false,
}: {
  p: HourlyPoint;
  tab: Tab | null;
  activity: Activity;
  tabOrder: Tab[];
  multiSelect?: boolean;
  activeTabs?: Tab[];
  onTab: (t: Tab) => void;
  pressureDelta: number;
  visible: (t: Tab) => boolean;
  range?: { min: number; max: number } | null;
  compact?: boolean;
  shrinkMode?: boolean;
  readOnly?: boolean;
}) {
  const info = describeWeather(p.weatherCode);
  const isOn = (t: Tab) =>
    !readOnly &&
    (multiSelect ? !!activeTabs?.includes(t) : tab != null && tab === t);

  const wrapRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(0);
  const [hideIcons, setHideIcons] = useState(false);
  const orderedVisible = tabOrder.filter((t) => visible(t));
  const count = orderedVisible.length;
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const wideMq = window.matchMedia("(min-width: 720px)");
    const compute = () => {
      const w = el.clientWidth;
      if (!w || count === 0) {
        setCols(0);
        setHideIcons(false);
        return;
      }
      const gap = parseFloat(getComputedStyle(el).columnGap) || (wideMq.matches ? 10 : 5);
      if (wideMq.matches) {
        const min = shrinkMode ? 108 : compact ? 118 : 152;
        const maxCols = Math.max(1, Math.floor((w + gap) / (min + gap)));
        setCols(bestStatCols(count, maxCols));
        setHideIcons(false);
        return;
      }
      const min = shrinkMode ? 40 : compact ? 44 : 48;
      const maxCols = Math.max(1, Math.floor((w + gap) / (min + gap)));
      const nextCols = bestStatCols(count, maxCols);
      setCols(nextCols);
      setHideIcons(nextCols > 4);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    wideMq.addEventListener("change", compute);
    return () => {
      ro.disconnect();
      wideMq.removeEventListener("change", compute);
    };
  }, [count, shrinkMode, compact]);

  return (
    <div
      className={`mg-stats${shrinkMode ? " shrink" : compact ? " compact" : ""}${readOnly ? " readonly" : ""}${hideIcons ? " no-icons" : ""}`}
      ref={wrapRef}
      style={
        cols > 0
          ? ({
              display: "grid",
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              gridAutoRows: "var(--stat-tile-h)",
            } as CSSProperties)
          : undefined
      }
    >
      {orderedVisible.map((tile) => (
        <StatTile
          key={tile}
          t={tile}
          p={p}
          activity={activity}
          info={info}
          isOn={isOn(tile)}
          onTab={onTab}
          range={range}
          pressureDelta={pressureDelta}
        />
      ))}
    </div>
  );
}

function StatTile({
  t,
  p,
  activity,
  info,
  isOn,
  onTab,
  range,
  pressureDelta,
}: {
  t: Tab;
  p: HourlyPoint;
  activity: Activity;
  info: ReturnType<typeof describeWeather>;
  isOn: boolean;
  onTab: (t: Tab) => void;
  range?: { min: number; max: number } | null;
  pressureDelta: number;
}) {
  switch (t) {
    case "temp":
      return (
        <button
          type="button"
          className={`mg-stat mg-stat-btn ${isOn ? "active" : ""} ${tempFlag(p.temperature)}`}
          onClick={() => onTab("temp")}
          aria-pressed={isOn}
          title={tr("Zobrazit graf teploty")}
        >
          {Number.isFinite(p.weatherCode) ? (
            <WeatherIcon kind={info.icon} isDay={p.isDay} size={30} />
          ) : (
            <span className="mg-stat-missing">?</span>
          )}
          <div className="mg-stat-v">
            <strong
              style={
                Number.isFinite(p.temperature)
                  ? { color: tempColor(p.temperature) }
                  : undefined
              }
            >
              {Number.isFinite(p.temperature)
                ? `${Math.round(p.temperature)}°`
                : "?"}
            </strong>
            <span>
              {tr("teplota")}
              {isOn && range && (
                <em className="mg-stat-range">
                  {" "}
                  {Math.round(range.min)}–{Math.round(range.max)}°
                </em>
              )}
            </span>
          </div>
        </button>
      );
    case "feels":
      return (
        <button
          type="button"
          className={`mg-stat mg-stat-btn ${isOn ? "active" : ""} ${tempFlag(p.apparentTemperature)}`}
          onClick={() => onTab("feels")}
          aria-pressed={isOn}
          title={tr("Zobrazit graf pocitové teploty")}
        >
          <PersonGlyph />
          <div className="mg-stat-v">
            <strong
              style={
                Number.isFinite(p.apparentTemperature)
                  ? { color: tempColor(p.apparentTemperature) }
                  : undefined
              }
            >
              {Number.isFinite(p.apparentTemperature)
                ? `${Math.round(p.apparentTemperature)}°`
                : "?"}
            </strong>
            <span>
              {tr("pocitově")}
              {isOn && range && (
                <em className="mg-stat-range">
                  {" "}
                  {Math.round(range.min)}–{Math.round(range.max)}°
                </em>
              )}
            </span>
          </div>
        </button>
      );
    case "precip":
      return (
        <button
          type="button"
          className={`mg-stat mg-stat-btn mg-stat-precip ${isOn ? "active" : ""} ${p.precipitation > 0 ? "flag-wet" : ""}`}
          onClick={() => onTab("precip")}
          aria-pressed={isOn}
          title={tr("Zobrazit graf srážek")}
        >
          <RainDrops
            n={dropsFor(p.precipitation)}
            prob={p.precipitationProbability}
          />
          <div className="mg-stat-v">
            <strong className="mg-precip-top">
              {p.precipitation > 0 ? `${fmtPrecip(p.precipitation)} mm` : "0 mm"}
            </strong>
            <span>
              {tr("srážky ({prob} %)", { prob: p.precipitationProbability })}
            </span>
          </div>
        </button>
      );
    case "wind":
      return (
        <button
          type="button"
          className={`mg-stat mg-stat-btn ${isOn ? "active" : ""} ${windFlag(p.windSpeed, p.windGusts)}`}
          onClick={() => onTab("wind")}
          aria-pressed={isOn}
          title={tr("Zobrazit graf větru")}
        >
          <WindGlyph />
          <div className="mg-stat-v">
            <strong>{p.windSpeed.toFixed(0)} m/s</strong>
            <span>{tr("vítr (nárazy {g} m/s)", { g: p.windGusts.toFixed(0) })}</span>
          </div>
        </button>
      );
    case "uv":
      return (
        <button
          type="button"
          className={`mg-stat mg-stat-btn ${isOn ? "active" : ""} ${uvFlag(p.uvIndex)}`}
          onClick={() => onTab("uv")}
          aria-pressed={isOn}
          title={tr("Zobrazit graf UV indexu")}
        >
          <UvGlyph />
          <div className="mg-stat-v">
            <strong style={{ color: uvColor(p.uvIndex) }}>
              {Number.isFinite(p.uvIndex) ? Math.round(p.uvIndex) : 0}
            </strong>
            <span>{tr("UV index")}</span>
          </div>
        </button>
      );
    case "cloud":
      return (
        <button
          type="button"
          className={`mg-stat mg-stat-btn ${isOn ? "active" : ""}`}
          onClick={() => onTab("cloud")}
          aria-pressed={isOn}
          title={tr("Zobrazit graf oblačnosti")}
        >
          <CloudGlyph />
          <div className="mg-stat-v">
            <strong>{Math.round(p.cloudCover)} %</strong>
            <span>{tr("oblačnost")}</span>
          </div>
        </button>
      );
    case "humidity":
      return (
        <button
          type="button"
          className={`mg-stat mg-stat-btn ${isOn ? "active" : ""} ${p.humidity >= 90 ? "flag-humid" : ""}`}
          onClick={() => onTab("humidity")}
          aria-pressed={isOn}
          title={tr("Zobrazit graf vlhkosti")}
        >
          <HumidGlyph />
          <div className="mg-stat-v">
            <strong>{Math.round(p.humidity)} %</strong>
            <span>{tr("vlhkost")}</span>
          </div>
        </button>
      );
    case "dewpoint": {
      const fog = fogRisk(p.temperature, p.dewPoint);
      return (
        <button
          type="button"
          className={`mg-stat mg-stat-btn ${isOn ? "active" : ""} ${fog ? "flag-fog" : ""}`}
          onClick={() => onTab("dewpoint")}
          aria-pressed={isOn}
          title={
            fog
              ? `${tr("Zobrazit graf rosného bodu")} – ${tr("hrozí mlha")}`
              : tr("Zobrazit graf rosného bodu")
          }
        >
          <DewGlyph />
          <div className="mg-stat-v">
            <strong>
              {Math.round(p.dewPoint)}°{fog && <FogGlyph />}
            </strong>
            <span>{tr("rosný bod")}</span>
          </div>
        </button>
      );
    }
    case "pressure":
      return (
        <button
          type="button"
          className={`mg-stat mg-stat-btn ${isOn ? "active" : ""}`}
          onClick={() => onTab("pressure")}
          aria-pressed={isOn}
          title={tr("Zobrazit graf tlaku")}
        >
          <PressureGlyph />
          <div className="mg-stat-v">
            <strong>
              {Math.round(p.pressure)} hPa <PressureTrend delta={pressureDelta} />
            </strong>
            <span>{tr("tlak")}</span>
          </div>
        </button>
      );
    case "outfit": {
      if (!Number.isFinite(p.apparentTemperature)) {
        return (
          <button
            type="button"
            className={`mg-stat mg-stat-btn mg-stat-outfit ${isOn ? "active" : ""}`}
            onClick={() => onTab("outfit")}
            aria-pressed={isOn}
            title={tr("Oblečení")}
          >
            <span className="mg-stat-missing">?</span>
            <div className="mg-stat-v">
              <strong>–</strong>
              <span>{tr("oblečení")}</span>
            </div>
          </button>
        );
      }
      const pick = outfitAt(p.apparentTemperature, activity);
      const main =
        pick.jacket.kind === "none" ? pick.top.kind : pick.jacket.kind;
      const extras = outfitExtras({
        rainProb: p.precipitationProbability,
        precip: p.precipitation,
        uv: p.uvIndex,
        eff: pick.eff,
      });
      const color = outfitLevelColor(pick.level);
      return (
        <button
          type="button"
          className={`mg-stat mg-stat-btn mg-stat-outfit ${isOn ? "active" : ""}`}
          onClick={() => onTab("outfit")}
          aria-pressed={isOn}
          title={outfitLabel(pick.top, pick.jacket, tr)}
        >
          <span className="mg-stat-cloth" style={{ color }}>
            <ClothIcon kind={main} size={30} />
          </span>
          <div className="mg-stat-v">
            <strong style={{ color }}>
              {tr(
                pick.jacket.kind === "none" ? pick.top.label : pick.jacket.label,
              )}
            </strong>
            <span className="mg-stat-extras">
              {tr("oblečení")}
              {extras.map((k) => (
                <ClothIcon key={k} kind={k} size={13} />
              ))}
            </span>
          </div>
        </button>
      );
    }
    default:
      return null;
  }
}

// Barva podle úrovně UV (WHO škála): nízké / střední / vysoké / velmi vysoké.
function uvBandColor(uv: number): string {
  if (uv >= 8) return "#d94ea6";
  if (uv >= 6) return "#ff6b6b";
  if (uv >= 3) return "#f0a33c";
  return "#5bd99a";
}
// Barva větru podle síly (m/s) – stejné prahy jako WIND_BANDS.
function windBandColor(ms: number): string {
  if (!Number.isFinite(ms)) return "#5bd99a";
  if (ms >= 15) return "#d94ea6";
  if (ms >= 10) return "#ff6b6b";
  if (ms >= 5) return "#f0a33c";
  return "#5bd99a";
}
// Prahy jednotlivých pásem (spodní hranice) + krátký popis.
const UV_BANDS = [
  { v: 3, label: "střední", color: "#f0a33c" },
  { v: 6, label: "vysoké", color: "#ff6b6b" },
  { v: 8, label: "velmi vysoké", color: "#d94ea6" },
];
// Prahy síly větru (m/s) – orientačně dle Beaufortovy stupnice.
const WIND_BANDS = [
  { v: 5, label: "střední", color: "#f0a33c" },
  { v: 10, label: "silný", color: "#ff6b6b" },
  { v: 15, label: "velmi silný", color: "#d94ea6" },
];
// Prahy rosného bodu (°C) – od kdy začíná být dusno (subjektivní vlhko).
const DEW_BANDS = [
  { v: 16, label: "dusno", color: "#f0a33c" },
  { v: 18, label: "velmi dusno", color: "#d94ea6" },
];
// Prahy intenzity srážek (mm za hodinu) – mírný / silný / přívalový déšť.
const PRECIP_BANDS = [
  { v: 2.5, label: "mírný", color: "#f0a33c" },
  { v: 7.5, label: "silný", color: "#ff6b6b" },
  { v: 15, label: "přívalový", color: "#d94ea6" },
];
function uvColor(uv: number): string {
  if (!Number.isFinite(uv)) return "inherit";
  return uvBandColor(uv);
}
function uvFlag(uv: number): string {
  if (uv >= 8) return "flag-vhot";
  if (uv >= 6) return "flag-hot";
  return "";
}

// Ikonka pro řádek v dropdownu zobrazení dat.
function TabGlyph({ tab }: { tab: Tab }) {
  switch (tab) {
    case "temp":
      return <ThermGlyph />;
    case "feels":
      return <PersonGlyph />;
    case "precip":
      return <RainGlyph />;
    case "wind":
      return <WindGlyph />;
    case "cloud":
      return <CloudGlyph />;
    case "humidity":
      return <HumidGlyph />;
    case "dewpoint":
      return <DewGlyph />;
    case "pressure":
      return <PressureGlyph />;
    case "uv":
      return <UvGlyph />;
    case "outfit":
      return <ShirtGlyph />;
  }
}

function ShirtGlyph() {
  return (
    <svg
      className="mg-glyph"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 3.5 4.5 6l1.8 3.4L8 8.4V20h8V8.4l1.7 1L19.5 6 15 3.5c-1 1.9-5 1.9-6 0z" />
    </svg>
  );
}

function UvGlyph() {
  return (
    <svg
      className="mg-glyph"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function ThermGlyph() {
  return (
    <svg className="mg-glyph" width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path
        d="M10 13.5V5a2 2 0 1 1 4 0v8.5a4 4 0 1 1-4 0z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GearGlyph() {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function GripGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  );
}

function PinGlyph({ filled }: { filled: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      aria-hidden="true"
    >
      <path
        d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z M12 14v7"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Zvýraznění nestandardních hodnot, ať jsou na první pohled vidět.
function tempFlag(t: number): string {
  if (t >= 30) return "flag-vhot";
  if (t >= 26) return "flag-hot";
  if (t <= -6) return "flag-vcold";
  if (t <= 0) return "flag-cold";
  return "";
}

function windFlag(speed: number, gusts: number): string {
  if (speed >= 14 || gusts >= 20) return "flag-vwindy";
  if (speed >= 8 || gusts >= 13) return "flag-windy";
  return "";
}

// Riziko mlhy: teplota se blíží rosnému bodu (malý rozdíl → nasycený vzduch).
// maxSpread určuje přísnost: 2.5 °C = mlha možná, ~1 °C = mlha hodně pravděpodobná.
function fogRisk(temp: number, dew: number, maxSpread = 2.5): boolean {
  return (
    Number.isFinite(temp) && Number.isFinite(dew) && temp - dew <= maxSpread
  );
}

function FogGlyph() {
  return (
    <svg
      className="mg-fog-mini"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label="mlha"
    >
      <title>mlha</title>
      <path
        d="M4 8h16M4 12h16M4 16h13M7 20h11"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Počet „naplněných" kapek (0–4) podle úhrnu srážek.
function dropsFor(mm: number): number {
  if (mm <= 0) return 0;
  if (mm < 2) return 1;
  if (mm < 6) return 2;
  if (mm < 15) return 3;
  return 4;
}

// Formát srážek: celé hodnoty bez desetinné nuly (2.0 → „2"), jinak 1 desetinné místo.
function fmtPrecip(mm: number): string {
  const s = mm.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

// Čtyři kapky v mřížce 2×2 (jako ikona srážek). Modré = kolik má napršet,
// zbytek šedé; průhlednost modrých podle šance na déšť.
function RainDrops({ n, prob }: { n: number; prob: number }) {
  const op = n > 0 ? (prob > 0 ? 0.25 + 0.75 * (prob / 100) : 0.5) : 1;
  const light = isLightPalette();
  const activeFill = light ? "#0f6fe0" : "#3b9bff";
  const emptyFill = light ? "rgba(28,40,66,0.28)" : "rgba(255,255,255,0.18)";
  return (
    <span className="mg-drops4 mg-glyph" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <svg key={i} width={9} height={11} viewBox="0 0 11 14">
          <path
            d="M5.5 0S0 6 0 9.2A5.5 5.5 0 0 0 11 9.2C11 6 5.5 0 5.5 0z"
            fill={i < n ? activeFill : emptyFill}
            opacity={i < n ? op : 1}
          />
        </svg>
      ))}
    </span>
  );
}

function PersonGlyph() {
  return (
    <svg className="mg-glyph" width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="6" r="3" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M5 21c0-4 3.1-7 7-7s7 3 7 7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function WindGlyph() {
  return (
    <svg className="mg-glyph" width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path
        d="M3 8h11a3 3 0 1 0-3-3M3 16h14a3 3 0 1 1-3 3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Šipka směru větru – ukazuje, kam vítr vane (stejná konvence jako ve výhledu).
function WindDirArrow({ deg }: { deg: number }) {
  return (
    <svg
      className="mg-winddir-svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      style={{ transform: `rotate(${deg}deg)` }}
      aria-hidden="true"
    >
      <path
        d="M12 3v15m0 0l-5-5m5 5l5-5"
        stroke="currentColor"
        strokeWidth="2.2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloudGlyph() {
  return (
    <svg className="mg-glyph" width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path
        d="M7 18a4 4 0 0 1 .4-8 5.5 5.5 0 0 1 10.5 1.5A3.5 3.5 0 0 1 17.5 18H7z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RainGlyph() {
  return (
    <svg className="mg-glyph" width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path
        d="M7 14a4 4 0 0 1 .4-8 5.5 5.5 0 0 1 10.5 1.5A3.5 3.5 0 0 1 17.5 14H7z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function StormBoltMark({ hail }: { hail: boolean }) {
  return (
    <svg
      className="mg-storm-bolt"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
    >
      <path
        d="M8 0 L3 8 H6.5 L5 14 L11 5 H7.5 L9.5 0 Z"
        fill="rgba(200,170,255,0.95)"
        stroke="rgba(120,80,200,0.8)"
        strokeWidth="0.6"
        strokeLinejoin="round"
      />
      {hail && (
        <>
          <circle cx="1.5" cy="12.5" r="1.1" fill="rgba(220,235,255,0.95)" />
          <circle cx="12.5" cy="12.5" r="1.1" fill="rgba(220,235,255,0.95)" />
        </>
      )}
    </svg>
  );
}

function HumidGlyph() {
  // Vlhkost = kapka se znakem „%" uvnitř (relativní vlhkost v procentech).
  return (
    <svg className="mg-glyph" width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 3s6 6.5 6 10.5A6 6 0 0 1 6 13.5C6 9.5 12 3 12 3z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <line
        x1="14"
        y1="10.6"
        x2="10"
        y2="16"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="10.3" cy="11" r="1.05" fill="currentColor" />
      <circle cx="13.7" cy="15.6" r="1.05" fill="currentColor" />
    </svg>
  );
}

// Trendová šipka tlaku podle 3h tendence (prudce/mírně nahoru/dolů, stálý).
function PressureTrend({ delta }: { delta: number }) {
  let angle: number;
  let cls: string;
  let title: string;
  // Barva podle vlivu na počasí: klesající tlak (horší počasí) = červená,
  // stoupající (lepší počasí) = zelená, stálý = žlutá uprostřed.
  let color: string;
  if (delta >= 2) {
    angle = -90;
    cls = "up";
    title = "prudce stoupá";
    color = "#35c46a";
  } else if (delta >= 0.7) {
    angle = -45;
    cls = "up";
    title = "stoupá";
    color = "#8fce5a";
  } else if (delta <= -2) {
    angle = 90;
    cls = "down";
    title = "prudce klesá";
    color = "#ff5b5b";
  } else if (delta <= -0.7) {
    angle = 45;
    cls = "down";
    title = "klesá";
    color = "#ff8a5b";
  } else {
    angle = 0;
    cls = "steady";
    title = "stálý";
    color = "#e0b24d";
  }
  return (
    <svg
      className={`mg-ptrend ${cls}`}
      style={{ color }}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label={`tlak ${title}`}
    >
      <title>{title}</title>
      <g transform={`rotate(${angle} 12 12)`}>
        <path
          d="M4 12h13M12 7l6 5-6 5"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

function DewGlyph() {
  // Rosný bod = kapka kondenzující na povrchu (vodorovná čára = rosa na zemi).
  return (
    <svg className="mg-glyph" width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 4.5s4.4 4.8 4.4 8A4.4 4.4 0 0 1 7.6 12.5C7.6 9.3 12 4.5 12 4.5z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M4 20h16"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <circle cx="6.6" cy="17.6" r="0.95" fill="currentColor" />
      <circle cx="17.4" cy="17.6" r="0.95" fill="currentColor" />
    </svg>
  );
}

function PressureGlyph() {
  return (
    <svg className="mg-glyph" width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M12 12l4-3"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface ExtraLine {
  values: number[];
  color: string;
  label: string;
}

interface SeriesConfig {
  primary: number[];
  secondary?: number[];
  secondaryColor?: string;
  extras?: ExtraLine[];
  refLine?: ExtraLine;
  min: number;
  max: number;
  stroke: string;
  fill: string;
  fmt: (v: number) => string;
}

// Přepočet hodinových „preceding-hour" průměrů (interval [t−1 h, t], střed
// t−30 min) na odhad okamžité hodnoty v čase značky t: lineární interpolace
// mezi středy sousedních intervalů vyjde jako průměr této a následující hodiny.
// U posledního bodu okna (chybí následující) necháme syrovou hodnotu.
function recenterMeanToInstant(arr: number[]): number[] {
  return arr.map((v, i) => {
    if (!Number.isFinite(v)) return v;
    const next = arr[i + 1];
    return Number.isFinite(next) ? (v + next) / 2 : v;
  });
}

function buildSeries(
  tab: Tab,
  points: HourlyPoint[],
  activity: Activity = "walk",
): SeriesConfig {
  if (tab === "outfit") {
    // Osa je pocitová teplota posunutá o aktivitu – přesně ta hodnota, ze které
    // se v ../lib/outfit skládá doporučené oblečení.
    const off = ACTIVITY_OFFSET[activity];
    const eff = points.map((p) =>
      Number.isFinite(p.apparentTemperature)
        ? p.apparentTemperature + off
        : NaN,
    );
    const finite = eff.filter((v) => Number.isFinite(v));
    const lo = finite.length ? Math.min(...finite) : 0;
    const hi = finite.length ? Math.max(...finite) : 1;
    // Trochu širší rezerva než u teploty: ať je vidět i pás nad/pod křivkou a
    // bylo poznat, jak blízko je přehoupnutí do jiné vrstvy.
    const pad = Math.max(2, (hi - lo) * 0.18);
    return {
      primary: eff,
      min: lo - pad,
      max: hi + pad,
      stroke: "#ffb168",
      fill: "#ffb168",
      fmt: (v) => `${Math.round(v)}°`,
    };
  }
  if (tab === "precip") {
    const precip = points.map((p) => p.precipitation);
    const max = niceMax(Math.max(0, ...precip));
    return {
      primary: precip,
      min: 0,
      max,
      stroke: "#3b9bff",
      fill: "#3b9bff",
      fmt: (v) => `${fmtPrecip(v)} mm`,
    };
  }
  if (tab === "wind") {
    const speed = points.map((p) => p.windSpeed);
    const gusts = points.map((p) => p.windGusts);
    const max = Math.max(1, ...gusts) * 1.1;
    return {
      primary: speed,
      secondary: gusts,
      secondaryColor: "#ff5b5b",
      min: 0,
      max,
      stroke: "#5bd99a",
      fill: "#5bd99a",
      fmt: (v) => `${v.toFixed(0)}`,
    };
  }
  if (tab === "cloud") {
    const cloud = points.map((p) => p.cloudCover);
    return {
      primary: cloud,
      extras: [
        { values: points.map((p) => p.cloudHigh), color: "#e7edf8", label: "vysoká" },
        { values: points.map((p) => p.cloudMid), color: "#aeb9d2", label: "střední" },
        { values: points.map((p) => p.cloudLow), color: "#6f8ac9", label: "nízká" },
      ],
      min: 0,
      max: 100,
      stroke: "#c3cde0",
      fill: "#c3cde0",
      fmt: (v) => `${Math.round(v)}%`,
    };
  }
  if (tab === "humidity") {
    const hum = points.map((p) => p.humidity);
    return {
      primary: hum,
      min: 0,
      max: 100,
      stroke: "#4fd1b0",
      fill: "#4fd1b0",
      fmt: (v) => `${Math.round(v)}%`,
    };
  }
  if (tab === "dewpoint") {
    const dew = points.map((p) => p.dewPoint);
    const lo = Math.min(...dew);
    const hi = Math.max(...dew);
    const pad = Math.max(1, (hi - lo) * 0.15);
    return {
      primary: dew,
      min: lo - pad,
      max: hi + pad,
      stroke: "#63c7e0",
      fill: "#63c7e0",
      fmt: (v) => `${Math.round(v)}°`,
    };
  }
  if (tab === "pressure") {
    const pres = points.map((p) => p.pressure);
    const lo = Math.min(...pres);
    const hi = Math.max(...pres);
    const pad = Math.max(1, (hi - lo) * 0.15);
    return {
      primary: pres,
      min: lo - pad,
      max: hi + pad,
      stroke: "#e0b24d",
      fill: "#e0b24d",
      fmt: (v) => `${Math.round(v)}`,
    };
  }
  if (tab === "uv") {
    // Open-Meteo dává hodinové UV jako průměr za PŘEDCHOZÍ hodinu (potvrzeno
    // autorem API i porovnáním se shortwave_radiation), tj. hodnota u značky t
    // reprezentuje interval [t−1 h, t] se středem v t−30 min. Kdybychom kreslili
    // syrovou hodnotu na značku t, celá křivka by se posunula ~30–60 min doprava
    // a vrchol by neseděl na solární poledne. Přepočítáme proto průměry na odhad
    // okamžité hodnoty přímo v čase značky (lineární interpolace mezi středy
    // sousedních intervalů = průměr této a následující hodiny).
    const uvRaw = points.map((p) =>
      Number.isFinite(p.uvIndex) ? p.uvIndex : 0,
    );
    const clearRaw = points.map((p, i) =>
      Number.isFinite(p.uvIndexClearSky) ? p.uvIndexClearSky : uvRaw[i],
    );
    const uv = recenterMeanToInstant(uvRaw);
    // UV bez oblačnosti (clear-sky) jako referenční čára – rozdíl vůči reálnému
    // UV ukazuje, kolik ubraly mraky. Když chybí, spadneme na reálné UV.
    const clear = recenterMeanToInstant(clearRaw);
    const hi = Math.max(0, ...uv, ...clear);
    // UV má smysl od 0; horní hranici držíme aspoň na 3, ať malé hodnoty nejsou
    // přehnaně zvětšené (a osa odpovídá běžné UV škále).
    const max = Math.max(3, Math.ceil(hi + 0.5));
    return {
      primary: uv,
      refLine: { values: clear, color: "#f0c674", label: "bez mraků" },
      min: 0,
      max,
      stroke: "#b06bff",
      fill: "#b06bff",
      fmt: (v) => `${Math.round(v)}`,
    };
  }
  if (tab === "feels") {
    const feels = points.map((p) => p.apparentTemperature);
    const finite = feels.filter((v) => Number.isFinite(v));
    const lo = finite.length ? Math.min(...finite) : 0;
    const hi = finite.length ? Math.max(...finite) : 1;
    const pad = Math.max(0.5, (hi - lo) * 0.06);
    return {
      primary: feels,
      min: lo - pad,
      max: hi + pad,
      stroke: "#c98bff",
      fill: "#c98bff",
      fmt: (v) => `${Math.round(v)}°`,
    };
  }
  const temps = points.map((p) => p.temperature);
  const finiteTemps = temps.filter((v) => Number.isFinite(v));
  const lo = finiteTemps.length ? Math.min(...finiteTemps) : 0;
  const hi = finiteTemps.length ? Math.max(...finiteTemps) : 1;
  // Menší padding = vyšší amplituda (křivka využije víc výšky grafu).
  const pad = Math.max(0.5, (hi - lo) * 0.06);
  return {
    primary: temps,
    min: lo - pad,
    max: hi + pad,
    stroke: "#ff8a5b",
    fill: "#ff8a5b",
    fmt: (v) => `${Math.round(v)}°`,
  };
}

function valueLabels(points: HourlyPoint[], values: number[], minGap = 2) {
  const n = values.length;
  if (n === 0) return [];
  const MIN_GAP = Math.max(2, minGap);

  type Cand = { i: number; kind: "max" | "min"; prio: number };
  const cands: Cand[] = [];

  const localKind = (i: number): "max" | "min" => {
    const prev = values[i - 1] ?? values[i];
    const next = values[i + 1] ?? values[i];
    return values[i] >= (prev + next) / 2 ? "max" : "min";
  };

  for (let i = 1; i < n - 1; i++) {
    if (!Number.isFinite(values[i])) continue;
    if (values[i] > values[i - 1] && values[i] >= values[i + 1])
      cands.push({ i, kind: "max", prio: 3 });
    else if (values[i] < values[i - 1] && values[i] <= values[i + 1])
      cands.push({ i, kind: "min", prio: 3 });
  }
  if (Number.isFinite(values[0])) cands.push({ i: 0, kind: localKind(0), prio: 2 });
  if (Number.isFinite(values[n - 1]))
    cands.push({ i: n - 1, kind: localKind(n - 1), prio: 2 });
  points.forEach((p, i) => {
    if (Number.isFinite(values[i]) && locDate(p.time).getHours() % 6 === 0)
      cands.push({ i, kind: localKind(i), prio: 1 });
  });

  cands.sort((a, b) => a.i - b.i || b.prio - a.prio);

  const kept: Cand[] = [];
  for (const c of cands) {
    const last = kept[kept.length - 1];
    if (last && c.i - last.i < MIN_GAP) {
      if (c.prio > last.prio) kept[kept.length - 1] = c;
      continue;
    }
    if (last && c.i === last.i) continue;
    kept.push(c);
  }
  return kept;
}

// Zaokrouhlí maximum srážek nahoru na „hezkou" hodnotu pro osu grafu.
function niceMax(v: number): number {
  if (v <= 1) return 1;
  if (v <= 2) return 2;
  if (v <= 5) return 5;
  if (v <= 10) return 10;
  if (v <= 20) return 20;
  return Math.ceil(v / 10) * 10;
}

function isoLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Malá „?" ikonka s tooltipem – zobrazí se po najetí (desktop) i po kliknutí
// (dotyk). Text se předává už přeložený.
function InfoHint({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Pozici počítáme až po vykreslení (známe rozměr bubliny) a ořezáváme ji do
  // viewportu, aby nikdy nevytekla ven – proto renderujeme přes portál (fixed).
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const b = btnRef.current?.getBoundingClientRect();
      if (!b) return;
      const tw = tipRef.current?.offsetWidth ?? 240;
      const th = tipRef.current?.offsetHeight ?? 60;
      const m = 8;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = b.right - tw;
      left = Math.min(Math.max(m, left), vw - tw - m);
      const above = b.top - th - m >= m;
      const top = above
        ? b.top - th - m
        : Math.min(b.bottom + m, vh - th - m);
      setPos({ top, left });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  return (
    <span
      className="mg-info"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span
        ref={btnRef}
        className="mg-info-btn"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-label={text}
        title={text}
      >
        ?
      </span>
      {open &&
        createPortal(
          <div
            ref={tipRef}
            className="mg-info-pop"
            role="tooltip"
            style={{
              position: "fixed",
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              opacity: pos ? 1 : 0,
              visibility: "visible",
            }}
          >
            {text}
          </div>,
          document.body,
        )}
    </span>
  );
}

// Vzdálenost dvou dotyků (pro pinch gesto).
function ptDist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function dayShortLabel(date: string): string {
  const d = locDate(date);
  return `${dayShort()[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}.`;
}

