import {
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
import { dayHeader } from "../lib/format";
import { useStoredState } from "../lib/useStoredState";
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
import { WEATHER_MODELS, modelColor, modelLabel } from "../lib/models";
import WeatherIcon from "./WeatherIcon";

interface Props {
  hourly: HourlyPoint[];
  activeDate?: string;
  lat?: number;
  lon?: number;
  model?: string;
  theme?: "light" | "dark";
}

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
  | "uv";

const ALL_TABS: Tab[] = [
  "temp",
  "feels",
  "precip",
  "wind",
  "uv",
  "cloud",
  "humidity",
  "dewpoint",
  "pressure",
];

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
};

// Pevné okno od 00:00 vybraného dne. Graf se vejde na šířku, nescrolluje.
const H = 240;
// Nahoře necháme dva řádky: název dne + plovoucí popisek vybrané hodiny.
const TOP_PAD = 48;
const PRECIP_H = 58;
const CURVE_BOTTOM = H - PRECIP_H - 8;

const DAY_SHORT_CS = ["Ne", "Po", "Út", "St", "Čt", "Pá", "So"];
const DAY_SHORT_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function dayShort() {
  return getLang() === "en" ? DAY_SHORT_EN : DAY_SHORT_CS;
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

export default function Meteogram({
  hourly,
  activeDate,
  lat,
  lon,
  model = "best_match",
  theme = "dark",
}: Props) {
  const [tab, setTab] = useStoredState<Tab>("zmoknu.mgTab", "temp");
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
  const viewRef = useRef<HTMLDivElement>(null);
  const viewBtnRef = useRef<HTMLButtonElement>(null);
  const viewMenuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{
    top?: number;
    bottom?: number;
    right: number;
    maxH: number;
  } | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  const togglePin = (t: Tab) =>
    setPinned({ ...pinned, [t]: !pinned[t] });

  // Menu vykreslujeme přes portál mimo kartu (karta má overflow:hidden a
  // ořízla by ho). Pozici odvodíme z tlačítka a přepočítáme při scrollu/resize.
  useEffect(() => {
    if (!viewOpen) return;
    const place = () => {
      const b = viewBtnRef.current;
      if (!b) return;
      const r = b.getBoundingClientRect();
      const right = window.innerWidth - r.right;
      const gap = 6;
      const margin = 8;
      const below = window.innerHeight - r.bottom - margin - gap;
      const above = r.top - margin - gap;
      // Otevři dolů, pokud je tam víc místa; jinak nad tlačítko. Výšku vždy ořízni
      // dostupným prostorem (obsah se pak scrolluje) – ať menu nepřeteče z okna.
      if (below >= above) {
        setMenuPos({ top: r.bottom + gap, right, maxH: Math.min(below, 560) });
      } else {
        setMenuPos({
          bottom: window.innerHeight - r.top + gap,
          right,
          maxH: Math.min(above, 560),
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

  // Zavření dropdownu při kliknutí mimo (tlačítko i portálové menu).
  useEffect(() => {
    if (!viewOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (viewRef.current?.contains(t)) return;
      if (viewMenuRef.current?.contains(t)) return;
      setViewOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [viewOpen]);

  // Změř šířku plochy grafu (bez scrollu se vše vejde na tuto šířku).
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const todayStr = isoLocal(new Date());

  // Počet zobrazených dní volí uživatel (1–7) v nabídce zobrazení dat nebo
  // pinch gestem nad grafem.
  const windowHours = Math.min(7, Math.max(1, days)) * 24;

  // Okno začíná na 00:00 vybraného dne (nebo dneška).
  const points = useMemo(() => {
    const base = activeDate || todayStr;
    let start = hourly.findIndex(
      (h) => h.time.slice(0, 10) === base && new Date(h.time).getHours() === 0,
    );
    if (start === -1) start = hourly.findIndex((h) => h.time.slice(0, 10) >= base);
    if (start === -1) start = 0;
    return hourly.slice(start, start + windowHours);
  }, [hourly, activeDate, todayStr, windowHours]);

  const activeMissing = useMemo(() => {
    if (!activeDate || !points.length) return false;
    return !points.some((p) => p.time.slice(0, 10) === activeDate);
  }, [activeDate, points]);

  const isCloud = tab === "cloud";
  const isPrecip = tab === "precip";

  const pph = points.length > 0 && width > 0 ? width / points.length : 0;
  const x = (i: number) => (i + 0.5) * pph;

  // Krok ikon počasí (v hodinách) podle dostupného místa – při více dnech
  // (menší pph) se ikony ředí, ať se nepřekrývají. Ikony se střídají do dvou
  // řad, takže stačí ~2× menší rozestup než šířka ikony.
  const iconStep = useMemo(() => {
    if (!pph) return 2;
    for (const s of [2, 3, 4, 6, 12]) {
      if (s * pph >= 26) return s;
    }
    return 24;
  }, [pph]);

  // Multimód: stáhni hodinovou řadu pro aktuální veličinu z vybraných modelů.
  const omVar = TAB_OM_VAR[tab];
  useEffect(() => {
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
  }, [compareModels, lat, lon, omVar]);

  // Pás nejistoty (alternate predictions): stáhni globální modely pro teplotu
  // / pocitovou a z jejich rozptylu vykresli pásmo kolem hlavní čáry.
  const spreadEnabled = showSpread && (tab === "temp" || tab === "feels");
  useEffect(() => {
    if (!spreadEnabled || lat == null || lon == null) {
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
  }, [spreadEnabled, lat, lon, omVar]);

  // Historický normál (ERA5, 30 let) – stáhne se jednou pro lokalitu při zapnutí.
  useEffect(() => {
    if (!showNormal || lat == null || lon == null) {
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
  }, [showNormal, lat, lon]);

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

  // Index "teď" – jen když je aktuální čas uvnitř okna.
  const nowIndex = useMemo(() => {
    if (!points.length) return -1;
    const now = Date.now();
    const first = new Date(points[0].time).getTime();
    const last = new Date(points[points.length - 1].time).getTime();
    if (now < first - 1_800_000 || now > last + 1_800_000) return -1;
    let best = 0;
    let bestDiff = Infinity;
    points.forEach((p, i) => {
      const diff = Math.abs(new Date(p.time).getTime() - now);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    });
    return best;
  }, [points]);

  // Spojitá X pozice "teď" (posouvá se podle času, ne skokově po hodinách).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const nowX = useMemo(() => {
    if (!points.length || !pph) return -1;
    const first = new Date(points[0].time).getTime();
    const last = new Date(points[points.length - 1].time).getTime();
    if (nowMs < first - 1_800_000 || nowMs > last + 1_800_000) return -1;
    const fi = (nowMs - first) / 3_600_000;
    return x(fi);
  }, [points, pph, nowMs]);

  const [cursor, setCursor] = useState(0);
  useEffect(() => {
    setCursor(nowIndex >= 0 ? nowIndex : Math.min(12, points.length - 1));
  }, [nowIndex, points.length]);

  const precipMax = useMemo(
    () => Math.max(1, ...points.map((p) => p.precipitation)),
    [points],
  );

  const activeKey = activeDate || todayStr;

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
          date: new Date(points[i - 1].time),
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

  const baseSeries = useMemo(() => buildSeries(tab, points), [tab, points]);

  // Historický normál kreslíme jen u skutečné teploty (naše data jsou teplotní).
  // Hodnotu plynule interpolujeme mezi dny podle hodiny, aby se čára viditelně
  // měnila den ode dne (ne plochý schod na den).
  const normalData = useMemo(() => {
    if (!showNormal || !normals || tab !== "temp") return null;
    const mean = points.map((p) => interpNormal(normals.mean, p.time));
    const max = points.map((p) => interpNormal(normals.max, p.time));
    const min = points.map((p) => interpNormal(normals.min, p.time));
    if (!mean.some((v) => v != null)) return null;
    return { mean, max, min };
  }, [showNormal, normals, tab, points]);

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

  const yCurve = (v: number) => {
    const t = (v - series.min) / Math.max(0.001, series.max - series.min);
    return CURVE_BOTTOM - t * (CURVE_BOTTOM - TOP_PAD);
  };

  // U tabu srážek kreslíme sloupce od úplného spodku grafu (víc místa).
  const PRECIP_BASELINE = H - 16;
  const yPrecip = (v: number) =>
    PRECIP_BASELINE - (v / Math.max(0.001, series.max)) * (PRECIP_BASELINE - TOP_PAD);

  // Vodorovné osové linky pro velký graf srážek (hodnoty v mm).
  const precipTicks = useMemo(() => {
    if (!isPrecip) return [];
    const max = series.max;
    return [0.25, 0.5, 0.75, 1]
      .map((f) => Math.round(max * f * 10) / 10)
      .filter((v, i, arr) => v > 0 && arr.indexOf(v) === i);
  }, [isPrecip, series.max]);

  // Srážky: vodorovné prahové čáry intenzity (mírný / silný déšť).
  const precipThresholds = useMemo(() => {
    if (!isPrecip) return [];
    return PRECIP_BANDS.filter((b) => b.v < series.max).map((b) => ({
      ...b,
      y: yPrecip(b.v),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPrecip, series.max]);

  const linePath = useMemo(() => {
    if (!pph) return "";
    return series.primary
      .map((v, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${yCurve(v)}`)
      .join(" ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, points.length, pph]);

  const secondaryPath = useMemo(() => {
    if (!series.secondary || !pph) return "";
    return series.secondary
      .map((v, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${yCurve(v)}`)
      .join(" ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, points.length, pph]);

  const refLinePath = useMemo(() => {
    if (!series.refLine || !pph) return "";
    return series.refLine.values
      .map((v, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${yCurve(v)}`)
      .join(" ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, points.length, pph]);

  const extraPaths = useMemo(() => {
    if (!series.extras || !pph) return [];
    return series.extras.map((ex) => ({
      color: ex.color,
      d: ex.values
        .map((v, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${yCurve(v)}`)
        .join(" "),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, points.length, pph]);

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
    if (!normalData || tab !== "temp" || !pph) return null;
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
  }, [normalData, tab, points, dayBands, pph, series]);

  // Multimód: čáry jednotlivých modelů pro aktuální veličinu (stejná osa Y).
  const compareLines = useMemo(() => {
    if (!modelSeries.length || !pph || isCloud) return [];
    return modelSeries
      .map((ms) => {
        let d = "";
        let pen = false;
        points.forEach((p, i) => {
          const v = ms.byTime.get(p.time);
          if (v == null) {
            pen = false;
            return;
          }
          d += `${pen ? "L" : "M"} ${x(i)} ${yCurve(v)} `;
          pen = true;
        });
        return { model: ms.model, color: modelColor(ms.model), d: d.trim() };
      })
      .filter((l) => l.d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelSeries, points, pph, isCloud, series]);

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

  const cloudBands = useMemo(() => {
    if (!isCloud || !pph) return [];
    const layers = [
      { values: points.map((p) => p.cloudHigh), color: "#e7edf8", label: "vysoká" },
      { values: points.map((p) => p.cloudMid), color: "#aeb9d2", label: "střední" },
      { values: points.map((p) => p.cloudLow), color: "#6f8ac9", label: "nízká" },
    ];
    const bandH = (CURVE_BOTTOM - TOP_PAD) / 3;
    return layers.map((l, idx) => {
      const centerY = TOP_PAD + bandH * (idx + 0.5);
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
    if (tab !== "temp" && tab !== "feels") return [];
    const n = 12;
    const out: { offset: number; color: string }[] = [];
    for (let k = 0; k <= n; k++) {
      const off = k / n;
      const t = series.max - off * (series.max - series.min);
      out.push({ offset: off, color: tempColor(t) });
    }
    return out;
  }, [tab, series.min, series.max, theme]);

  // UV: „tvrdý" vertikální gradient – čára mění barvu podle pásma (ne plynule).
  const uvLineStops = useMemo(() => {
    if (tab !== "uv") return [];
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
  }, [tab, series.min, series.max]);

  // UV: vodorovné prahové čáry (odkud je záření nebezpečnější).
  const uvThresholds = useMemo(() => {
    if (tab !== "uv" || !pph) return [];
    return UV_BANDS.filter((b) => b.v > series.min && b.v < series.max).map(
      (b) => ({ ...b, y: yCurve(b.v) }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, pph, series.min, series.max]);

  // Vítr: vodorovné prahové čáry (střední / silný / velmi silný vítr).
  const windThresholds = useMemo(() => {
    if (tab !== "wind" || !pph) return [];
    return WIND_BANDS.filter((b) => b.v > series.min && b.v < series.max).map(
      (b) => ({ ...b, y: yCurve(b.v) }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, pph, series.min, series.max]);

  // Rosný bod: vodorovné prahové čáry (od kdy je dusno).
  const dewThresholds = useMemo(() => {
    if (tab !== "dewpoint" || !pph) return [];
    return DEW_BANDS.filter((b) => b.v > series.min && b.v < series.max).map(
      (b) => ({ ...b, y: yCurve(b.v) }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, pph, series.min, series.max]);

  // Souvislé úseky s rizikem mlhy (teplota blízko rosného bodu) – ukazují se
  // v grafu vlhkosti a rosného bodu jako podbarvený pruh s ikonkou mlhy.
  const fogSegments = useMemo(() => {
    if (!(tab === "dewpoint" || tab === "humidity") || !pph) return [];
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
  }, [tab, pph, points]);

  const labelValues = series.primary;
  const labelColor = tab === "feels" ? "feels" : "";
  // Minimální rozestup popisků v hodinách odvozený od skutečné šířky (px),
  // aby se na úzké obrazovce (malé pph) hodnoty nepřekrývaly.
  const minGapHours = pph > 0 ? Math.max(2, Math.ceil(40 / pph)) : 2;
  const valueLabelList = useMemo(
    () => valueLabels(points, labelValues, minGapHours),
    [points, labelValues, minGapHours],
  );

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

  // Pinch na trackpadu (macOS) přichází jako wheel s ctrlKey. React onWheel je
  // pasivní (nejde preventDefault kvůli zoomu stránky), proto nativní listener.
  useEffect(() => {
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
  }, [setDays]);

  function handlePointer(clientX: number) {
    const el = plotRef.current;
    if (!el || !pph) return;
    const rect = el.getBoundingClientRect();
    const px = clientX - rect.left;
    const i = Math.floor(px / pph);
    setCursor(Math.max(0, Math.min(points.length - 1, i)));
  }

  if (!points.length) return null;

  // Kurzor může být po zmenšení okna (méně dní) mimo rozsah – ořízneme,
  // ať nesáhneme na points[cursor], které už neexistuje.
  const ci = Math.min(Math.max(0, cursor), points.length - 1);
  const active = points[ci];

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

  // Pozice tooltipu (den + čas) u kurzoru, oříznutá do šířky grafu.
  const tipW = 78;
  const tipX = Math.max(2, Math.min(width - tipW - 2, x(ci) - tipW / 2));

  return (
    <>
      <section className="card meteogram-card">
      <div className="mg-head">
        <div className="mg-head-title">
          <h2 className="card-title" style={{ margin: 0 }}>
            Meteogram
          </h2>
          <span className="mg-head-when">
            {cursorDayTimeLabel(active.time)}
          </span>
        </div>
        <div className="mg-dataview" ref={viewRef}>
          <button
            ref={viewBtnRef}
            type="button"
            className={`mg-view-btn ${viewOpen ? "active" : ""}`}
            onClick={() => setViewOpen((o) => !o)}
            aria-expanded={viewOpen}
            aria-label={tr("Zobrazení dat")}
            title={tr("Zobrazení dat")}
          >
            <EyeGlyph />
          </button>
          {viewOpen &&
            createPortal(
              <div
                ref={viewMenuRef}
                className="mg-view-menu"
                role="menu"
                style={{
                  position: "fixed",
                  right: menuPos?.right ?? 0,
                  ...(menuPos?.bottom != null
                    ? { bottom: menuPos.bottom }
                    : { top: menuPos?.top ?? 0 }),
                  maxHeight: menuPos?.maxH,
                }}
              >
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
              </label>
              <label className="mg-view-toggle">
                <input
                  type="checkbox"
                  checked={showTypeInfo}
                  onChange={(e) => setShowTypeInfo(e.target.checked)}
                />
                <span>{tr("Vysvětlivky u typů")}</span>
              </label>
              {(tab === "temp" || tab === "feels") && (
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
                </label>
              )}
              {(tab === "temp" || tab === "feels") && showSpread && (
                <div className="mg-view-hint">
                  {tr(
                    "Plocha ukazuje rozpětí světových modelů v danou hodinu. Úzká = shoda, široká = modely se rozcházejí a předpověď je méně jistá.",
                  )}
                </div>
              )}
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
              {showNormal && (
                <div className="mg-view-hint">
                  {tr(
                    "Průměrná teplota pro daný den z let 1995–2024 (ERA5). Zobrazí se u grafu teploty.",
                  )}
                </div>
              )}
              {showNormal && normalError && (
                <div className="mg-view-hint mg-view-hint-error" role="alert">
                  {tr(
                    "Historický normál se nepodařilo načíst. Zkus to prosím znovu.",
                  )}
                </div>
              )}
              <div className="mg-view-hint">
                {tr(
                  "Připnuté hodnoty se zobrazují nad grafem. Klikni na řádek pro zobrazení v grafu.",
                )}
              </div>
              {ALL_TABS.map((t) => (
                <div
                  key={t}
                  className={`mg-view-row ${tab === t ? "active" : ""}`}
                >
                  <button
                    type="button"
                    className="mg-view-pick"
                    onClick={() => {
                      setTab(t);
                      setViewOpen(false);
                    }}
                  >
                    <TabGlyph tab={t} />
                    <span>{tr(TAB_LABEL[t])}</span>
                  </button>
                  <button
                    type="button"
                    className={`mg-view-pin ${pinned[t] ? "on" : ""}`}
                    onClick={() => togglePin(t)}
                    aria-pressed={pinned[t]}
                    title={pinned[t] ? tr("Odepnout") : tr("Připnout nad graf")}
                  >
                    <PinGlyph filled={!!pinned[t]} />
                  </button>
                </div>
              ))}

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
                        <span
                          className="mg-view-swatch"
                          style={{ background: m.color }}
                        />
                        <span>{m.short}</span>
                      </label>
                    ))}
                  </div>
                )}
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

      {active && (
        <StatReadout
          p={active}
          tab={tab}
          onTab={setTab}
          pressureDelta={pressureDelta}
          visible={(t) => pinned[t] || tab === t}
          range={spreadRangeAt ? spreadRangeAt(ci) : null}
        />
      )}

      {showTypeInfo && (
        <p className="mg-typeinfo">{tr(TAB_INFO[tab])}</p>
      )}

      {(compareLines.length > 0 || normalData) && (
        <div className="mg-legend">
          <span className="mg-legend-item" title={modelLabel(model)}>
            <span
              className="mg-legend-line"
              style={{ background: series.stroke }}
            />
            {modelLabel(model)}
            <strong className="mg-legend-val">
              {series.fmt(series.primary[ci])}
            </strong>
            {model === "best_match" && (
              <InfoHint
                text={tr(
                  "„Automaticky“ volí nejlepší model dle lokality (v ČR ICON, pro vzdálenější dny ECMWF).",
                )}
              />
            )}
          </span>
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
                <strong className="mg-legend-val">
                  {normalStats.normal != null
                    ? series.fmt(normalStats.normal)
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
                <strong className="mg-legend-val">
                  {normalStats.actual != null
                    ? series.fmt(normalStats.actual)
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
                      color: normalStats.diff >= 0 ? "#ff8a5b" : "#63c7e0",
                    }}
                  >
                    {normalStats.diff >= 0 ? "+" : ""}
                    {series.fmt(normalStats.diff)}
                  </strong>
                </span>
              )}
            </>
          )}
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
                {modelLabel(cl.model)}
                <strong className="mg-legend-val">
                  {v != null ? series.fmt(v) : "–"}
                </strong>
              </span>
            );
          })}
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
            const [a, b] = [...pointers.current.values()];
            pinch.current = { startDist: ptDist(a, b), startDays: days };
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
          // Myš scrubuje při přejezdu; dotyk/pero jen během tažení.
          if (e.pointerType === "mouse" || pressing.current) handlePointer(e.clientX);
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId);
          if (pointers.current.size < 2) pinch.current = null;
          pressing.current = false;
        }}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId);
          if (pointers.current.size < 2) pinch.current = null;
          pressing.current = false;
        }}
      >
        {daysHint != null && (
          <div className="mg-zoomhint" aria-hidden="true">
            {daysLabel(daysHint)}
          </div>
        )}
        {/* proužek ikon – po 2 hodinách, střídavě ve dvou řadách */}
        <div className="mg-icons">
          {pph > 0 &&
            points.map((p, i) => {
              const hr = new Date(p.time).getHours();
              if (hr % iconStep !== 0) return null;
              const slot = hr / iconStep;
              return (
                <span
                  key={p.time}
                  className={`mg-icon ${slot % 2 === 0 ? "row-a" : "row-b"}`}
                  style={{ left: x(i) }}
                >
                  <WeatherIcon
                    kind={describeWeather(p.weatherCode).icon}
                    isDay={p.isDay}
                    size={20}
                  />
                </span>
              );
            })}
        </div>

        <svg width={width || 1} height={H} className="mg-svg">
          <defs>
            <linearGradient id="grad-primary" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={series.fill} stopOpacity="0.55" />
              <stop offset="100%" stopColor={series.fill} stopOpacity="0.04" />
            </linearGradient>
            {(tab === "temp" || tab === "feels") && (
              <linearGradient
                id="grad-templine"
                gradientUnits="userSpaceOnUse"
                x1="0"
                y1={TOP_PAD}
                x2="0"
                y2={CURVE_BOTTOM}
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
            {tab === "uv" && (
              <linearGradient
                id="grad-uvline"
                gradientUnits="userSpaceOnUse"
                x1="0"
                y1={TOP_PAD}
                x2="0"
                y2={CURVE_BOTTOM}
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
          </defs>

          {/* noční pruhy – plná tmavá barva (bez přechodu) */}
          {pph > 0 &&
            nightShading &&
            nightShades.map((s) => (
              <rect
                key={s.id}
                x={s.left}
                y={TOP_PAD - 10}
                width={Math.max(0, s.right - s.left)}
                height={H - 14 - (TOP_PAD - 10)}
                fill={theme === "light" ? "rgba(30,45,80,0.08)" : "rgba(0,0,8,0.26)"}
              />
            ))}

          {/* denní pruhy + oddělovače */}
          {pph > 0 &&
            dayBands.map((b, bi) => {
              const left = b.startI * pph;
              const right = (b.endI + 1) * pph;
              const isToday = b.dateStr === todayStr;
              const isActive = b.dateStr === activeKey;
              const isPast = b.dateStr < todayStr;
              const fill = isPast
                ? theme === "light"
                  ? "rgba(20,30,55,0.07)"
                  : "rgba(0,0,0,0.22)"
                : "transparent";
              return (
                <g key={`band-${bi}`}>
                  <rect
                    x={left}
                    y={TOP_PAD - 10}
                    width={right - left}
                    height={H - 14 - (TOP_PAD - 10)}
                    fill={fill}
                  />
                  <text
                    x={(left + right) / 2}
                    y={13}
                    className={`mg-daylabel ${isActive ? "selected" : ""} ${isToday ? "today" : ""}`}
                    textAnchor="middle"
                  >
                    {isToday
                      ? tr("Dnes")
                      : `${dayShort()[b.date.getDay()]} ${b.date.getDate()}.${b.date.getMonth() + 1}.`}
                  </text>
                </g>
              );
            })}

          {/* hodinové popisky u 0 a 12; čára jen u 0 */}
          {pph > 0 &&
            points.map((p, i) => {
              const d = new Date(p.time);
              const h = d.getHours();
              if (h === 0 || h === 12) {
                return (
                  <g key={`h-${i}`}>
                    {h === 0 && (
                      <line
                        x1={x(i)}
                        y1={TOP_PAD - 6}
                        x2={x(i)}
                        y2={H - 15}
                        stroke="rgba(255,255,255,0.06)"
                        strokeWidth="1"
                      />
                    )}
                    <text x={x(i)} y={H - 3} className="mg-hourlabel">
                      {h}
                    </text>
                  </g>
                );
              }
              return null;
            })}

          {/* srážkové sloupce – malý pruh dole (u ostatních veličin) */}
          {pph > 0 &&
            !isPrecip &&
            precipBars.map((b) => {
              const baseline = H - 16;
              const scale = Math.max(2, precipMax);
              const norm = Math.min(1, Math.pow(b.value / scale, 0.6));
              const hb = Math.max(4, norm * (PRECIP_H - 4));
              const left = x(b.startI) - pph * 0.42;
              const right = x(b.endI) + pph * 0.42;
              // Krytí podle pravděpodobnosti: méně jisté srážky jsou světlejší.
              const opacity = 0.18 + 0.82 * (Math.max(0, b.prob) / 100);
              return (
                <rect
                  key={`p-${b.startI}`}
                  x={left}
                  y={baseline - hb}
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
              const baseline = H - 16;
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
                const hb = Math.max(4, norm * (PRECIP_H - 4));
                out.push({ cx, y: baseline - hb - 3, v: b.value, prob: b.prob });
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
              {cloudBands.map((b, i) => (
                <text
                  key={`cl-${i}`}
                  x={8}
                  y={b.centerY - (CURVE_BOTTOM - TOP_PAD) / 6 + 4}
                  className="mg-bandlabel"
                >
                  {tr(b.label)}
                </text>
              ))}
            </>
          ) : isPrecip ? (
            pph > 0 && (
              <>
                {/* osové linky s hodnotami v mm */}
                {precipTicks.map((t) => (
                  <g key={`pt-${t}`}>
                    <line
                      x1={0}
                      y1={yPrecip(t)}
                      x2={width}
                      y2={yPrecip(t)}
                      stroke="rgba(255,255,255,0.08)"
                      strokeWidth="1"
                    />
                    <text x={6} y={yPrecip(t) - 3} className="mg-bandlabel">
                      {t} mm
                    </text>
                  </g>
                ))}
                {precipThresholds.map((t) => (
                  <g key={`pth-${t.v}`}>
                    <line
                      x1={0}
                      y1={t.y}
                      x2={width}
                      y2={t.y}
                      stroke={t.color}
                      strokeWidth="1"
                      strokeDasharray="4 4"
                      opacity="0.55"
                    />
                    <text
                      x={width - 6}
                      y={t.y - 4}
                      className="mg-uv-thlabel"
                      textAnchor="end"
                      fill={t.color}
                    >
                      {tr(t.label)} ({t.v}+ mm)
                    </text>
                  </g>
                ))}
                {/* bouřkové úseky – svislý pruh s průhledností dle pravděpodobnosti */}
                {stormBars.map((b) => {
                  const left = x(b.startI) - pph * 0.5;
                  const right = x(b.endI) + pph * 0.5;
                  const op = 0.16 + 0.34 * (Math.max(0, b.prob) / 100);
                  const cx = (left + right) / 2;
                  return (
                    <g key={`storm-${b.startI}`}>
                      <rect
                        x={left}
                        y={TOP_PAD}
                        width={Math.max(0, right - left)}
                        height={PRECIP_BASELINE - TOP_PAD}
                        fill="rgba(168,120,255,1)"
                        opacity={op}
                      />
                      <StormBolt
                        x={cx}
                        y={TOP_PAD + 9}
                        hail={b.hail}
                      />
                    </g>
                  );
                })}
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
                {/* hodnoty nad sloupci – hlavně u pravděpodobnějších srážek */}
                {precipBars
                  .filter((b) => precipLabelSet.has(b.startI))
                  .map((b) => {
                    const cx = (x(b.startI) + x(b.endI)) / 2;
                    const top = yPrecip(b.value);
                    return (
                      <text
                        key={`pl-${b.startI}`}
                        x={cx}
                        y={Math.max(TOP_PAD + 8, top - 5)}
                        className="mg-extrema precip"
                        textAnchor="middle"
                        opacity={0.45 + 0.55 * (Math.max(0, b.prob) / 100)}
                      >
                        {fmtPrecip(b.value)}
                      </text>
                    );
                  })}
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
                        y={TOP_PAD}
                        width={Math.max(0, right - left)}
                        height={CURVE_BOTTOM - TOP_PAD}
                        fill="rgba(174,188,207,0.16)"
                      />
                      <g
                        transform={`translate(${cx} ${CURVE_BOTTOM - 20})`}
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
                {uvThresholds.map((t) => (
                  <g key={`uvth-${t.v}`}>
                    <line
                      x1={0}
                      y1={t.y}
                      x2={width}
                      y2={t.y}
                      stroke={t.color}
                      strokeWidth="1"
                      strokeDasharray="4 4"
                      opacity="0.55"
                    />
                    <text
                      x={width - 6}
                      y={t.y - 4}
                      className="mg-uv-thlabel"
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
                      strokeWidth="1"
                      strokeDasharray="4 4"
                      opacity="0.55"
                    />
                    <text
                      x={width - 6}
                      y={t.y - 4}
                      className="mg-uv-thlabel"
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
                      strokeWidth="1"
                      strokeDasharray="4 4"
                      opacity="0.55"
                    />
                    <text
                      x={width - 6}
                      y={t.y - 4}
                      className="mg-uv-thlabel"
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
                      strokeDasharray="2 2"
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
                    stroke={series.secondaryColor}
                    strokeWidth="2.6"
                    strokeLinejoin="round"
                  />
                )}
                {showUvClearSky && series.refLine && refLinePath && (
                  <>
                    <path
                      d={refLinePath}
                      fill="none"
                      stroke={series.refLine.color}
                      strokeWidth="1.8"
                      strokeDasharray="5 4"
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      opacity="0.85"
                    />
                    <text
                      x={x(0) + 4}
                      y={Math.max(
                        TOP_PAD + 10,
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
                    tab === "temp" || tab === "feels"
                      ? "url(#grad-templine)"
                      : tab === "uv"
                        ? "url(#grad-uvline)"
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
                {valueLabelList.map((e) => (
                  <text
                    key={`ex-${e.i}`}
                    x={x(e.i)}
                    y={yCurve(labelValues[e.i]) + (e.kind === "max" ? -8 : 15)}
                    className={`mg-extrema ${labelColor}`}
                    textAnchor="middle"
                  >
                    {series.fmt(labelValues[e.i])}
                  </text>
                ))}
              </>
            )
          )}

          {/* značka "teď" – posouvá se plynule podle času; popisek nahoře,
              schová se, když je blízko kurzoru (aby se nepřekrýval). */}
          {nowX >= 0 && pph > 0 && (
            <>
              <line
                x1={nowX}
                y1={TOP_PAD - 4}
                x2={nowX}
                y2={H - 15}
                stroke={
                  theme === "light"
                    ? "rgba(196,124,0,0.9)"
                    : "rgba(255,209,102,0.7)"
                }
                strokeWidth="1.5"
                strokeDasharray="3 3"
              />
              {Math.abs(nowX - x(ci)) > 44 && (
                <g
                  transform={`translate(${Math.max(17, Math.min(width - 17, nowX))}, ${TOP_PAD - 22})`}
                >
                  <rect
                    x={-16}
                    y={0}
                    width={32}
                    height={15}
                    rx="7.5"
                    fill={theme === "light" ? "#b9750a" : "rgba(255,209,102,0.92)"}
                  />
                  <text
                    x={0}
                    y={11}
                    className="mg-nowlabel"
                    textAnchor="middle"
                    fill={theme === "light" ? "#fff" : undefined}
                  >
                    {tr("Teď")}
                  </text>
                </g>
              )}
            </>
          )}

          {/* časový kurzor */}
          {pph > 0 && (
            <>
              <line
                x1={x(ci)}
                y1={TOP_PAD - 6}
                x2={x(ci)}
                y2={H - 15}
                stroke="rgba(255,255,255,0.85)"
                strokeWidth="1.5"
              />
              {!isCloud && !isPrecip && (
                <circle
                  cx={x(ci)}
                  cy={yCurve(series.primary[ci])}
                  r="4.5"
                  fill="#fff"
                  stroke={
                    tab === "temp" || tab === "feels"
                      ? tempColor(series.primary[ci])
                      : tab === "uv"
                        ? uvColor(series.primary[ci])
                        : series.stroke
                  }
                  strokeWidth="2"
                />
              )}
              {/* popisek vybrané hodiny – nad grafem, pod názvem dne */}
              <g transform={`translate(${tipX}, ${TOP_PAD - 24})`}>
                <rect
                  width={tipW}
                  height={18}
                  rx="6"
                  fill="rgba(12,18,32,0.92)"
                  stroke="rgba(255,255,255,0.18)"
                />
                <text x={tipW / 2} y={13} className="mg-tip" textAnchor="middle">
                  {cursorTimeLabel(active.time)}
                </text>
              </g>
            </>
          )}
        </svg>
      </div>
      </section>
    </>
  );
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
  const prob = day.precipitationProbabilityMax ?? 0;
  const precipOp = day.precipitationSum > 0 ? 0.3 + 0.7 * (prob / 100) : 0.4;
  const hasFeels = feelsMax != null && feelsMin != null;
  const tier = tempTier(feelsMax ?? day.tempMax);
  return (
    <div className="mg-daysum">
      <WeatherIcon kind={info.icon} isDay size={36} />
      <div className="mg-daysum-main">
        <strong className="mg-daysum-temp">
          <span style={{ color: tempColor(day.tempMin) }}>
            {Math.round(day.tempMin)}°
          </span>
          <span className="mg-daysum-sep"> / </span>
          <span style={{ color: tempColor(day.tempMax) }}>
            {Math.round(day.tempMax)}°
          </span>
        </strong>
        {hasFeels && (
          <span className="mg-daysum-feels">
            {tr("pocitově")} {Math.round(feelsMin!)}° / {Math.round(feelsMax!)}°
          </span>
        )}
      </div>
      {!hideTone && (
        <span
          className="mg-daysum-tone"
          style={{ background: TIER_COLOR[tier] }}
        >
          {tr(TIER_LABEL[tier])}
        </span>
      )}
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

// Panel s ikonami pro hodinu pod kurzorem – pevné rozložení, nehýbe se.
function StatReadout({
  p,
  tab,
  onTab,
  pressureDelta,
  visible,
  range,
}: {
  p: HourlyPoint;
  tab: Tab;
  onTab: (t: Tab) => void;
  pressureDelta: number;
  visible: (t: Tab) => boolean;
  range?: { min: number; max: number } | null;
}) {
  const info = describeWeather(p.weatherCode);

  // Rovnoměrné rozložení dlaždic do řádků: zjistíme, kolik sloupců se vejde na
  // šířku, a pak počet sloupců snížíme tak, aby při stejném počtu řádků byly
  // řádky co nejvyrovnanější (např. 9 položek → 3+3+3 místo 4+4+1).
  const wrapRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(0);
  const count = ALL_TABS.filter((t) => visible(t)).length;
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const MIN = 132;
    const compute = () => {
      const w = el.clientWidth;
      if (!w || count === 0) {
        setCols(0);
        return;
      }
      const gap = parseFloat(getComputedStyle(el).columnGap) || 10;
      const maxCols = Math.max(1, Math.floor((w + gap) / (MIN + gap)));
      const capped = Math.min(maxCols, count);
      const rows = Math.ceil(count / capped);
      setCols(Math.ceil(count / rows));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [count]);

  return (
    <div
      className="mg-stats"
      ref={wrapRef}
      style={
        cols
          ? ({
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            } as CSSProperties)
          : undefined
      }
    >
      {visible("temp") && (
        <button
          type="button"
          className={`mg-stat mg-stat-btn ${tab === "temp" ? "active" : ""} ${tempFlag(p.temperature)}`}
          onClick={() => onTab("temp")}
          aria-pressed={tab === "temp"}
          title={tr("Zobrazit graf teploty")}
        >
          <WeatherIcon kind={info.icon} isDay={p.isDay} size={30} />
          <div className="mg-stat-v">
            <strong style={{ color: tempColor(p.temperature) }}>
              {Math.round(p.temperature)}°
            </strong>
            <span>
              {tr("teplota")}
              {tab === "temp" && range && (
                <em className="mg-stat-range">
                  {" "}
                  {Math.round(range.min)}–{Math.round(range.max)}°
                </em>
              )}
            </span>
          </div>
        </button>
      )}

      {visible("feels") && (
        <button
          type="button"
          className={`mg-stat mg-stat-btn ${tab === "feels" ? "active" : ""} ${tempFlag(p.apparentTemperature)}`}
          onClick={() => onTab("feels")}
          aria-pressed={tab === "feels"}
          title={tr("Zobrazit graf pocitové teploty")}
        >
          <PersonGlyph />
          <div className="mg-stat-v">
            <strong style={{ color: tempColor(p.apparentTemperature) }}>
              {Math.round(p.apparentTemperature)}°
            </strong>
            <span>
              {tr("pocitově")}
              {tab === "feels" && range && (
                <em className="mg-stat-range">
                  {" "}
                  {Math.round(range.min)}–{Math.round(range.max)}°
                </em>
              )}
            </span>
          </div>
        </button>
      )}

      {visible("precip") && (
        <button
          type="button"
          className={`mg-stat mg-stat-btn mg-stat-precip ${tab === "precip" ? "active" : ""} ${p.precipitation > 0 ? "flag-wet" : ""}`}
          onClick={() => onTab("precip")}
          aria-pressed={tab === "precip"}
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
      )}

      {visible("wind") && (
        <button
          type="button"
          className={`mg-stat mg-stat-btn ${tab === "wind" ? "active" : ""} ${windFlag(p.windSpeed, p.windGusts)}`}
          onClick={() => onTab("wind")}
          aria-pressed={tab === "wind"}
          title={tr("Zobrazit graf větru")}
        >
          <WindGlyph />
          <div className="mg-stat-v">
            <strong>{p.windSpeed.toFixed(0)} m/s</strong>
            <span>{tr("vítr (nárazy {g} m/s)", { g: p.windGusts.toFixed(0) })}</span>
          </div>
        </button>
      )}

      {visible("uv") && (
        <button
          type="button"
          className={`mg-stat mg-stat-btn ${tab === "uv" ? "active" : ""} ${uvFlag(p.uvIndex)}`}
          onClick={() => onTab("uv")}
          aria-pressed={tab === "uv"}
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
      )}

      {visible("cloud") && (
        <button
          type="button"
          className={`mg-stat mg-stat-btn ${tab === "cloud" ? "active" : ""}`}
          onClick={() => onTab("cloud")}
          aria-pressed={tab === "cloud"}
          title={tr("Zobrazit graf oblačnosti")}
        >
          <CloudGlyph />
          <div className="mg-stat-v">
            <strong>{Math.round(p.cloudCover)} %</strong>
            <span>{tr("oblačnost")}</span>
          </div>
        </button>
      )}

      {visible("humidity") && (
        <button
          type="button"
          className={`mg-stat mg-stat-btn ${tab === "humidity" ? "active" : ""} ${p.humidity >= 90 ? "flag-humid" : ""}`}
          onClick={() => onTab("humidity")}
          aria-pressed={tab === "humidity"}
          title={tr("Zobrazit graf vlhkosti")}
        >
          <HumidGlyph />
          <div className="mg-stat-v">
            <strong>{Math.round(p.humidity)} %</strong>
            <span>{tr("vlhkost")}</span>
          </div>
        </button>
      )}

      {visible("dewpoint") &&
        (() => {
          const fog = fogRisk(p.temperature, p.dewPoint);
          return (
            <button
              type="button"
              className={`mg-stat mg-stat-btn ${tab === "dewpoint" ? "active" : ""} ${fog ? "flag-fog" : ""}`}
              onClick={() => onTab("dewpoint")}
              aria-pressed={tab === "dewpoint"}
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
        })()}

      {visible("pressure") && (
        <button
          type="button"
          className={`mg-stat mg-stat-btn ${tab === "pressure" ? "active" : ""}`}
          onClick={() => onTab("pressure")}
          aria-pressed={tab === "pressure"}
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
      )}
    </div>
  );
}

// Barva podle úrovně UV (WHO škála): nízké / střední / vysoké / velmi vysoké.
function uvBandColor(uv: number): string {
  if (uv >= 8) return "#d94ea6";
  if (uv >= 6) return "#ff6b6b";
  if (uv >= 3) return "#f0a33c";
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
  }
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

function EyeGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.7" />
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

function StormBolt({ x, y, hail }: { x: number; y: number; hail: boolean }) {
  return (
    <g transform={`translate(${x - 7} ${y - 7})`} opacity="0.95">
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
    </g>
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

function buildSeries(tab: Tab, points: HourlyPoint[]): SeriesConfig {
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
    const uv = points.map((p) => (Number.isFinite(p.uvIndex) ? p.uvIndex : 0));
    // UV bez oblačnosti (clear-sky) jako referenční čára – rozdíl vůči reálnému
    // UV ukazuje, kolik ubraly mraky. Když chybí, spadneme na reálné UV.
    const clear = points.map((p, i) =>
      Number.isFinite(p.uvIndexClearSky) ? p.uvIndexClearSky : uv[i],
    );
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
    const lo = Math.min(...feels);
    const hi = Math.max(...feels);
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
  const lo = Math.min(...temps);
  const hi = Math.max(...temps);
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
    if (values[i] > values[i - 1] && values[i] >= values[i + 1])
      cands.push({ i, kind: "max", prio: 3 });
    else if (values[i] < values[i - 1] && values[i] <= values[i + 1])
      cands.push({ i, kind: "min", prio: 3 });
  }
  cands.push({ i: 0, kind: localKind(0), prio: 2 });
  cands.push({ i: n - 1, kind: localKind(n - 1), prio: 2 });
  points.forEach((p, i) => {
    if (new Date(p.time).getHours() % 6 === 0)
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
  const btnRef = useRef<HTMLButtonElement>(null);
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
      <button
        ref={btnRef}
        type="button"
        className="mg-info-btn"
        onClick={() => setOpen((o) => !o)}
        aria-label={text}
        title={text}
      >
        ?
      </button>
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

function cursorTimeLabel(iso: string): string {
  const d = new Date(iso);
  return `${dayShort()[d.getDay()]}, ${d.getHours()}:00`;
}

// Popisek dne + hodiny pro nadpis meteogramu (Dnes/Zítra/Včera + čas).
function cursorDayTimeLabel(iso: string): string {
  const d = new Date(iso);
  return `${dayHeader(iso)} ${d.getHours()}:00`;
}

function dayShortLabel(date: string): string {
  const d = new Date(date + "T12:00:00");
  return `${dayShort()[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}.`;
}

