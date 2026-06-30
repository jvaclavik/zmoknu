import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DailyPoint, HourlyPoint } from "../types";
import { describeWeather } from "../lib/weatherCodes";
import { tr, getLang } from "../lib/i18n";
import { dayHeader } from "../lib/format";
import { useStoredState } from "../lib/useStoredState";
import { tempColor } from "../lib/tempColor";
import { TIER_COLOR, TIER_LABEL, tempTier } from "../lib/tiers";
import { fetchModelSeries, type ModelSeries } from "../lib/openMeteo";
import { WEATHER_MODELS, modelColor, modelLabel } from "../lib/models";
import WeatherIcon from "./WeatherIcon";

interface Props {
  hourly: HourlyPoint[];
  activeDate?: string;
  day?: DailyPoint | null;
  feelsMax?: number;
  feelsMin?: number;
  lat?: number;
  lon?: number;
  model?: string;
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
};

type Tab =
  | "temp"
  | "feels"
  | "precip"
  | "wind"
  | "cloud"
  | "humidity"
  | "dewpoint"
  | "pressure";

const ALL_TABS: Tab[] = [
  "temp",
  "feels",
  "precip",
  "wind",
  "cloud",
  "humidity",
  "dewpoint",
  "pressure",
];

const TAB_LABEL: Record<Tab, string> = {
  temp: "Teplota",
  feels: "Pocitová teplota",
  precip: "Srážky",
  wind: "Vítr",
  cloud: "Oblačnost",
  humidity: "Vlhkost",
  dewpoint: "Rosný bod",
  pressure: "Tlak",
};

const DEFAULT_PINNED: Record<Tab, boolean> = {
  temp: true,
  feels: true,
  precip: true,
  wind: true,
  cloud: true,
  humidity: true,
  dewpoint: true,
  pressure: true,
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

export default function Meteogram({
  hourly,
  activeDate,
  day,
  feelsMax,
  feelsMin,
  lat,
  lon,
  model = "best_match",
}: Props) {
  const [tab, setTab] = useStoredState<Tab>("zmoknu.mgTab", "temp");
  const [compareModels, setCompareModels] = useStoredState<string[]>(
    "zmoknu.mgCompare",
    [],
  );
  const [modelSeries, setModelSeries] = useState<ModelSeries[]>([]);
  const [pinned, setPinned] = useStoredState<Record<Tab, boolean>>(
    "zmoknu.mgPinned",
    DEFAULT_PINNED,
  );
  const [days, setDays] = useStoredState<number>("zmoknu.mgDays", 2);
  const [nightShading, setNightShading] = useStoredState<boolean>(
    "zmoknu.mgNight",
    true,
  );
  const [viewOpen, setViewOpen] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const viewBtnRef = useRef<HTMLButtonElement>(null);
  const viewMenuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(
    null,
  );
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
      setMenuPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
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

  // Počet zobrazených dní volí uživatel (1–5) v nabídce zobrazení dat.
  const windowHours = Math.min(5, Math.max(1, days)) * 24;

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
      if (s * pph >= 16) return s;
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

  const series = useMemo(() => buildSeries(tab, points), [tab, points]);

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

  const areaPath = useMemo(() => {
    if (!points.length || !pph) return "";
    let d = `M ${x(0)} ${CURVE_BOTTOM}`;
    series.primary.forEach((v, i) => {
      d += ` L ${x(i)} ${yCurve(v)}`;
    });
    d += ` L ${x(points.length - 1)} ${CURVE_BOTTOM} Z`;
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, points.length, pph]);

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
  }, [tab, series.min, series.max]);

  const labelValues = series.primary;
  const labelColor = tab === "feels" ? "feels" : "";
  // Minimální rozestup popisků v hodinách odvozený od skutečné šířky (px),
  // aby se na úzké obrazovce (malé pph) hodnoty nepřekrývaly.
  const minGapHours = pph > 0 ? Math.max(2, Math.ceil(40 / pph)) : 2;
  const valueLabelList = useMemo(
    () => valueLabels(points, labelValues, minGapHours),
    [points, labelValues, minGapHours],
  );

  const pressing = useRef(false);

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

  // Tendence tlaku za poslední ~3 h (pro trendovou šipku ve stats).
  const pressureDelta = active.pressure - points[Math.max(0, ci - 3)].pressure;

  // Pozice tooltipu (den + čas) u kurzoru, oříznutá do šířky grafu.
  const tipW = 78;
  const tipX = Math.max(2, Math.min(width - tipW - 2, x(ci) - tipW / 2));

  return (
    <>
      {day && (
        <section className="card mg-summary-card">
          <DaySummary day={day} feelsMax={feelsMax} feelsMin={feelsMin} />
        </section>
      )}

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
                  top: menuPos?.top ?? 0,
                  right: menuPos?.right ?? 0,
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
                  max={5}
                  step={1}
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                  aria-label={tr("Počet zobrazených dní")}
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
        />
      )}

      {compareLines.length > 0 && (
        <div className="mg-legend">
          <span
            className="mg-legend-item"
            title={
              model === "best_match"
                ? tr(
                    "Automaticky = Open-Meteo vybírá nejvhodnější model podle lokality (v ČR obvykle ICON-D2/ICON-EU pro první dny, ECMWF pro vzdálenější).",
                  )
                : modelLabel(model)
            }
          >
            <span
              className="mg-legend-line"
              style={{ background: series.stroke }}
            />
            {modelLabel(model)}
            <strong className="mg-legend-val">
              {series.fmt(series.primary[ci])}
            </strong>
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
                {modelLabel(cl.model)}
                <strong className="mg-legend-val">
                  {v != null ? series.fmt(v) : "–"}
                </strong>
              </span>
            );
          })}
          {model === "best_match" && (
            <InfoHint
              text={tr(
                "„Automaticky“ volí nejlepší model dle lokality (v ČR ICON, pro vzdálenější dny ECMWF).",
              )}
            />
          )}
        </div>
      )}

      <div
        className="meteogram-plot"
        ref={plotRef}
        onPointerDown={(e) => {
          pressing.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          handlePointer(e.clientX);
        }}
        onPointerMove={(e) => {
          // Myš scrubuje při přejezdu; dotyk/pero jen během tažení.
          if (e.pointerType === "mouse" || pressing.current) handlePointer(e.clientX);
        }}
        onPointerUp={() => {
          pressing.current = false;
        }}
        onPointerCancel={() => {
          pressing.current = false;
        }}
      >
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
            <linearGradient id="grad-precip" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#8fd0ff" />
              <stop offset="100%" stopColor="#2f7ff0" />
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
          </defs>

          {/* noční pruhy podle východu/západu slunce (isDay) */}
          {pph > 0 &&
            nightShading &&
            nightBands.map((b, bi) => {
              const left = Math.max(0, x(b.startI) - pph / 2);
              const right = Math.min(width, x(b.endI) + pph / 2);
              return (
                <rect
                  key={`night-${bi}`}
                  x={left}
                  y={TOP_PAD - 10}
                  width={Math.max(0, right - left)}
                  height={H - 14 - (TOP_PAD - 10)}
                  fill="rgba(70,90,150,0.22)"
                />
              );
            })}

          {/* denní pruhy + oddělovače */}
          {pph > 0 &&
            dayBands.map((b, bi) => {
              const left = b.startI * pph;
              const right = (b.endI + 1) * pph;
              const isToday = b.dateStr === todayStr;
              const isActive = b.dateStr === activeKey;
              const isPast = b.dateStr < todayStr;
              const fill = isPast ? "rgba(0,0,0,0.22)" : "transparent";
              return (
                <g key={`band-${bi}`}>
                  <rect
                    x={left}
                    y={TOP_PAD - 10}
                    width={right - left}
                    height={H - 14 - (TOP_PAD - 10)}
                    fill={fill}
                  />
                  {bi > 0 && (
                    <line
                      x1={left}
                      y1={TOP_PAD - 12}
                      x2={left}
                      y2={H - 14}
                      stroke="rgba(255,255,255,0.28)"
                      strokeWidth="1.5"
                    />
                  )}
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

          {/* hodinové linky + popisky (6/12/18) */}
          {pph > 0 &&
            points.map((p, i) => {
              const d = new Date(p.time);
              if (d.getHours() % 6 === 0 && d.getHours() !== 0) {
                return (
                  <g key={`h-${i}`}>
                    <line
                      x1={x(i)}
                      y1={TOP_PAD - 6}
                      x2={x(i)}
                      y2={H - 15}
                      stroke="rgba(255,255,255,0.06)"
                      strokeWidth="1"
                    />
                    <text x={x(i)} y={H - 3} className="mg-hourlabel">
                      {d.getHours()}
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
              const opacity = b.prob > 0 ? 0.2 + 0.8 * (b.prob / 100) : 0.4;
              return (
                <rect
                  key={`p-${b.startI}`}
                  x={left}
                  y={baseline - hb}
                  width={right - left}
                  height={hb}
                  rx="2"
                  fill="url(#grad-precip)"
                  opacity={opacity}
                />
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
                {/* velké srážkové sloupce – od spodku grafu */}
                {precipBars.map((b) => {
                  const top = yPrecip(b.value);
                  const hb = Math.max(2, PRECIP_BASELINE - top);
                  const left = x(b.startI) - pph * 0.42;
                  const right = x(b.endI) + pph * 0.42;
                  const opacity = b.prob > 0 ? 0.35 + 0.65 * (b.prob / 100) : 0.5;
                  return (
                    <rect
                      key={`pb-${b.startI}`}
                      x={left}
                      y={top}
                      width={right - left}
                      height={hb}
                      rx="2"
                      fill="url(#grad-precip)"
                      opacity={opacity}
                    />
                  );
                })}
                {/* hodnoty nad sloupci */}
                {precipBars.map((b) => {
                  const cx = (x(b.startI) + x(b.endI)) / 2;
                  const top = yPrecip(b.value);
                  return (
                    <text
                      key={`pl-${b.startI}`}
                      x={cx}
                      y={Math.max(TOP_PAD + 8, top - 5)}
                      className="mg-extrema precip"
                      textAnchor="middle"
                    >
                      {b.value.toFixed(1)}
                    </text>
                  );
                })}
              </>
            )
          ) : (
            pph > 0 && (
              <>
                <path d={areaPath} fill="url(#grad-primary)" />
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
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                )}
                <path
                  d={linePath}
                  fill="none"
                  stroke={
                    tab === "temp" || tab === "feels"
                      ? "url(#grad-templine)"
                      : series.stroke
                  }
                  strokeWidth="2.5"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {extraPaths.map((ex, i) => (
                  <path
                    key={`extra-${i}`}
                    d={ex.d}
                    fill="none"
                    stroke={ex.color}
                    strokeWidth="1.8"
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
                stroke="rgba(255,209,102,0.7)"
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
                    fill="rgba(255,209,102,0.92)"
                  />
                  <text x={0} y={11} className="mg-nowlabel" textAnchor="middle">
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
function DaySummary({
  day,
  feelsMax,
  feelsMin,
}: {
  day: DailyPoint;
  feelsMax?: number;
  feelsMin?: number;
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
          {" / "}
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
      <span
        className="mg-daysum-tone"
        style={{ background: TIER_COLOR[tier] }}
      >
        {tr(TIER_LABEL[tier])}
      </span>
      <div className="mg-daysum-precip" style={{ opacity: precipOp }}>
        <span className="mg-daysum-precip-main">
          <DropMini />
          <strong>{day.precipitationSum.toFixed(1)} mm</strong>
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
        fill="#3b9bff"
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
}: {
  p: HourlyPoint;
  tab: Tab;
  onTab: (t: Tab) => void;
  pressureDelta: number;
  visible: (t: Tab) => boolean;
}) {
  const info = describeWeather(p.weatherCode);
  return (
    <div className="mg-stats">
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
            <span>{tr("teplota")}</span>
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
            <span>{tr("pocitově")}</span>
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
          <RainGlyph />
          <div className="mg-stat-v">
            <strong className="mg-precip-top">
              {p.precipitation > 0 ? `${p.precipitation.toFixed(1)} mm` : "0 mm"}
              <RainDrops
                n={dropsFor(p.precipitation)}
                prob={p.precipitationProbability}
                small
              />
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

      {visible("dewpoint") && (
        <button
          type="button"
          className={`mg-stat mg-stat-btn ${tab === "dewpoint" ? "active" : ""}`}
          onClick={() => onTab("dewpoint")}
          aria-pressed={tab === "dewpoint"}
          title={tr("Zobrazit graf rosného bodu")}
        >
          <DewGlyph />
          <div className="mg-stat-v">
            <strong>{Math.round(p.dewPoint)}°</strong>
            <span>{tr("rosný bod")}</span>
          </div>
        </button>
      )}

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
  }
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

function dropsFor(mm: number): number {
  if (mm <= 0) return 0;
  if (mm < 0.5) return 1;
  if (mm < 1.5) return 2;
  if (mm < 4) return 3;
  if (mm < 8) return 4;
  return 5;
}

function RainDrops({
  n,
  prob,
  small,
}: {
  n: number;
  prob: number;
  small?: boolean;
}) {
  // Průhlednost kapek podle šance na déšť (jako u srážkových sloupců).
  const op = n > 0 ? (prob > 0 ? 0.25 + 0.75 * (prob / 100) : 0.5) : 1;
  const w = small ? 8 : 11;
  const h = small ? 10 : 14;
  return (
    <span className={`mg-drops ${small ? "small" : ""}`} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <svg key={i} width={w} height={h} viewBox="0 0 11 14">
          <path
            d="M5.5 0S0 6 0 9.2A5.5 5.5 0 0 0 11 9.2C11 6 5.5 0 5.5 0z"
            fill={i < n ? "#3b9bff" : "rgba(255,255,255,0.14)"}
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

function HumidGlyph() {
  return (
    <svg className="mg-glyph" width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 3s6 6.5 6 10.5A6 6 0 0 1 6 13.5C6 9.5 12 3 12 3z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Trendová šipka tlaku podle 3h tendence (prudce/mírně nahoru/dolů, stálý).
function PressureTrend({ delta }: { delta: number }) {
  let angle: number;
  let cls: string;
  let title: string;
  if (delta >= 2) {
    angle = -90;
    cls = "up";
    title = "prudce stoupá";
  } else if (delta >= 0.7) {
    angle = -45;
    cls = "up";
    title = "stoupá";
  } else if (delta <= -2) {
    angle = 90;
    cls = "down";
    title = "prudce klesá";
  } else if (delta <= -0.7) {
    angle = 45;
    cls = "down";
    title = "klesá";
  } else {
    angle = 0;
    cls = "steady";
    title = "stálý";
  }
  return (
    <svg
      className={`mg-ptrend ${cls}`}
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
  return (
    <svg className="mg-glyph" width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 4s5 6 5 9.5A5 5 0 0 1 7 13.5C7 10 12 4 12 4z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M10 13a2 2 0 0 0 2 2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
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
      fmt: (v) => `${v.toFixed(1)} mm`,
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

