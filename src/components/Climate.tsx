import posthog from "posthog-js";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { monthIn, monthLong, monthShort } from "../lib/format";
import { getLang, tr } from "../lib/i18n";
import {
  fetchClimateNormals,
  reverseGeocode,
  type MonthlyClimate,
} from "../lib/openMeteo";
import { tempColor } from "../lib/tempColor";
import { useStoredState } from "../lib/useStoredState";
import type { GeoLocation } from "../types";
import { sameLocation } from "./FavoritesBar";
import InfoHint from "./InfoHint";
import SearchBar from "./SearchBar";

interface Props {
  location: GeoLocation;
  favorites: GeoLocation[];
  history: GeoLocation[];
  isCurrentFav: boolean;
  onToggleCurrent: () => void;
  onToggleFavorite: (loc: GeoLocation) => void;
  onRemove: (loc: GeoLocation) => void;
  onRename: (loc: GeoLocation, name: string) => void;
  onPushHistory: (loc: GeoLocation) => void;
  onClearHistory: () => void;
  onChangeLocation: () => void;
}

const MAX_COMPARE = 10;

function round1(n: number): string {
  return n.toLocaleString(getLang() === "en" ? "en-GB" : "cs-CZ", {
    maximumFractionDigits: 1,
    minimumFractionDigits: n % 1 === 0 ? 0 : 1,
  });
}

function pickMonth(raw: number, fallback: number): number {
  if (!Number.isInteger(raw) || raw < 1 || raw > 12) return fallback;
  return raw;
}

function deg(n: number | null): string {
  return n == null ? "—" : `${Math.round(n)}°`;
}

function amountStyle(n: number, cap: number): CSSProperties {
  const t = Math.min(1, Math.max(0, n / cap));
  return {
    fontSize: `${(0.64 + t * 0.72).toFixed(3)}rem`,
    fontWeight: Math.round(480 + t * 320),
  };
}

function monthFeel(tempMax: number | null): string | null {
  if (tempMax == null || !Number.isFinite(tempMax)) return null;
  if (tempMax >= 30) return "Horko";
  if (tempMax >= 25) return "Teplo";
  if (tempMax >= 18) return "Příjemně";
  if (tempMax >= 11) return "Svěží";
  if (tempMax >= 4) return "Chladno";
  if (tempMax >= -4) return "Studeno";
  return "Mrazivo";
}

type ClimateColId = "night" | "day" | "mm" | "rain" | "sun" | "feel";

const CLIMATE_COLS: {
  id: ClimateColId;
  head: string;
  hint: string;
  track: string;
}[] = [
  {
    id: "night",
    head: "Noc",
    hint: "Průměr denních minim za měsíc (2010–2024). Není to teplota jen v noci, ale typické nejnižší hodnoty.",
    track: "3rem",
  },
  {
    id: "day",
    head: "Den",
    hint: "Průměr denních maxim za měsíc (2010–2024). Typická odpolední teplota.",
    track: "3rem",
  },
  {
    id: "mm",
    head: "Srážky",
    hint: "Průměrný úhrn srážek za celý měsíc v milimetrech (déšť i sníh).",
    track: "3.8rem",
  },
  {
    id: "rain",
    head: "Deštivých dní",
    hint: "Kolik dní v měsíci v průměru naprší aspoň 1 mm.",
    track: "4.2rem",
  },
  {
    id: "sun",
    head: "Slunečných dní",
    hint: "Kolik dní v měsíci v průměru má oblačnost pod 50 %.",
    track: "4.3rem",
  },
  {
    id: "feel",
    head: "Pocit",
    hint: "Orientační pocit podle průměrného denního maxima — horko, teplo, příjemně, svěží, chladno, studeno nebo mrazivo.",
    track: "5.2rem",
  },
];

const DEFAULT_COMPARE_COLS: ClimateColId[] = ["night", "day", "mm", "sun"];
const COL_ID_SET = new Set<string>(CLIMATE_COLS.map((c) => c.id));
const COL_HCLASS: Record<ClimateColId, string> = {
  night: "climate-h-temp",
  day: "climate-h-temp",
  mm: "climate-h-mm",
  rain: "climate-h-rain",
  sun: "climate-h-sun",
  feel: "climate-h-feel",
};

function expandStoredCol(id: unknown): ClimateColId[] {
  if (id === "temp") return ["night", "day"];
  if (typeof id === "string" && COL_ID_SET.has(id)) return [id as ClimateColId];
  return [];
}

function sanitizeCompareCols(raw: unknown): ClimateColId[] {
  if (!Array.isArray(raw)) return DEFAULT_COMPARE_COLS;
  const picked = new Set(raw.flatMap(expandStoredCol));
  const ordered = CLIMATE_COLS.map((c) => c.id).filter((id) => picked.has(id));
  return ordered.length ? ordered : DEFAULT_COMPARE_COLS;
}

function isGeoLocation(v: unknown): v is GeoLocation {
  if (!v || typeof v !== "object") return false;
  const loc = v as GeoLocation;
  return (
    typeof loc.name === "string" &&
    Number.isFinite(loc.latitude) &&
    Number.isFinite(loc.longitude)
  );
}

function sanitizeCompareList(raw: unknown): GeoLocation[] {
  const src: GeoLocation[] = Array.isArray(raw)
    ? raw.filter(isGeoLocation)
    : isGeoLocation(raw)
    ? [raw]
    : [];
  const out: GeoLocation[] = [];
  for (const loc of src) {
    if (out.some((x) => sameLocation(x, loc))) continue;
    out.push(loc);
    if (out.length >= MAX_COMPARE) break;
  }
  return out;
}

function placeKey(loc: GeoLocation): string {
  return `${loc.latitude.toFixed(3)},${loc.longitude.toFixed(3)}`;
}

function extraBits(
  data: MonthlyClimate,
  hide: ReadonlySet<ClimateColId> = new Set()
): string {
  const rain = data.rainyDays != null ? Math.round(data.rainyDays) : null;
  const sun = data.sunnyDays != null ? Math.round(data.sunnyDays) : null;
  const hours = data.sunshineHours;
  const snow =
    data.snowCm != null && data.snowCm >= 5 ? Math.round(data.snowCm) : null;
  const bits: string[] = [];
  if (rain != null && !hide.has("rain")) {
    bits.push(tr("{n} deštivých dní", { n: rain }));
  }
  if (sun != null && !hide.has("sun")) {
    bits.push(tr("{n} slunečných dní", { n: sun }));
  }
  if (hours != null) bits.push(tr("{n} h slunce denně", { n: round1(hours) }));
  if (snow != null) bits.push(tr("sníh {n} cm", { n: snow }));
  return bits.join(" · ");
}

function climateDist(
  a: MonthlyClimate,
  b: MonthlyClimate,
  cols: ClimateColId[]
): number | null {
  if (a.tempMax == null || a.tempMin == null) return null;
  if (b.tempMax == null || b.tempMin == null) return null;
  let s = (a.tempMax - b.tempMax) ** 2 + (a.tempMin - b.tempMin) ** 2;
  if (cols.includes("mm") && a.precipMm != null && b.precipMm != null) {
    s += ((a.precipMm - b.precipMm) / 28) ** 2;
  }
  if (cols.includes("rain") && a.rainyDays != null && b.rainyDays != null) {
    s += ((a.rainyDays - b.rainyDays) / 5) ** 2;
  }
  if (cols.includes("sun") && a.sunnyDays != null && b.sunnyDays != null) {
    s += ((a.sunnyDays - b.sunnyDays) / 5) ** 2;
  }
  return Math.sqrt(s);
}

const ALIKE_MAX_DIST = 8;

type AlikeHit = { month: number; strength: number };

function similarMonths(
  source: MonthlyClimate,
  rows: MonthlyClimate[],
  cols: ClimateColId[]
): AlikeHit[] {
  const scored: { month: number; d: number }[] = [];
  for (const row of rows) {
    const d = climateDist(source, row, cols);
    if (d == null) continue;
    scored.push({ month: row.month, d });
  }
  if (!scored.length) return [];
  scored.sort((a, b) => a.d - b.d);
  if (scored[0].d > ALIKE_MAX_DIST) return [];
  const out: AlikeHit[] = [];
  for (const s of scored) {
    if (out.length >= 3) break;
    if (s.d > ALIKE_MAX_DIST) break;
    const t = Math.max(0, 1 - s.d / ALIKE_MAX_DIST);
    out.push({
      month: s.month,
      strength: 0.1 + 0.9 * t * t,
    });
  }
  return out;
}

function monthListLabel(months: number[]): string {
  return months
    .map((m) =>
      getLang() === "en"
        ? monthLong(m)
        : monthLong(m).toLocaleLowerCase("cs-CZ")
    )
    .join(", ");
}

type ClimateLoad = {
  rows: MonthlyClimate[] | null;
  loading: boolean;
  failed: boolean;
};

function useMonthlyClimate(
  lat: number | null,
  lon: number | null,
  retry: number
) {
  const [rows, setRows] = useState<MonthlyClimate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const key =
    lat != null && lon != null ? `${lat.toFixed(2)},${lon.toFixed(2)}` : null;

  useEffect(() => {
    if (lat == null || lon == null) {
      setRows(null);
      setLoading(false);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setRows(null);
    setLoading(true);
    setFailed(false);
    fetchClimateNormals(lat, lon)
      .then((n) => {
        if (cancelled) return;
        setRows(n.monthly);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setRows(null);
        setFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key, lat, lon, retry]);

  return { rows, loading, failed };
}

function useClimateBundle(places: GeoLocation[], retry: number) {
  const [map, setMap] = useState<Record<string, ClimateLoad>>({});
  const sig = places.map(placeKey).join("|");

  useEffect(() => {
    if (!places.length) {
      setMap({});
      return;
    }
    let cancelled = false;
    const keys = places.map(placeKey);
    setMap((prev) => {
      const next: Record<string, ClimateLoad> = {};
      for (const k of keys) {
        next[k] = {
          rows: prev[k]?.rows ?? null,
          loading: true,
          failed: false,
        };
      }
      return next;
    });
    Promise.all(
      places.map(async (loc) => {
        const k = placeKey(loc);
        try {
          const n = await fetchClimateNormals(loc.latitude, loc.longitude);
          return { k, rows: n.monthly, failed: false };
        } catch {
          return { k, rows: null as MonthlyClimate[] | null, failed: true };
        }
      })
    ).then((results) => {
      if (cancelled) return;
      setMap(() => {
        const next: Record<string, ClimateLoad> = {};
        for (const r of results) {
          next[r.k] = { rows: r.rows, loading: false, failed: r.failed };
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [sig, retry]);

  return map;
}

export default function Climate({
  location,
  favorites,
  history,
  isCurrentFav,
  onToggleCurrent,
  onToggleFavorite,
  onRemove,
  onRename,
  onPushHistory,
  onClearHistory,
  onChangeLocation,
}: Props) {
  const nowMonth = new Date().getMonth() + 1;
  const [month, setMonth] = useStoredState<number>(
    "zmoknu.climateMonth",
    nowMonth
  );
  const selected = pickMonth(month, nowMonth);
  const [retry, setRetry] = useState(0);
  const [compareRetry, setCompareRetry] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [replaceIndex, setReplaceIndex] = useState<number | null>(null);
  const [locating, setLocating] = useState(false);
  const [storedCompare, setStoredCompare] = useStoredState<unknown>(
    "zmoknu.climateCompare",
    null
  );
  const [storedCols, setStoredCols] = useStoredState<ClimateColId[]>(
    "zmoknu.climateCompareCols",
    DEFAULT_COMPARE_COLS
  );
  const [colsOpen, setColsOpen] = useState(false);
  const colsRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const [wide, setWide] = useState(false);
  const compareCols = useMemo(
    () => sanitizeCompareCols(storedCols),
    [storedCols]
  );
  const compareTracks = compareCols
    .map((id) => CLIMATE_COLS.find((c) => c.id === id)?.track ?? "")
    .join(" ");
  const compareList = useMemo(() => {
    return sanitizeCompareList(storedCompare).filter(
      (l) => !sameLocation(l, location)
    );
  }, [storedCompare, location]);

  useEffect(() => {
    if (!colsOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!colsRef.current?.contains(e.target as Node)) setColsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setColsOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [colsOpen]);

  const here = useMonthlyClimate(location.latitude, location.longitude, retry);
  const others = useClimateBundle(compareList, compareRetry);
  const hereKey = placeKey(location);
  const [alikePlace, setAlikePlace] = useState<string | null>(null);

  useEffect(() => {
    const list = sanitizeCompareList(storedCompare);
    const next = list.filter((l) => !sameLocation(l, location));
    if (next.length !== list.length) setStoredCompare(next);
  }, [location, storedCompare, setStoredCompare]);

  useEffect(() => {
    if (!alikePlace) return;
    if (alikePlace === hereKey) return;
    if (!compareList.some((l) => placeKey(l) === alikePlace)) {
      setAlikePlace(null);
    }
  }, [alikePlace, compareList, hereKey]);

  const selectMonth = (m: number) => {
    if (m === selected) return;
    setMonth(m);
    posthog.capture("climate_month_changed", { month: m });
  };

  const applyCompare = (loc: GeoLocation) => {
    if (sameLocation(loc, location)) {
      if (replaceIndex != null) {
        setStoredCompare((prev: unknown) =>
          sanitizeCompareList(prev).filter((_, i) => i !== replaceIndex)
        );
      }
      setReplaceIndex(null);
      return;
    }
    setStoredCompare((prev: unknown) => {
      const list = sanitizeCompareList(prev).filter(
        (l) => !sameLocation(l, location)
      );
      if (
        replaceIndex != null &&
        replaceIndex >= 0 &&
        replaceIndex < list.length
      ) {
        if (list.some((l, i) => i !== replaceIndex && sameLocation(l, loc))) {
          return list.filter((_, i) => i !== replaceIndex);
        }
        const next = [...list];
        next[replaceIndex] = loc;
        return next;
      }
      if (list.some((l) => sameLocation(l, loc))) return list;
      if (list.length >= MAX_COMPARE) return list;
      return [...list, loc];
    });
    posthog.capture("climate_compare_set", {
      count: Math.min(MAX_COMPARE, compareList.length + 1),
    });
    setReplaceIndex(null);
  };

  const removeCompare = (index: number) => {
    setColsOpen(false);
    setStoredCompare((prev: unknown) =>
      sanitizeCompareList(prev).filter((_, i) => i !== index)
    );
    posthog.capture("climate_compare_removed", {
      count: Math.max(0, compareList.length - 1),
    });
  };

  const openPicker = (index: number | null = null) => {
    if (index == null && compareList.length >= MAX_COMPARE) return;
    setColsOpen(false);
    setReplaceIndex(index);
    setPickerOpen(true);
    posthog.capture("climate_compare_opened");
  };

  const toggleCompareCol = (id: ClimateColId) => {
    const next = compareCols.includes(id)
      ? compareCols.filter((c) => c !== id)
      : sanitizeCompareCols([...compareCols, id]);
    if (!next.length) return;
    setStoredCols(next);
    posthog.capture("climate_compare_cols_changed", {
      cols: next.join(","),
    });
  };

  const locateCompare = () => {
    if (!navigator.geolocation) return;
    setLocating(true);
    setPickerOpen(false);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        let name = `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
        try {
          const rev = await reverseGeocode(latitude, longitude);
          if (rev && rev !== "Moje poloha") name = rev;
        } catch {
          /* název necháme jako souřadnice */
        }
        const loc: GeoLocation = { name, latitude, longitude };
        onPushHistory(loc);
        applyCompare(loc);
        setLocating(false);
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  const comparing = compareList.length > 0;
  const placeCount = 1 + compareList.length;
  const rows = here.rows;

  useEffect(() => {
    if (!comparing) {
      setWide(false);
      return;
    }
    const card = cardRef.current;
    if (!card) return;
    const table = card.querySelector(".climate-table");
    const frozen = card.querySelector(".climate-frozen");
    if (!(table instanceof HTMLElement)) return;

    const measure = () => {
      const app = card.closest(".app");
      if (!app) return;
      const pad =
        parseFloat(getComputedStyle(app).paddingLeft) +
        parseFloat(getComputedStyle(app).paddingRight);
      const appMax =
        parseFloat(getComputedStyle(app).getPropertyValue("--app-max")) || 1460;
      const cap = Math.min(app.clientWidth, appMax - pad);
      const prevMin = table.style.minWidth;
      table.style.minWidth = "max-content";
      const needed =
        (frozen instanceof HTMLElement ? frozen.offsetWidth : 0) +
        table.scrollWidth;
      table.style.minWidth = prevMin;
      setWide(needed > cap + 8);
    };

    measure();
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(table);
    if (frozen instanceof HTMLElement) ro.observe(frozen);
    window.addEventListener("resize", schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [comparing, placeCount, compareTracks, rows]);
  const current = rows?.find((r) => r.month === selected) ?? null;
  const extraHide = useMemo(() => new Set(compareCols), [compareCols]);
  const otherFailed = compareList.some((loc) => others[placeKey(loc)]?.failed);
  const pickerTitle =
    replaceIndex != null
      ? tr("Změnit porovnávané místo")
      : comparing
      ? tr("Přidat místo ke srovnání")
      : tr("Porovnat s místem");

  const extraLines = (() => {
    if (!current) return [];
    const lines = [
      {
        name: location.name,
        bits: extraBits(current, extraHide),
      },
    ];
    if (!comparing) return lines;
    for (const loc of compareList) {
      const data = others[placeKey(loc)]?.rows?.find(
        (r) => r.month === selected
      );
      lines.push({
        name: loc.name,
        bits: data ? extraBits(data, extraHide) : "",
      });
    }
    return lines;
  })();

  const srcKey = alikePlace ?? hereKey;
  const srcLoc =
    srcKey === hereKey
      ? location
      : compareList.find((l) => placeKey(l) === srcKey) ?? location;
  const srcRows = srcKey === hereKey ? here.rows : others[srcKey]?.rows ?? null;
  const srcMonthRow = srcRows?.find((r) => r.month === selected) ?? null;

  const alikeByPlace = useMemo(() => {
    const map: Record<string, AlikeHit[]> = {};
    if (!comparing || !srcMonthRow) return map;
    const targets = [location, ...compareList];
    for (const loc of targets) {
      const k = placeKey(loc);
      if (k === srcKey) continue;
      const rowsFor = k === hereKey ? here.rows : others[k]?.rows;
      if (!rowsFor) continue;
      map[k] = similarMonths(srcMonthRow, rowsFor, compareCols);
    }
    return map;
  }, [
    comparing,
    srcMonthRow,
    srcKey,
    hereKey,
    here.rows,
    location,
    compareList,
    others,
    compareCols,
  ]);

  const pairAlike = (key: string, month: number) => {
    if (srcKey === key && month === selected) {
      return { alike: "src" as const, alikeN: 1 };
    }
    const hit = alikeByPlace[key]?.find((h) => h.month === month);
    if (hit) return { alike: "match" as const, alikeN: hit.strength };
    return { alike: null, alikeN: 0 };
  };
  const monthAlikeN = (month: number) => {
    let n = 0;
    for (const hits of Object.values(alikeByPlace)) {
      for (const h of hits) {
        if (h.month === month && h.strength > n) n = h.strength;
      }
    }
    return n;
  };

  const pickCluster = (key: string, month: number) => {
    setAlikePlace(key);
    if (month !== selected) {
      setMonth(month);
      posthog.capture("climate_month_changed", { month });
    }
    posthog.capture("climate_alike_picked", { month });
  };

  return (
    <section
      ref={cardRef}
      className={`card climate-card${comparing ? " compare" : ""}${
        wide ? " climate-wide" : ""
      }`}
      data-n={compareCols.length}
      data-places={comparing ? placeCount : undefined}
      style={
        {
          "--climate-tracks": compareTracks,
          "--climate-n": String(compareCols.length),
          ...(comparing
            ? { "--climate-places": String(placeCount) }
            : {}),
        } as CSSProperties
      }
    >
      <div className="climate-head">
        <h2 className="card-title climate-title">
          {tr("Počasí během roku")}
          <span className="climate-title-hint">
            <InfoHint label={tr("Odkud jsou průměrné hodnoty")} wide>
              <p>
                {tr(
                  "Průměr z let 2010–2024 (NASA POWER). Deštivý den = aspoň 1 mm srážek, slunečný den = oblačnost pod 50 %. Hodí se, když plánuješ výlet na konkrétní měsíc."
                )}
              </p>
            </InfoHint>
          </span>
        </h2>
        <div className="climate-head-actions">
          {compareList.length < MAX_COMPARE && (
            <button
              type="button"
              className="mg-view-btn climate-compare-btn"
              onClick={() => openPicker(null)}
              aria-label={
                comparing
                  ? tr("Přidat místo ke srovnání")
                  : tr("Porovnat")
              }
              title={
                comparing
                  ? tr("Přidat místo ke srovnání")
                  : tr("Porovnat")
              }
            >
              <PlusGlyph />
              {!comparing && (
                <span className="climate-compare-lab">{tr("Porovnat")}</span>
              )}
            </button>
          )}
          <div className="climate-cols-settings" ref={colsRef}>
            <button
              type="button"
              className={`mg-view-btn${colsOpen ? " active" : ""}`}
              onClick={() => setColsOpen((o) => !o)}
              aria-expanded={colsOpen}
              aria-label={tr("Sloupce ve srovnání")}
              title={tr("Sloupce ve srovnání")}
            >
              <GearGlyph />
            </button>
            {colsOpen && (
              <div className="climate-cols-menu" role="dialog">
                <span className="yr-settings-label">
                  {tr("Sloupce ve srovnání")}
                </span>
                {CLIMATE_COLS.map((col) => {
                  const on = compareCols.includes(col.id);
                  return (
                    <label key={col.id} className="mg-view-toggle">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={on && compareCols.length === 1}
                        onChange={() => toggleCompareCol(col.id)}
                      />
                      <span>{tr(col.head)}</span>
                      <InfoHint label={tr(col.head)} wide>
                        <p>{tr(col.hint)}</p>
                      </InfoHint>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <SearchBar
        open={pickerOpen}
        onClose={() => {
          setPickerOpen(false);
          setReplaceIndex(null);
        }}
        current={location}
        onSelect={applyCompare}
        onLocate={locateCompare}
        locating={locating}
        favorites={favorites}
        isCurrentFav={isCurrentFav}
        onToggleCurrent={onToggleCurrent}
        onToggleFavorite={onToggleFavorite}
        onRemove={onRemove}
        onRename={onRename}
        history={history}
        onPushHistory={onPushHistory}
        onClearHistory={onClearHistory}
        title={pickerTitle}
      />

      {here.loading && <ClimateSkeleton compare={comparing} />}

      {here.failed && (
        <div className="climate-error">
          <span>
            {tr(
              "Počasí během roku se nepodařilo načíst. Zkus to prosím znovu."
            )}
          </span>
          <button
            type="button"
            className="nodata-switch"
            onClick={() => setRetry((n) => n + 1)}
          >
            {tr("Zkusit znovu")}
          </button>
        </div>
      )}

      {comparing && otherFailed && (
        <div className="climate-error">
          <span>{tr("Některá porovnávaná místa se nepodařilo načíst.")}</span>
          <button
            type="button"
            className="nodata-switch"
            onClick={() => setCompareRetry((n) => n + 1)}
          >
            {tr("Zkusit znovu")}
          </button>
        </div>
      )}

      {rows && comparing && (
        <div className="climate-split">
          <div className="climate-frozen" aria-hidden="true">
            <div className="climate-frozen-h" />
            {rows.map((r) => {
              const active = r.month === selected;
              const isNow = r.month === nowMonth;
              const alikeN = monthAlikeN(r.month);
              const alikeName = alikeN > 0 && r.month !== selected;
              return (
                <button
                  key={r.month}
                  type="button"
                  tabIndex={-1}
                  className={`climate-row${active ? " active" : ""}${
                    isNow ? " now" : ""
                  }${alikeName ? " alike" : ""}`}
                  style={
                    alikeName
                      ? ({ ["--alike"]: String(alikeN) } as CSSProperties)
                      : undefined
                  }
                  onClick={() => pickCluster(srcKey, r.month)}
                >
                  <span className="climate-name">
                    <span className="climate-name-short">
                      {monthShort(r.month)}
                    </span>
                    <span className="climate-name-full">
                      {monthLong(r.month)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="climate-scroll">
            <div
              className="climate-table"
              role="listbox"
              aria-label={tr("Vybrat měsíc")}
            >
              <div className="climate-cols">
                <PlaceClusterHead
                  loc={location}
                  cols={compareCols}
                  onChange={() => {
                    setPickerOpen(false);
                    setReplaceIndex(null);
                    setColsOpen(false);
                    onChangeLocation();
                  }}
                />
                {compareList.map((loc, i) => (
                  <PlaceClusterHead
                    key={placeKey(loc)}
                    loc={loc}
                    cols={compareCols}
                    other
                    onChange={() => openPicker(i)}
                    onRemove={() => removeCompare(i)}
                  />
                ))}
              </div>
              {rows.map((r) => {
                const active = r.month === selected;
                const isNow = r.month === nowMonth;
                return (
                  <div
                    key={r.month}
                    role="option"
                    tabIndex={0}
                    aria-selected={active}
                    aria-label={monthLong(r.month)}
                    className={`climate-row${active ? " active" : ""}${
                      isNow ? " now" : ""
                    }`}
                    onClick={() => pickCluster(srcKey, r.month)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        pickCluster(srcKey, r.month);
                      }
                    }}
                  >
                    <PlacePair
                      cols={compareCols}
                      row={r}
                      {...pairAlike(hereKey, r.month)}
                      onPick={() => pickCluster(hereKey, r.month)}
                    />
                    {compareList.map((loc) => {
                      const k = placeKey(loc);
                      const load = others[k];
                      if (!load || load.loading) {
                        return (
                          <span key={k} className="climate-side climate-side-b">
                            {compareCols.map((id) => (
                              <span key={id} className="skel skel-line sm" />
                            ))}
                          </span>
                        );
                      }
                      const otherRow =
                        load.rows?.find((o) => o.month === r.month) ?? null;
                      return (
                        <PlacePair
                          key={k}
                          cols={compareCols}
                          row={otherRow}
                          other
                          {...pairAlike(k, r.month)}
                          onPick={() => pickCluster(k, r.month)}
                        />
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {rows && comparing && srcMonthRow && (
        <AlikeNote
          srcName={srcLoc.name}
          when={monthIn(selected)}
          matches={[location, ...compareList]
            .filter((l) => placeKey(l) !== srcKey)
            .map((l) => ({
              name: l.name,
              months: (alikeByPlace[placeKey(l)] ?? []).map((h) => h.month),
            }))
            .filter((m) => m.months.length)}
        />
      )}

      {rows && !comparing && (
        <div
          className="climate-table"
          role="listbox"
          aria-label={tr("Vybrat měsíc")}
        >
          <div className="climate-cols" aria-hidden="true">
            <span />
            {compareCols.map((id) => (
              <ColHead key={id} id={id} />
            ))}
          </div>
          {rows.map((r) => {
            const active = r.month === selected;
            const isNow = r.month === nowMonth;
            return (
              <button
                key={r.month}
                type="button"
                role="option"
                aria-selected={active}
                className={`climate-row${active ? " active" : ""}${
                  isNow ? " now" : ""
                }`}
                onClick={() => selectMonth(r.month)}
              >
                <span className="climate-name">
                  <span className="climate-name-short">
                    {monthShort(r.month)}
                  </span>
                  <span className="climate-name-full">
                    {monthLong(r.month)}
                  </span>
                </span>
                {compareCols.map((id) => compareCell(id, r))}
              </button>
            );
          })}
        </div>
      )}

      {current && !here.loading && (
        <ClimateExtra whenMonth={current.month} lines={extraLines} />
      )}
    </section>
  );
}

function DegCell({ n }: { n: number | null }) {
  return (
    <span
      className="climate-temp"
      style={n != null ? { color: tempColor(n) } : undefined}
    >
      {deg(n)}
    </span>
  );
}

function MmCell({ mm }: { mm: number | null }) {
  const n = mm != null ? Math.round(mm) : null;
  if (n == null) return <span className="climate-mm">—</span>;
  return (
    <span className="climate-mm" title={`${n} mm`}>
      <strong style={amountStyle(n, 90)}>{n}</strong>
      <em>mm</em>
    </span>
  );
}

function FeelCell({ tempMax }: { tempMax: number | null }) {
  const label = monthFeel(tempMax);
  return (
    <span
      className="climate-feel"
      style={tempMax != null ? { color: tempColor(tempMax) } : undefined}
    >
      {label ? tr(label) : "—"}
    </span>
  );
}

function SunCell({ days }: { days: number | null }) {
  const n = days != null ? Math.round(days) : null;
  if (n == null) return <span className="climate-sun">—</span>;
  return (
    <span
      className="climate-sun"
      title={tr("{n} slunečných dní", { n })}
      style={amountStyle(n, 22)}
    >
      {n}
    </span>
  );
}

function RainCell({ days }: { days: number | null }) {
  const n = days != null ? Math.round(days) : null;
  if (n == null) return <span className="climate-rain">—</span>;
  return (
    <span
      className="climate-rain"
      title={tr("{n} deštivých dní", { n })}
      style={amountStyle(n, 22)}
    >
      {n}
    </span>
  );
}

function compareCell(id: ClimateColId, row: MonthlyClimate | null) {
  switch (id) {
    case "night":
      return <DegCell key={id} n={row?.tempMin ?? null} />;
    case "day":
      return <DegCell key={id} n={row?.tempMax ?? null} />;
    case "mm":
      return <MmCell key={id} mm={row?.precipMm ?? null} />;
    case "rain":
      return <RainCell key={id} days={row?.rainyDays ?? null} />;
    case "sun":
      return <SunCell key={id} days={row?.sunnyDays ?? null} />;
    case "feel":
      return <FeelCell key={id} tempMax={row?.tempMax ?? null} />;
  }
}

function ColHead({ id }: { id: ClimateColId }) {
  const text = tr(CLIMATE_COLS.find((c) => c.id === id)!.head);
  const twoLine = id === "rain" || id === "sun";
  const split = twoLine ? text.lastIndexOf(" ") : -1;
  return (
    <span className={COL_HCLASS[id]}>
      {split > 0 ? (
        <>
          <span>{text.slice(0, split)}</span>
          <span>{text.slice(split + 1)}</span>
        </>
      ) : (
        text
      )}
    </span>
  );
}

function PlaceHead({ cols }: { cols: ClimateColId[] }) {
  return (
    <span className="climate-h-pair">
      {cols.map((id) => (
        <ColHead key={id} id={id} />
      ))}
    </span>
  );
}

function PlaceClusterHead({
  loc,
  cols,
  other = false,
  onChange,
  onRemove,
}: {
  loc: GeoLocation;
  cols: ClimateColId[];
  other?: boolean;
  onChange?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className={`climate-place-head${other ? " climate-side-b" : ""}`}>
      <div className={`climate-loc${other ? " climate-loc-b" : ""}`}>
        {other ? (
          <>
            <button
              type="button"
              className="climate-loc-name"
              onClick={onChange}
              title={tr("Změnit porovnávané místo")}
            >
              {loc.name}
            </button>
            <button
              type="button"
              className="climate-compare-x"
              onClick={onRemove}
              aria-label={tr("Odebrat {name} ze srovnání", { name: loc.name })}
              title={tr("Odebrat ze srovnání")}
            >
              <CompareClose />
            </button>
          </>
        ) : onChange ? (
          <button
            type="button"
            className="climate-loc-name"
            onClick={onChange}
            title={tr("Vybrat místo")}
          >
            {loc.name}
          </button>
        ) : (
          <span className="climate-loc-label">{loc.name}</span>
        )}
      </div>
      <PlaceHead cols={cols} />
    </div>
  );
}

function PlacePair({
  cols,
  row,
  other = false,
  alike = null,
  alikeN = 0,
  onPick,
}: {
  cols: ClimateColId[];
  row: MonthlyClimate | null;
  other?: boolean;
  alike?: "src" | "match" | null;
  alikeN?: number;
  onPick?: () => void;
}) {
  const cls = `climate-side${other ? " climate-side-b" : ""}${
    alike === "src"
      ? " climate-alike-src"
      : alike === "match"
      ? " climate-alike"
      : ""
  }`;
  const style =
    alike === "match"
      ? ({ ["--alike"]: String(alikeN) } as CSSProperties)
      : undefined;
  if (!onPick) {
    return (
      <span className={cls} style={style}>
        {cols.map((id) => compareCell(id, row))}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cls}
      style={style}
      onClick={(e) => {
        e.stopPropagation();
        onPick();
      }}
      aria-pressed={alike === "src"}
      title={
        alike === "src"
          ? undefined
          : tr("Vybrat jako výchozí ke srovnání měsíců")
      }
    >
      {cols.map((id) => compareCell(id, row))}
    </button>
  );
}

function AlikeNote({
  srcName,
  when,
  matches,
}: {
  srcName: string;
  when: string;
  matches: { name: string; months: number[] }[];
}) {
  if (!matches.length) {
    return (
      <p className="climate-alike-note">
        {tr("{place} {when}: žádný podobný měsíc", {
          place: srcName,
          when,
        })}
      </p>
    );
  }
  return (
    <p className="climate-alike-note">
      {tr("{place} {when} jako", { place: srcName, when })}{" "}
      {matches.map((m, i) => (
        <span key={m.name}>
          {i > 0 ? " · " : null}
          <strong>{m.name}</strong>
          {": "}
          {monthListLabel(m.months)}
        </span>
      ))}
    </p>
  );
}

function ClimateExtra({
  whenMonth,
  lines,
}: {
  whenMonth: number;
  lines: { name: string; bits: string }[];
}) {
  const nonempty = lines.filter((l) => l.bits);
  if (!nonempty.length) return null;
  const when = monthIn(whenMonth);
  const whenCap = when.charAt(0).toUpperCase() + when.slice(1);

  if (lines.length === 1) {
    return (
      <p className="climate-extra">
        {whenCap}
        {": "}
        {nonempty[0].bits}
      </p>
    );
  }

  return (
    <div className="climate-extra climate-extra-cmp">
      <p className="climate-extra-when">{whenCap}</p>
      {nonempty.map((l) => (
        <p key={l.name}>
          <strong>{l.name}</strong>
          {": "}
          {l.bits}
        </p>
      ))}
    </div>
  );
}

function ClimateSkeleton({ compare }: { compare: boolean }) {
  const n = compare ? 4 : 6;
  return (
    <div className="climate-skel" aria-hidden="true">
      <div className="climate-cols">
        {Array.from({ length: n }, (_, i) => (
          <span key={i} />
        ))}
      </div>
      {Array.from({ length: 12 }, (_, i) => (
        <span key={i} className="climate-row">
          {Array.from({ length: n }, (_, j) => (
            <span key={j} className="skel skel-line sm" />
          ))}
        </span>
      ))}
    </div>
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
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l-.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CompareClose() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <line
        x1="6"
        y1="6"
        x2="18"
        y2="18"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <line
        x1="18"
        y1="6"
        x2="6"
        y2="18"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
