import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { GeoLocation, RadarData, RadarFrame } from "../types";
import { radarTileUrl } from "../lib/rainviewer";
import {
  fetchOmForecastGrid,
  fetchOmAccumDaily,
  sumAccumPeriod,
  ACCUM_PERIODS,
  type OmForecastGrid,
  type OmAccumDaily,
} from "../lib/omRadar";
import { buildChmiRadar, CHMI_BOUNDS, isInChmiCoverage } from "../lib/chmi";
import {
  precipColor,
  PRECIP_SCALE,
  PRECIP_LEGEND_LABELS,
} from "../lib/precipScale";
import {
  buildChmiSatFrames,
  cloudMaskUrl,
  CHMI_SAT_CZ_COORDS,
  type SatFrame,
} from "../lib/chmiSat";
import { clockTime, windDirLabel } from "../lib/format";
import {
  echoOnlyImage,
  estimateCloudMotion,
  estimateRadarMotion,
  shiftCorners,
  shiftedChmiCoords,
  type RadarMotion,
} from "../lib/radarMotion";
import { tr, getLang } from "../lib/i18n";
import { darkStyle, loadTouristStyle, loadTouristDarkStyle } from "../lib/mapStyle";
import { useStoredState } from "../lib/useStoredState";
import { useBodyScrollLock } from "../lib/scrollLock";
import { fetchWebcams, type Webcam } from "../lib/webcams";
import { reverseGeocode } from "../lib/openMeteo";
import WebcamModal, { WindyCourtesy } from "./WebcamModal";
import { sameLocation } from "./FavoritesBar";
import LocationArrowGlyph from "./LocationArrowGlyph";

type Basemap = "tourist" | "dark";

interface Props {
  location: GeoLocation;
  radar: RadarData | null;
  radarStatus: "loading" | "ok" | "error";
  favorites?: GeoLocation[];
  onSelect?: (loc: GeoLocation) => void;
  onLocate?: () => void;
  followLocation?: boolean;
  locating?: boolean;
  modal?: boolean;
  onClose?: () => void;
  /** Když je radar v tabu a zrovna není aktivní, zůstane namountovaný, ale skrytý. */
  visible?: boolean;
}

type Source = "rain" | "chmi" | "omforecast" | "accum";

type DaySpan = { label: string; start: number; end: number };

// Krytí zobrazené radarové vrstvy (nižší hodnoty používá predikce).
const RADAR_OPACITY = 0.8;

// Predikce = extrapolace posledního snímku podle odhadnutého posunu pole.
// Ze dvou snímků umíme jen advekci („pole se posouvá, nevzniká ani nezaniká"),
// a ta drží zhruba hodinu – u přeháněk míň, u fronty víc. Dál už by to bylo
// věštění, proto na hodině končíme. Krytí přitom klesá až na polovinu, aby
// bylo vidět, že jistota ubývá, a poslední krok skoro mizí.
const PRED_STEP_MIN = 10;
const PRED_HORIZON_MIN = 60;
const PRED_STEPS = PRED_HORIZON_MIN / PRED_STEP_MIN;
const PRED_MIN_OPACITY = RADAR_OPACITY * 0.5;

const CHMI_HOURS_MIN = 3;
const CHMI_HOURS_MAX = 72;
const CHMI_HOUR_STEPS = [3, 6, 12, 24, 48, 72];

function clampChmiHours(n: number): number {
  return Math.max(CHMI_HOURS_MIN, Math.min(CHMI_HOURS_MAX, Math.round(n)));
}

function snapChmiHours(raw: number): number {
  const n = clampChmiHours(raw);
  let best = CHMI_HOUR_STEPS[0];
  let bd = Infinity;
  for (const s of CHMI_HOUR_STEPS) {
    const d = Math.abs(s - n);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}

function stepChmiHours(current: number, dir: -1 | 1): number {
  const snapped = snapChmiHours(current);
  const i = CHMI_HOUR_STEPS.indexOf(snapped);
  const j = Math.max(0, Math.min(CHMI_HOUR_STEPS.length - 1, i + dir));
  return CHMI_HOUR_STEPS[j];
}

function radarHoursLabel(n: number): string {
  if (n % 24 === 0 && n >= 24) {
    const d = n / 24;
    if (getLang() === "en") return `${d} ${d === 1 ? "day" : "days"}`;
    if (d === 1) return "1 den";
    if (d < 5) return `${d} dny`;
    return `${d} dní`;
  }
  return `${n} h`;
}

function ptDist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function radarLayerId(time: number) {
  return `radar-t-${time}`;
}

function cloudFrameId(time: number) {
  return `cloud-f-${time}`;
}

// Krytí k-tého kroku predikce (k = 1…PRED_STEPS).
function predOpacity(k: number): number {
  const t = Math.min(1, k / PRED_STEPS);
  return RADAR_OPACITY + (PRED_MIN_OPACITY - RADAR_OPACITY) * t;
}

// ID vrstev/zdrojů: předpovědní radar (Open-Meteo, spojitý rastr srážek),
// úhrn srážek (interpolovaný rastr) a oblačnost (družice ČHMÚ image overlay).
const OMF_ID = "omf-precip";
const ACC_ID = "om-accum";
const CLOUD_ID = "chmi-sat-cloud";

// Vyrenderuje pravidelnou mřížku úhrnů do canvasu s bilineární interpolací
// mezi body → plynulé (kontinuální) pole. Vrátí data URL a rohy pro image
// source. Barva podle absolutních mm (společná škála PRECIP_SCALE), takže
// legenda i ČHMÚ vrstva sedí 1:1.
function buildAccumImage(
  grid: { lats: number[]; lons: number[]; values: number[] },
): { url: string; coords: [[number, number], [number, number], [number, number], [number, number]] } | null {
  const n = Math.round(Math.sqrt(grid.values.length));
  if (n < 2 || n * n !== grid.values.length) return null;

  // Mřížka je row-major: index = i*n + j, i = řádek (šířka), j = sloupec (délka).
  const latMin = grid.lats[0];
  const latMax = grid.lats[(n - 1) * n];
  const lonMin = grid.lons[0];
  const lonMax = grid.lons[n - 1];

  const cell = 20; // px na jednu buňku mřížky (jemnost rasteru)
  const W = (n - 1) * cell;
  const H = (n - 1) * cell;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(W, H);

  const val = (i: number, j: number) => grid.values[i * n + j];

  for (let py = 0; py < H; py++) {
    const fy = py / (H - 1);
    // Nahoře (py=0) je sever = největší i.
    const gi = (1 - fy) * (n - 1);
    const i0 = Math.floor(gi);
    const i1 = Math.min(n - 1, i0 + 1);
    const ti = gi - i0;
    for (let px = 0; px < W; px++) {
      const fx = px / (W - 1);
      const gj = fx * (n - 1);
      const j0 = Math.floor(gj);
      const j1 = Math.min(n - 1, j0 + 1);
      const tj = gj - j0;
      const top = val(i0, j0) * (1 - tj) + val(i0, j1) * tj;
      const bot = val(i1, j0) * (1 - tj) + val(i1, j1) * tj;
      const v = top * (1 - ti) + bot * ti;
      const [r, g, b, a] = precipColor(v);
      const idx = (py * W + px) * 4;
      img.data[idx] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return {
    url: canvas.toDataURL(),
    coords: [
      [lonMin, latMax],
      [lonMax, latMax],
      [lonMax, latMin],
      [lonMin, latMin],
    ],
  };
}

// Předpovědní srážky pro jeden časový krok → spojitý rastr (bilineární
// interpolace mřížky + barevná škála mm/h). Oproti heatmapě je pole
// fyzikálně čitelné (barva = intenzita) a mezi snímky stabilní (neskáče).
function buildForecastFrameImage(
  grid: OmForecastGrid,
  ti: number,
): { url: string; coords: Corners } | null {
  const frame = grid.values[ti];
  if (!frame) return null;
  const n = Math.round(Math.sqrt(grid.lats.length));
  if (n < 2 || n * n !== grid.lats.length) return null;

  const latMin = grid.lats[0];
  const latMax = grid.lats[(n - 1) * n];
  const lonMin = grid.lons[0];
  const lonMax = grid.lons[n - 1];

  const cell = 22;
  const W = (n - 1) * cell;
  const H = (n - 1) * cell;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(W, H);

  const val = (i: number, j: number) => frame[i * n + j];

  for (let py = 0; py < H; py++) {
    const fy = py / (H - 1);
    const gi = (1 - fy) * (n - 1); // nahoře (py=0) je sever = největší i
    const i0 = Math.floor(gi);
    const i1 = Math.min(n - 1, i0 + 1);
    const ei = gi - i0;
    for (let px = 0; px < W; px++) {
      const fx = px / (W - 1);
      const gj = fx * (n - 1);
      const j0 = Math.floor(gj);
      const j1 = Math.min(n - 1, j0 + 1);
      const ej = gj - j0;
      const top = val(i0, j0) * (1 - ej) + val(i0, j1) * ej;
      const bot = val(i1, j0) * (1 - ej) + val(i1, j1) * ej;
      const v = top * (1 - ei) + bot * ei;
      const [r, g, b, a] = precipColor(v);
      const idx = (py * W + px) * 4;
      img.data[idx] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return {
    url: canvas.toDataURL(),
    coords: [
      [lonMin, latMax],
      [lonMax, latMax],
      [lonMax, latMin],
      [lonMin, latMin],
    ],
  };
}

// Rohy ČHMÚ snímku jako [lon, lat] (pro image source MapLibre).
const [[chmiS, chmiW], [chmiN, chmiE]] = CHMI_BOUNDS;
const CHMI_COORDS: [[number, number], [number, number], [number, number], [number, number]] = [
  [chmiW, chmiN],
  [chmiE, chmiN],
  [chmiE, chmiS],
  [chmiW, chmiS],
];

type Corners = [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
];

// Datový rozsah ČHMÚ MERGE mřížky (ODIM UL/UR/LR/LL). Menší než „paddovaný"
// PNG kompozit radaru – sem umisťujeme vyrenderovaný úhrn srážek z /api.
const MERGE_DATA_COORDINATES: Corners = [
  [11.266869, 51.458369],
  [19.623974, 51.458369],
  [19.623974, 48.047275],
  [11.266869, 48.047275],
];

// ID první vrstvy podkladu, nad kterou chceme nechat hranice států a popisky
// (města, země) – radar/oblačnost vkládáme PŘED ni, ať jsou popisky navrchu.
function labelsBeforeId(map: maplibregl.Map): string | undefined {
  const layers = map.getStyle()?.layers ?? [];
  const hit = layers.find(
    (l) => l.id.startsWith("boundary") || l.type === "symbol",
  );
  return hit?.id;
}

function precipBottomLayerId(map: maplibregl.Map): string | undefined {
  const layers = map.getStyle()?.layers ?? [];
  const hit = layers.find(
    (l) =>
      l.id.startsWith("lyr-radar-t-") ||
      l.id.startsWith("lyr-pred-src-") ||
      l.id === `lyr-${OMF_ID}` ||
      l.id === `lyr-${ACC_ID}`,
  );
  return hit?.id;
}

function moveCloudsUnderPrecip(map: maplibregl.Map) {
  const before = precipBottomLayerId(map);
  if (!before) return;
  const layers = map.getStyle()?.layers ?? [];
  for (const l of layers) {
    if (!l.id.startsWith("lyr-cloud-f-")) continue;
    try {
      map.moveLayer(l.id, before);
    } catch {
      /* vrstva zrovna není ve stylu */
    }
  }
}

function cloudsBeforeId(map: maplibregl.Map): string | undefined {
  return precipBottomLayerId(map) ?? labelsBeforeId(map);
}

function dropMapSource(map: maplibregl.Map | null | undefined, id: string) {
  if (!map) return;
  try {
    const lyr = `lyr-${id}`;
    if (map.getLayer(lyr)) map.removeLayer(lyr);
    if (map.getSource(id)) map.removeSource(id);
  } catch {
    /* styl se právě mění nebo je mapa zničená */
  }
}

export default function RadarMap({
  location,
  radar,
  radarStatus,
  favorites = [],
  onSelect,
  onLocate,
  followLocation = false,
  locating = false,
  modal = false,
  onClose,
  visible = true,
}: Props) {
  const inCz = isInChmiCoverage(location.latitude, location.longitude);
  // ČHMÚ je výchozí, pokud jsme v jeho pokrytí (ČR a okolí).
  const [source, setSource] = useState<Source>(inCz ? "chmi" : "rain");
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loaded, setLoaded] = useState<Set<string>>(new Set());
  // Snímky, které se opravdu úspěšně načetly (ne 404) – řídí zobrazený snímek
  // a zelené/žluté značení ve slideru.
  const [succeeded, setSucceeded] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const [chmiTick, setChmiTick] = useState(0);
  const [chmiHours, setChmiHours] = useStoredState<number>("zmoknu.chmiHours", 6);
  const [mapReady, setMapReady] = useState(false);
  const [basemap, setBasemap] = useStoredState<Basemap>("zmoknu.basemap", "tourist");
  const [showClouds, setShowClouds] = useStoredState<boolean>(
    "zmoknu.radarClouds",
    false,
  );
  const cloudsOn = showClouds;
  const [satPainted, setSatPainted] = useState(!showClouds);
  const [showWebcams, setShowWebcams] = useStoredState<boolean>(
    "zmoknu.radarWebcams",
    false,
  );
  const [webcams, setWebcams] = useState<Webcam[]>([]);
  const [showFavs, setShowFavs] = useStoredState<boolean>(
    "zmoknu.radarFavs",
    true,
  );
  // Webkamera otevřená v modálu (klik na marker na mapě).
  const [activeWebcam, setActiveWebcam] = useState<Webcam | null>(null);
  // Moje (GPS) poloha – jen pokud už je oprávnění uděleno, ať nevyskakuje prompt.
  const [myLoc, setMyLoc] = useState<{ lat: number; lon: number } | null>(null);
  // Odhadnutý posun srážkového pole (ze dvou posledních snímků ČHMÚ) a
  // poslední snímek očištěný na samotné srážky (podklad pro posunuté vrstvy).
  const [motion, setMotion] = useState<RadarMotion | null>(null);
  const [cloudMotion, setCloudMotion] = useState<RadarMotion | null>(null);
  const [predImg, setPredImg] = useState<string | null>(null);
  const [omGrid, setOmGrid] = useState<OmForecastGrid | null>(null);
  const [omError, setOmError] = useState(false);
  const [accumPeriodId, setAccumPeriodId] = useStoredState<string>(
    "zmoknu.accumPeriod",
    "h24",
  );
  const accumPeriod =
    ACCUM_PERIODS.find((p) => p.id === accumPeriodId) ?? ACCUM_PERIODS[0];
  // V pokrytí ČHMÚ bereme úhrn z radaru (MERGE), jinak fallback z Open-Meteo.
  const accumChmi = inCz;
  // Denní úhrny (Open-Meteo fallback) se stahují jednou; období počítáme lokálně.
  const [accumDaily, setAccumDaily] = useState<OmAccumDaily | null>(null);
  const [accumError, setAccumError] = useState(false);
  // Vyrenderovaný overlay úhrnu (image URL + rohy) – z ČHMÚ nebo z Open-Meteo.
  const [accumImg, setAccumImg] = useState<{
    url: string;
    coords: Corners;
  } | null>(null);
  const accumGrid = useMemo(
    () =>
      accumDaily && !accumChmi
        ? sumAccumPeriod(accumDaily, accumPeriod.hours)
        : null,
    [accumDaily, accumChmi, accumPeriod],
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const webcamMarkersRef = useRef<maplibregl.Marker[]>([]);
  const radarSrcIds = useRef<string[]>([]);
  const allRadarIds = useRef<string[]>([]);
  const radarKindRef = useRef<Source | null>(null);
  const predSrcIds = useRef<string[]>([]);
  const failedSrcIds = useRef<Set<string>>(new Set());
  const cloudSrcIds = useRef<string[]>([]);
  const satLoadedRef = useRef<SatFrame[]>([]);
  const indexTimeRef = useRef<number | null>(null);
  const indexRef = useRef(0);
  const prevRealLenRef = useRef(0);
  const framesKeyRef = useRef("");
  // Cache vyrenderovaných rastrů předpovědi (podle indexu kroku) – ať se při
  // scrubování / přehrávání nemusí stejný snímek počítat znovu.
  const omfImgCache = useRef<Map<number, string>>(new Map());
  const didAutoIndex = useRef(false);
  const initialCenter = useRef<[number, number]>([
    location.longitude,
    location.latitude,
  ]);

  useEffect(() => {
    if (!inCz && source === "chmi") setSource("rain");
  }, [inCz, source]);

  // Zjištění mojí polohy – jen když je geolokace už povolená (žádný prompt).
  useEffect(() => {
    if (!navigator.geolocation) return;
    let cancelled = false;
    const locate = () =>
      navigator.geolocation.getCurrentPosition(
        (p) => {
          if (!cancelled)
            setMyLoc({ lat: p.coords.latitude, lon: p.coords.longitude });
        },
        () => {},
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
      );
    const perms = navigator.permissions;
    if (perms?.query) {
      perms
        .query({ name: "geolocation" as PermissionName })
        .then((s) => {
          if (!cancelled && s.state === "granted") locate();
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setChmiTick((t) => t + 1), 5 * 60 * 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    function onClick(e: MouseEvent) {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [settingsOpen]);

  const chmiRadar = useMemo(
    () => buildChmiRadar(snapChmiHours(chmiHours)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chmiTick, chmiHours],
  );

  // Předpovědní radar (Open-Meteo): stáhni mřížku srážek pro danou lokalitu.
  useEffect(() => {
    if (source !== "omforecast") return;
    let cancelled = false;
    setOmGrid(null);
    setOmError(false);
    fetchOmForecastGrid(location.latitude, location.longitude)
      .then((g) => {
        if (!cancelled) setOmGrid(g);
      })
      .catch(() => {
        if (!cancelled) setOmError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [source, location.latitude, location.longitude]);

  // Úhrn srážek – ČHMÚ MERGE (radar). Serverová funkce sečte hodinové mřížky
  // a vrátí obarvené PNG; načteme ho jako blob a vložíme jako image overlay.
  useEffect(() => {
    if (source !== "accum" || !accumChmi) return;
    let cancelled = false;
    let objUrl: string | null = null;
    setAccumImg(null);
    setAccumError(false);
    fetch(`/api/precip-accum?hours=${accumPeriod.hours}`)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("accum"))))
      .then((b) => {
        if (cancelled) return;
        objUrl = URL.createObjectURL(b);
        setAccumImg({ url: objUrl, coords: MERGE_DATA_COORDINATES });
      })
      .catch(() => {
        if (!cancelled) setAccumError(true);
      });
    return () => {
      cancelled = true;
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, [source, accumChmi, accumPeriod.hours]);

  // Úhrn srážek – fallback Open-Meteo (mimo pokrytí ČHMÚ). Denní úhrny stáhneme
  // jednou; jednotlivá období pak počítáme lokálně (bez dalších dotazů).
  useEffect(() => {
    if (source !== "accum" || accumChmi) return;
    let cancelled = false;
    setAccumDaily(null);
    setAccumError(false);
    fetchOmAccumDaily(location.latitude, location.longitude)
      .then((g) => {
        if (!cancelled) setAccumDaily(g);
      })
      .catch(() => {
        if (!cancelled) setAccumError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [source, accumChmi, location.latitude, location.longitude]);

  // Fallback Open-Meteo: z denní mřížky vyrenderuj kontinuální obrázek úhrnu.
  useEffect(() => {
    if (source !== "accum" || accumChmi) return;
    if (!accumGrid) {
      setAccumImg(null);
      return;
    }
    setAccumImg(buildAccumImage(accumGrid));
  }, [source, accumChmi, accumGrid]);

  // Snímky předpovědního radaru = budoucí hodiny (každá = jeden „snímek").
  const omFrames = useMemo(
    () =>
      omGrid
        ? omGrid.times.map((t, i) => ({
            time: t,
            path: String(i),
            kind: "nowcast" as const,
          }))
        : [],
    [omGrid],
  );

  // Reálné (stažené) snímky – jen ty mají vlastní vrstvu s obrázkem.
  const realFrames = useMemo(() => {
    if (source === "accum") return [];
    if (source === "omforecast") return omFrames;
    return (source === "chmi" ? chmiRadar : radar)?.frames ?? [];
  }, [source, omFrames, chmiRadar, radar]);
  const framesKey = realFrames.map((f) => f.path).join("|");

  // Družice: stejná razítka jako radar (ne vlastní 15/45/120 min krok).
  const satFrames = useMemo<SatFrame[]>(
    () => (cloudsOn ? buildChmiSatFrames(realFrames.map((f) => f.time)) : []),
    [cloudsOn, realFrames],
  );

  const nowcastStart =
    source === "omforecast"
      ? 0
      : (source === "chmi" ? chmiRadar : radar)?.nowcastStartIndex ??
        realFrames.length;

  // Kotva predikce = nejnovější snímek, který se opravdu načetl (ten úplně
  // poslední ještě nemusí být na serveru).
  const anchorIdx = useMemo(() => {
    const last = realFrames.length - 1;
    if (last < 0) return -1;
    let i = last;
    while (i > 0 && !succeeded.has(radarLayerId(realFrames[i].time))) i--;
    return succeeded.has(radarLayerId(realFrames[i].time)) ? i : last;
  }, [realFrames.length, succeeded]);
  const anchor = realFrames[anchorIdx];

  // Predikované snímky rezervujeme ve slideru hned, ať osa neposkočí,
  // až dorazí odhad posunu. Vrstvy na mapu jdou až když je motion hotový.
  const predFrames = useMemo<RadarFrame[]>(() => {
    if (source !== "chmi") return [];
    const last = realFrames[realFrames.length - 1];
    if (!last) return [];
    return Array.from({ length: PRED_STEPS }, (_, k) => ({
      time: last.time + (k + 1) * PRED_STEP_MIN * 60,
      path: last.path,
      kind: "nowcast" as const,
    }));
  }, [source, realFrames]);
  const predReady = source === "chmi" && !!motion && !!predImg;

  // Časová osa = reálné snímky + predikce za nimi.
  const frames = useMemo(
    () => [...realFrames, ...predFrames],
    [realFrames, predFrames],
  );
  indexRef.current = index;
  if (framesKeyRef.current === framesKey && frames[index]) {
    indexTimeRef.current = frames[index].time;
  }

  // Odhad posunu pole ze dvou posledních snímků. Pouštíme až po prvním
  // načteném snímku, ať to nesoupeří o pásmo s přednačítáním.
  const motionReady = loaded.size > 0;
  useEffect(() => {
    if (source !== "chmi" || !anchor || !motionReady) {
      setMotion(null);
      return;
    }
    let cancelled = false;
    estimateRadarMotion(
      realFrames.slice(Math.max(0, anchorIdx - 3), anchorIdx + 1).reverse(),
    )
      .then((m) => {
        if (!cancelled) setMotion(m);
      })
      .catch(() => {
        if (!cancelled) setMotion(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, realFrames, anchorIdx, motionReady]);

  // Posun oblačnosti ze samotné družice – IR pole často nejede stejným
  // směrem jako srážky, proto predikce mraků nesmí brát vektor z radaru.
  useEffect(() => {
    if (!cloudsOn || satFrames.length < 2) {
      setCloudMotion(null);
      return;
    }
    let cancelled = false;
    estimateCloudMotion(satFrames.slice(-4).reverse())
      .then((m) => {
        if (!cancelled) setCloudMotion(m);
      })
      .catch(() => {
        if (!cancelled) setCloudMotion(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cloudsOn, satFrames]);

  // Očištěný poslední snímek – posouváme jen srážky, ne rámeček a hlavičku.
  useEffect(() => {
    if (source !== "chmi" || !anchor || !motionReady) {
      setPredImg(null);
      return;
    }
    let cancelled = false;
    echoOnlyImage(anchor.path).then((url) => {
      if (!cancelled) setPredImg(url);
    });
    return () => {
      cancelled = true;
    };
  }, [source, anchor, motionReady]);

  // Inicializace mapy (jednou).
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: { version: 8, sources: {}, layers: [] },
      center: initialCenter.current,
      zoom: 7,
      attributionControl: false,
    });
    mapRef.current = map;

    // Snímek považujeme za „vyřízený", když se zdroj načte NEBO selže (404 ap.)
    // – jinak by se počítadlo zaseklo a přednačítání by nikdy neskončilo.
    // U selhání (ok=false) si snímek značíme, ať na prázdný snímek nepřistaneme.
    const settle = (sourceId?: string, ok = true) => {
      if (!sourceId?.startsWith("radar-t-")) return;
      if (ok) {
        failedSrcIds.current.delete(sourceId);
        setSucceeded((prev) => {
          if (prev.has(sourceId)) return prev;
          const next = new Set(prev);
          next.add(sourceId);
          return next;
        });
      } else {
        failedSrcIds.current.add(sourceId);
      }
      setLoaded((prev) => {
        if (prev.has(sourceId)) return prev;
        const next = new Set(prev);
        next.add(sourceId);
        return next;
      });
    };
    const onSourceData = (e: maplibregl.MapSourceDataEvent) => {
      if (e.isSourceLoaded) settle(e.sourceId, true);
    };
    const onError = (e: maplibregl.ErrorEvent) => {
      settle((e as { sourceId?: string }).sourceId, false);
    };
    // Když mapa „zklidní" (idle), jsou dlaždice viditelného snímku načtené –
    // bereme to jako dokončení přednačítání (spolehlivější než sourcedata
    // u průhledných vrstev).
    const onIdle = () => {
      const map = mapRef.current;
      if (!map) return;
      setLoaded((prev) => {
        let next = prev;
        for (const id of radarSrcIds.current) {
          if (prev.has(id)) continue;
          if (!map.getSource(id) || !map.isSourceLoaded(id)) continue;
          if (next === prev) next = new Set(prev);
          next.add(id);
        }
        return next;
      });
    };
    map.on("sourcedata", onSourceData);
    map.on("error", onError);
    map.on("idle", onIdle);

    return () => {
      map.off("sourcedata", onSourceData);
      map.off("error", onError);
      map.off("idle", onIdle);
      try {
        map.remove();
      } catch {
        /* mapa už může být zničená */
      }
      mapRef.current = null;
      setMapReady(false);
    };
  }, []);

  // Aplikace stylu podle zvoleného podkladu (turistický / tmavý).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let cancelled = false;
    let poll: number | null = null;
    setMapReady(false);
    radarSrcIds.current = [];
    const markReady = () => {
      if (!cancelled) setMapReady(true);
    };
    const applyStyle = (style: maplibregl.StyleSpecification) => {
      if (cancelled) return;
      // diff:false vynutí plný reload stylu – jinak může MapLibre udělat jen
      // „diff" a událost style.load se znovu nespustí (radar by se nepřidal).
      map.setStyle(style, { diff: false });
      // Primárně čekáme na style.load. Kdyby událost proběhla dřív, než se
      // stihneme přihlásit (styl z cache), doplní to krátký polling.
      map.once("style.load", markReady);
      poll = window.setInterval(() => {
        if (cancelled) return;
        if (map.isStyleLoaded()) {
          markReady();
          if (poll) window.clearInterval(poll);
          poll = null;
        }
      }, 150);
    };
    const loader = basemap === "dark" ? loadTouristDarkStyle : loadTouristStyle;
    loader()
      .then(applyStyle)
      .catch(() => applyStyle(darkStyle));
    return () => {
      cancelled = true;
      if (poll) window.clearInterval(poll);
    };
  }, [basemap]);

  // Přidání radarových snímků. Už načtené vrstvy (stejný čas) necháme být –
  // při změně rozsahu jen dokládáme chybějící a schováme ty mimo okno.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const dropAllRadar = () => {
      for (const id of allRadarIds.current) dropMapSource(map, id);
      allRadarIds.current = [];
      radarSrcIds.current = [];
      failedSrcIds.current = new Set();
      didAutoIndex.current = false;
      setLoaded(new Set());
      setSucceeded(new Set());
    };

    if (source === "omforecast" || source === "accum") {
      dropAllRadar();
      radarKindRef.current = source;
      return;
    }

    if (radarKindRef.current !== source) {
      dropAllRadar();
      radarKindRef.current = source;
    }

    // Po výměně podkladu zdroje zmizí, ale id v refu zůstanou.
    if (allRadarIds.current.length && !map.getSource(allRadarIds.current[0])) {
      allRadarIds.current = [];
      radarSrcIds.current = [];
      failedSrcIds.current = new Set();
      setLoaded(new Set());
      setSucceeded(new Set());
    }

    const before = labelsBeforeId(map);
    const addFrame = (f: RadarFrame, show: boolean) => {
      const id = radarLayerId(f.time);
      if (map.getSource(id)) return id;
      if (source === "chmi") {
        map.addSource(id, { type: "image", url: f.path, coordinates: CHMI_COORDS });
      } else if (radar) {
        map.addSource(id, {
          type: "raster",
          tiles: [radarTileUrl(radar.host, f.path)],
          tileSize: 256,
          maxzoom: 7,
        });
      } else {
        return id;
      }
      map.addLayer(
        {
          id: `lyr-${id}`,
          type: "raster",
          source: id,
          paint: {
            "raster-opacity": show ? RADAR_OPACITY : 0,
            "raster-opacity-transition": { duration: 0 },
            "raster-fade-duration": 0,
          },
        },
        before,
      );
      if (!allRadarIds.current.includes(id)) allRadarIds.current.push(id);
      return id;
    };

    const startIdx = Math.max(0, nowcastStart - 1);
    const startF = realFrames[startIdx];
    const missing = realFrames.filter((f) => !map.getSource(radarLayerId(f.time)));
    radarSrcIds.current = realFrames.map((f) => radarLayerId(f.time));

    const startMissing = !!startF && missing.some((f) => f.time === startF.time);
    const rest = missing.filter((f) => f.time !== startF?.time).sort((a, b) => b.time - a.time);

    let safety: number | undefined;
    let flushed = false;
    const detach = () => {
      map.off("sourcedata", onFirstData);
      map.off("error", onFirstError);
    };
    const flushRest = () => {
      if (flushed) return;
      flushed = true;
      detach();
      for (const f of rest) addFrame(f, false);
      moveCloudsUnderPrecip(map);
      const ids = radarSrcIds.current.slice();
      safety = window.setTimeout(() => {
        setLoaded((prev) => {
          const next = new Set(prev);
          for (const id of ids) next.add(id);
          return next;
        });
      }, 8000);
    };

    if (startF && startMissing) addFrame(startF, true);
    else if (startF) addFrame(startF, false);

    function onFirstData(e: maplibregl.MapSourceDataEvent) {
      if (startF && e.sourceId === radarLayerId(startF.time) && e.isSourceLoaded)
        flushRest();
    }
    function onFirstError(e: maplibregl.ErrorEvent) {
      if (startF && (e as { sourceId?: string }).sourceId === radarLayerId(startF.time))
        flushRest();
    }

    if (missing.length === 0) {
      moveCloudsUnderPrecip(map);
      return;
    }

    if (!startMissing) {
      flushRest();
      return () => {
        if (safety) window.clearTimeout(safety);
      };
    }

    map.on("sourcedata", onFirstData);
    map.on("error", onFirstError);
    const kick = window.setTimeout(flushRest, 2500);

    return () => {
      detach();
      window.clearTimeout(kick);
      if (safety) window.clearTimeout(safety);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, source, framesKey]);

  // Po změně okna zůstaň na stejném čase – jen přepočti index.
  useLayoutEffect(() => {
    if (source === "omforecast" || source === "accum") {
      prevRealLenRef.current = realFrames.length;
      framesKeyRef.current = framesKey;
      return;
    }
    const prevLen = prevRealLenRef.current;
    const prevIndex = indexRef.current;
    prevRealLenRef.current = realFrames.length;
    framesKeyRef.current = framesKey;
    if (!realFrames.length || prevLen === 0) return;
    if (prevIndex >= prevLen) {
      setIndex(realFrames.length + (prevIndex - prevLen));
      return;
    }
    const t = indexTimeRef.current;
    if (t == null) return;
    const exact = realFrames.findIndex((f) => f.time === t);
    if (exact >= 0) {
      if (exact !== prevIndex) setIndex(exact);
      return;
    }
    let best = 0;
    let bd = Infinity;
    realFrames.forEach((f, i) => {
      const d = Math.abs(f.time - t);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setIndex(best);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framesKey, source]);

  // Vrstvy predikce: pořád tentýž obrázek, jen posunutý o k×10 min po
  // odhadnutém vektoru. Přidáváme je zvlášť, ať přepočet posunu nesahá na
  // (už načtené) radarové vrstvy.
  const predKey =
    motion && predImg
      ? `${anchor?.path ?? ""}|${motion.dxFrac.toFixed(5)}|${motion.dyFrac.toFixed(5)}`
      : "";
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const clear = () => {
      const m = mapRef.current;
      for (const id of predSrcIds.current) dropMapSource(m, id);
      predSrcIds.current = [];
    };
    clear();
    if (!predKey || !motion || !predImg || !predFrames.length) return;

    const before = labelsBeforeId(map);
    predFrames.forEach((_f, k) => {
      const id = `pred-src-${k}`;
      map.addSource(id, {
        type: "image",
        url: predImg,
        coordinates: shiftedChmiCoords(motion, (k + 1) * PRED_STEP_MIN),
      });
      map.addLayer(
        {
          id: `lyr-${id}`,
          type: "raster",
          source: id,
          paint: {
            "raster-opacity": 0,
            "raster-opacity-transition": { duration: 0 },
            "raster-fade-duration": 0,
          },
        },
        before,
      );
      predSrcIds.current.push(id);
    });
    moveCloudsUnderPrecip(map);
    return clear;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, predKey]);

  // Vyrenderuje (a nakešuje) rastr předpovědi pro daný krok.
  const omfFrameUrl = (ti: number): string | null => {
    if (!omGrid) return null;
    const hit = omfImgCache.current.get(ti);
    if (hit) return hit;
    const built = buildForecastFrameImage(omGrid, ti);
    if (!built) return null;
    omfImgCache.current.set(ti, built.url);
    return built.url;
  };

  // Přepínání viditelného snímku – radar i oblačnost v jednom kroku, až když
  // jsou obě cílové vrstvy načtené. Jinak by jedno ujelo o snímek dřív.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const visualIndex =
      source === "chmi" && index >= realFrames.length && !predReady
        ? (anchorIdx >= 0 ? anchorIdx : Math.max(0, realFrames.length - 1))
        : index;

    const pairReady = (i: number): boolean => {
      if (source === "chmi" || source === "rain") {
        if (i < realFrames.length) {
          const id = radarLayerId(realFrames[i].time);
          if (
            map.getSource(id) &&
            !failedSrcIds.current.has(id) &&
            !map.isSourceLoaded(id)
          )
            return false;
        } else {
          const id = `pred-src-${i - realFrames.length}`;
          if (predReady && map.getSource(id) && !map.isSourceLoaded(id))
            return false;
        }
      }
      if (cloudsOn) {
        if (!satPainted) return false;
        const fr = frames[i];
        if (!fr) return true;
        const id = cloudFrameId(fr.time);
        if (map.getSource(id) && !map.isSourceLoaded(id)) return false;
      }
      return true;
    };

    const apply = () => {
      const m = mapRef.current;
      if (!m) return;
      if (source === "omforecast") {
        const src = m.getSource(OMF_ID) as maplibregl.ImageSource | undefined;
        const url = omfFrameUrl(index);
        if (src && url) src.updateImage({ url });
      } else if (source !== "accum") {
        const visId =
          visualIndex < realFrames.length
            ? radarLayerId(realFrames[visualIndex].time)
            : null;
        for (const id of allRadarIds.current) {
          const lyr = `lyr-${id}`;
          if (!m.getLayer(lyr)) continue;
          m.setPaintProperty(
            lyr,
            "raster-opacity",
            visId === id ? RADAR_OPACITY : 0,
          );
        }
        predFrames.forEach((_, k) => {
          const lyr = `lyr-pred-src-${k}`;
          if (m.getLayer(lyr)) {
            m.setPaintProperty(
              lyr,
              "raster-opacity",
              predReady && realFrames.length + k === visualIndex
                ? predOpacity(k + 1)
                : 0,
            );
          }
        });
      }
      if (cloudsOn) {
        const vis = frames[visualIndex];
        const visCloud = vis ? cloudFrameId(vis.time) : null;
        for (const id of cloudSrcIds.current) {
          const lyr = `lyr-${id}`;
          if (!m.getLayer(lyr)) continue;
          m.setPaintProperty(lyr, "raster-opacity", id === visCloud ? 1 : 0);
        }
      }
      m.triggerRepaint();
    };

    if (pairReady(visualIndex)) {
      apply();
      return;
    }

    const onData = () => {
      if (!pairReady(visualIndex)) return;
      map.off("sourcedata", onData);
      map.off("error", onData);
      apply();
    };
    map.on("sourcedata", onData);
    map.on("error", onData);
    const kick = window.setTimeout(() => {
      if (pairReady(visualIndex)) apply();
    }, 2000);
    return () => {
      map.off("sourcedata", onData);
      map.off("error", onData);
      window.clearTimeout(kick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    index,
    mapReady,
    realFrames,
    predFrames,
    source,
    predReady,
    anchorIdx,
    cloudsOn,
    satPainted,
  ]);

  // Předpovědní radar: spojitý rastr srážek z mřížky Open-Meteo jako image
  // overlay (barva = intenzita mm/h). Slider mění, který krok se vykreslí.
  const omKey = omGrid ? `${omGrid.lats.length}:${omGrid.times[0] ?? 0}` : "";
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    dropMapSource(map, OMF_ID);

    if (source !== "omforecast" || !omGrid) return;

    // Nová mřížka → zahoď staré rastry z cache.
    omfImgCache.current.clear();
    const first = buildForecastFrameImage(omGrid, 0);
    if (!first) return;
    omfImgCache.current.set(0, first.url);

    map.addSource(OMF_ID, {
      type: "image",
      url: first.url,
      coordinates: first.coords,
    });
    map.addLayer(
      {
        id: `lyr-${OMF_ID}`,
        type: "raster",
        source: OMF_ID,
        paint: {
          "raster-opacity": 0.85,
          "raster-resampling": "linear",
          "raster-fade-duration": 0,
        },
      },
      labelsBeforeId(map),
    );
    setIndex(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, source, omKey, basemap]);

  // Úhrn srážek: image overlay (mm) – z ČHMÚ MERGE nebo z Open-Meteo fallbacku.
  const accKey = accumImg?.url ?? "";
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    dropMapSource(map, ACC_ID);

    if (source !== "accum" || !accumImg) return;

    map.addSource(ACC_ID, {
      type: "image",
      url: accumImg.url,
      coordinates: accumImg.coords,
    });
    map.addLayer(
      {
        id: `lyr-${ACC_ID}`,
        type: "raster",
        source: ACC_ID,
        paint: {
          "raster-opacity": 0.85,
          "raster-resampling": "linear",
          "raster-fade-duration": 0,
        },
      },
      labelsBeforeId(map),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, source, accKey, basemap]);

  // Satelitní snímek platný v čase t (poslední načtený ≤ t). Když je radar
  // mezi 15min sloty družice, overlay se posune advekcí – viz cloudShiftMin.
  const satAtOrBefore = (t: number): number => {
    const list = satLoadedRef.current;
    if (!list.length) return -1;
    let i = -1;
    for (let k = 0; k < list.length; k++) {
      if (list[k].time <= t) i = k;
      else break;
    }
    if (i >= 0) return i;
    return list[0].time - t <= 20 * 60 ? 0 : -1;
  };

  const cloudShiftMin = (t: number, satTime: number): number => {
    if (!cloudMotion && !motion) return 0;
    const minutes = (t - satTime) / 60;
    if (minutes <= 0.05) return 0;
    const lastReal = realFrames[realFrames.length - 1]?.time ?? 0;
    if (t > lastReal) return minutes;
    return minutes <= 15 ? minutes : 0;
  };

  // Oblačnost – stejný přístup jako radar: už namalované snímky necháme,
  // dokládáme jen nové časy. Masky se kešují v cloudMaskUrl.
  const satKey = satFrames.length
    ? `${satFrames.length}:${satFrames[0]?.time ?? 0}:${frames.length}`
    : "";
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const teardown = () => {
      const m = mapRef.current;
      for (const id of cloudSrcIds.current) dropMapSource(m, id);
      cloudSrcIds.current = [];
      satLoadedRef.current = [];
      dropMapSource(m, CLOUD_ID);
    };

    if (!cloudsOn || !satFrames.length) {
      teardown();
      setSatPainted(true);
      return;
    }

    if (cloudSrcIds.current.length && !map.getSource(cloudSrcIds.current[0])) {
      cloudSrcIds.current = [];
      satLoadedRef.current = [];
    }

    let cancelled = false;
    const ac = new AbortController();
    if (!cloudSrcIds.current.length) setSatPainted(false);

    let beforeId: string | undefined;
    try {
      beforeId = cloudsBeforeId(map);
    } catch {
      beforeId = undefined;
    }

    (async () => {
      const results = await Promise.all(
        satFrames.map((f) =>
          cloudMaskUrl(f.url, ac.signal)
            .then((url) => ({ f, url }))
            .catch(() => null),
        ),
      );
      if (cancelled) return;
      const m = mapRef.current;
      if (!m) return;

      const ok = results.filter(
        (x): x is { f: SatFrame; url: string } => x != null,
      );
      const maskByTime = new Map(ok.map((x) => [x.f.time, x.url]));
      const loaded = new Map(satLoadedRef.current.map((f) => [f.time, f]));
      for (const x of ok) loaded.set(x.f.time, x.f);
      satLoadedRef.current = [...loaded.values()].sort((a, b) => a.time - b.time);

      for (const fr of frames) {
        const satI = satAtOrBefore(fr.time);
        if (satI < 0) continue;
        const sat = satLoadedRef.current[satI];
        if (!sat) continue;
        let url = maskByTime.get(sat.time);
        if (!url) {
          try {
            url = await cloudMaskUrl(sat.url, ac.signal);
          } catch {
            continue;
          }
        }
        if (cancelled) return;
        const id = cloudFrameId(fr.time);
        const minutes = cloudShiftMin(fr.time, sat.time);
        const advect = cloudMotion ?? motion;
        const coords =
          minutes && advect
            ? shiftCorners(CHMI_SAT_CZ_COORDS, advect, minutes)
            : CHMI_SAT_CZ_COORDS;
        const existing = m.getSource(id) as maplibregl.ImageSource | undefined;
        if (existing) {
          existing.setCoordinates(coords);
          continue;
        }
        m.addSource(id, {
          type: "image",
          url,
          coordinates: coords,
        });
        m.addLayer(
          {
            id: `lyr-${id}`,
            type: "raster",
            source: id,
            paint: {
              "raster-opacity": 0,
              "raster-opacity-transition": { duration: 0 },
              "raster-fade-duration": 0,
            },
          },
          beforeId,
        );
        if (!cloudSrcIds.current.includes(id)) cloudSrcIds.current.push(id);
      }
      if (!cancelled) {
        moveCloudsUnderPrecip(m);
        setSatPainted(true);
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, cloudsOn, satKey, basemap, framesKey, source, motion, cloudMotion]);

  useEffect(() => {
    return () => {
      const m = mapRef.current;
      for (const id of cloudSrcIds.current) dropMapSource(m, id);
      cloudSrcIds.current = [];
      satLoadedRef.current = [];
    };
  }, [source, basemap]);

  // Markery: moje poloha (GPS) + oblíbená (hvězdička) + aktuální místo (puls).
  // Tři vizuálně odlišené typy, ať je jasné, co je co.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    // Oblíbená místa – žlutý pin (jen když je zapnuto v nastavení).
    if (showFavs)
      favorites
      .filter((f) => !sameLocation(f, location))
      .forEach((f) => {
        const el = document.createElement("button");
        el.className = "fav-marker";
        el.type = "button";
        el.title = f.name;
        el.innerHTML = starSvg;
        el.addEventListener("click", () => onSelect?.(f));
        const m = new maplibregl.Marker({ element: el, anchor: "center" })
          .setLngLat([f.longitude, f.latitude])
          .addTo(map);
        markersRef.current.push(m);
      });

    // Moje poloha – klikací marker; po kliknutí zapneme sledování GPS.
    // Skryjeme, když prakticky splývá s aktuálním místem (ať se markery nepřekrývají).
    const nearActive =
      myLoc &&
      Math.abs(myLoc.lat - location.latitude) < 0.003 &&
      Math.abs(myLoc.lon - location.longitude) < 0.003;
    if (myLoc && !nearActive) {
      const meEl = document.createElement("button");
      meEl.className = "me-marker";
      meEl.type = "button";
      meEl.title = tr("Moje poloha");
      meEl.innerHTML = '<span class="me-dot"></span><span class="me-ring"></span>';
      meEl.addEventListener("click", () => {
        if (onLocate) onLocate();
        else {
          reverseGeocode(myLoc.lat, myLoc.lon)
            .catch(() => tr("Moje poloha"))
            .then((name) =>
              onSelect?.({ name, latitude: myLoc.lat, longitude: myLoc.lon }),
            );
        }
      });
      const meMarker = new maplibregl.Marker({ element: meEl, anchor: "center" })
        .setLngLat([myLoc.lon, myLoc.lat])
        .addTo(map);
      markersRef.current.push(meMarker);
    }

    // Aktuální místo – modrý pin.
    const locEl = document.createElement("div");
    locEl.className = "loc-pin";
    locEl.title = followLocation ? tr("Moje poloha") : location.name;
    locEl.innerHTML = pinSvg;
    const locMarker = new maplibregl.Marker({ element: locEl, anchor: "bottom" })
      .setLngLat([location.longitude, location.latitude])
      .addTo(map);
    markersRef.current.push(locMarker);
  }, [location, favorites, onSelect, onLocate, followLocation, myLoc, showFavs]);

  // Webkamery v okolí – stáhneme až po zapnutí přepínače (kolem aktuálního místa).
  useEffect(() => {
    if (!showWebcams) {
      setWebcams([]);
      return;
    }
    let cancelled = false;
    fetchWebcams(location.latitude, location.longitude, 120, 40)
      .then((w) => !cancelled && setWebcams(w))
      .catch(() => !cancelled && setWebcams([]));
    return () => {
      cancelled = true;
    };
  }, [showWebcams, location.latitude, location.longitude]);

  // Markery webkamer – klik otevře modál s přehrávačem (uživatele nevedeme pryč).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    webcamMarkersRef.current.forEach((m) => m.remove());
    webcamMarkersRef.current = [];
    if (!showWebcams) return;

    for (const w of webcams) {
      if (w.lat == null || w.lon == null) continue;
      const el = document.createElement("button");
      el.className = "webcam-marker";
      el.type = "button";
      el.title = w.title;
      el.innerHTML = webcamMarkerSvg;
      el.addEventListener("click", () => setActiveWebcam(w));

      const m = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat([w.lon, w.lat])
        .addTo(map);
      webcamMarkersRef.current.push(m);
    }
  }, [webcams, showWebcams]);

  // Vycentrování při změně místa.
  useEffect(() => {
    mapRef.current?.easeTo({
      center: [location.longitude, location.latitude],
      duration: 600,
    });
  }, [location]);

  const fullscreen = modal || expanded;

  // Spolehlivé zamčení scrollu pozadí při celé obrazovce (i na iOS).
  useBodyScrollLock(fullscreen && visible);
  // Esc při celé obrazovce + resize mapy. Skrytý tab neresize/nechytá klávesy.
  useEffect(() => {
    if (!visible) {
      setPlaying(false);
      setSettingsOpen(false);
      setActiveWebcam(null);
      return;
    }
    if (!fullscreen) {
      const t = setTimeout(() => mapRef.current?.resize(), 80);
      return () => clearTimeout(t);
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (modal) onClose?.();
      else setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    const t = setTimeout(() => mapRef.current?.resize(), 80);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [fullscreen, modal, onClose, visible]);

  const allLoaded =
    source === "omforecast"
      ? !!omGrid
      : source === "accum"
        ? !!accumImg
        : realFrames.length > 0 &&
          succeeded.size > 0 &&
          (!cloudsOn || satPainted);

  const errored =
    (source === "rain" && radarStatus === "error") ||
    (source === "omforecast" && omError) ||
    (source === "accum" && accumError);

  // Po dokončení přednačtení přistaň na nejnovějším úspěšně načteném snímku –
  // nejnovější snímek ČHMÚ někdy ještě není k dispozici (404) a byl by prázdný.
  useEffect(() => {
    if (source === "omforecast" || source === "accum" || !allLoaded || playing)
      return;
    if (didAutoIndex.current) return;
    didAutoIndex.current = true;
    const target = Math.max(0, nowcastStart - 1);
    let idx = target;
    while (idx > 0 && !succeeded.has(radarLayerId(realFrames[idx].time))) idx--;
    setIndex(succeeded.has(radarLayerId(realFrames[idx].time)) ? idx : target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allLoaded, source, playing, nowcastStart, succeeded]);

  useEffect(() => {
    if (!playing || frames.length === 0 || !allLoaded) return;
    // Jemnější kroky = víc snímků; zkrať interval, ať smyčka netrvá dlouho.
    const step = source === "omforecast" ? 160 : 500;
    timer.current = window.setInterval(() => {
      setIndex((i) => {
        const n = predReady || source !== "chmi" ? frames.length : realFrames.length;
        return n > 0 ? (i + 1) % n : i;
      });
    }, step);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [playing, frames.length, allLoaded, source, predReady, realFrames.length]);

  const active = frames[index];
  const isForecast = source === "omforecast" || index >= nowcastStart;
  const lang = getLang();
  const timeLabel = useMemo(() => {
    if (!active) return "";
    const d = new Date(active.time * 1000);
    return `${radarDayLabel(d)}, ${clockTime(d)}`;
    // lang v deps: přepočítej popisek i po přepnutí jazyka.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, lang]);

  const nFrames = frames.length;
  const nowFrac = nFrames > 0 ? (nowcastStart / nFrames) * 100 : 0;
  const thumbFrac = nFrames > 0 ? ((index + 0.5) / nFrames) * 100 : 0;

  // Šířka dráhy – podle ní počítáme, kolik hodinových popisků se vejde.
  const [trackW, setTrackW] = useState(0);

  const { hourTicks, daySpans } = useMemo(() => {
    const n = frames.length;
    if (n === 0) return { hourTicks: [], daySpans: [] as DaySpan[] };

    const cell = (i: number) => ((i + 0.5) / n) * 100;
    const spans: DaySpan[] = [];
    frames.forEach((f, i) => {
      const d = new Date(f.time * 1000);
      const label = radarDayLabel(d);
      const last = spans[spans.length - 1];
      if (!last || last.label !== label) spans.push({ label, start: i, end: i + 1 });
      else last.end = i + 1;
    });

    // Snímky v minulosti nemají vždy :00 (ČHMÚ řidší krok), proto bereme
    // všechny a vybereme hezké časy rovnoměrně po celé šířce – i vlevo.
    type Cand = { i: number; left: number; label: string; rank: number };
    const cands: Cand[] = frames.map((f, i) => {
      const d = new Date(f.time * 1000);
      const m = d.getMinutes();
      const h = d.getHours();
      const rank =
        m === 0 && h % 12 === 0
          ? 0
          : m === 0 && h % 6 === 0
            ? 1
            : m === 0 && h % 3 === 0
              ? 2
              : m === 0
                ? 3
                : m === 30
                  ? 4
                  : 5;
      return {
        i,
        left: cell(i),
        label: String(h).padStart(2, "0"),
        rank,
      };
    });

    const width = trackW || 320;
    const minGap = 36;
    const slots = Math.max(2, Math.floor(width / minGap));
    const placed: Cand[] = [];
    for (let s = 0; s < slots; s++) {
      const lo = (s / slots) * 100;
      const hi = ((s + 1) / slots) * 100;
      const mid = (lo + hi) / 2;
      const inSlot = cands.filter((t) => t.left >= lo && t.left < hi);
      if (inSlot.length === 0) continue;
      inSlot.sort(
        (a, b) =>
          a.rank - b.rank ||
          Math.abs(a.left - mid) - Math.abs(b.left - mid),
      );
      const pick = inSlot[0];
      const prev = placed[placed.length - 1];
      if (prev && (pick.left - prev.left) / 100 * width < minGap) continue;
      if (prev && prev.label === pick.label) continue;
      placed.push(pick);
    }
    return { hourTicks: placed, daySpans: spans };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames, trackW, lang]);

  // Scrubování časem přes celou spodní lištu – tažení kdekoliv (ne jen po thumbu).
  const trackRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
  const [dragging, setDragging] = useState(false);
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef<{ startDist: number; startHours: number } | null>(null);
  const hoursRef = useRef(chmiHours);
  hoursRef.current = chmiHours;
  const [hoursHint, setHoursHint] = useState<number | null>(null);
  const hoursHintTimer = useRef<number | null>(null);

  const showHoursHint = (n: number) => {
    setHoursHint(n);
    if (hoursHintTimer.current) window.clearTimeout(hoursHintTimer.current);
    hoursHintTimer.current = window.setTimeout(() => setHoursHint(null), 900);
  };

  const applyHours = (raw: number) => {
    const next = snapChmiHours(raw);
    showHoursHint(next);
    if (next === hoursRef.current) return;
    hoursRef.current = next;
    setChmiHours(next);
  };

  useEffect(
    () => () => {
      if (hoursHintTimer.current) window.clearTimeout(hoursHintTimer.current);
    },
    [],
  );

  // Pinch na trackpadu = wheel s ctrlKey. React onWheel je pasivní, proto nativní.
  useEffect(() => {
    const el = footerRef.current;
    if (!el) return;
    let accum = 0;
    const STEP = 28;
    const onWheel = (e: WheelEvent) => {
      if (source !== "chmi") return;
      if (!e.ctrlKey) return;
      e.preventDefault();
      accum += e.deltaY;
      let next = hoursRef.current;
      if (accum <= -STEP) {
        accum = 0;
        next = stepChmiHours(hoursRef.current, -1);
      } else if (accum >= STEP) {
        accum = 0;
        next = stepChmiHours(hoursRef.current, 1);
      }
      if (next !== hoursRef.current) applyHours(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  useEffect(() => {
    const release = (e: PointerEvent) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.delete(e.pointerId);
      if (pointers.current.size < 2 && pinch.current) {
        pinch.current = null;
      }
      if (pointers.current.size === 0) {
        scrubbing.current = false;
        setDragging(false);
      }
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Měření šířky dráhy (trackW deklarován výše, u výpočtu popisků).
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) =>
      setTrackW(entries[0].contentRect.width),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scrubTo = (clientX: number) => {
    const el = trackRef.current;
    if (!el || frames.length === 0) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0) return;
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    setIndex(Math.max(0, Math.min(frames.length - 1, Math.floor(f * frames.length))));
  };

  const onScrubDown = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size >= 2) {
      scrubbing.current = false;
      setDragging(false);
      setPlaying(false);
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        startDist: ptDist(a, b),
        startHours: hoursRef.current,
      };
      for (const id of pointers.current.keys()) {
        try {
          e.currentTarget.setPointerCapture(id);
        } catch {
          /* prst už pustil */
        }
      }
      return;
    }
    if ((e.target as HTMLElement).closest("button, .radar-settings")) {
      pointers.current.delete(e.pointerId);
      return;
    }
    scrubbing.current = true;
    setDragging(true);
    setPlaying(false);
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubTo(e.clientX);
  };
  const onScrubMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const d = ptDist(a, b);
      if (d > 0 && pinch.current.startDist > 0 && source === "chmi") {
        const raw =
          pinch.current.startHours *
          (pinch.current.startDist / d) ** 1.6;
        applyHours(raw);
      }
      return;
    }
    if (scrubbing.current) scrubTo(e.clientX);
  };
  const endScrub = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2 && pinch.current) {
      pinch.current = null;
    }
    if (pointers.current.size > 0) return;
    scrubbing.current = false;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer už uvolněný */
    }
  };
  const onScrubKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (frames.length <= 1) return;
    if (e.key === "ArrowLeft") {
      setPlaying(false);
      setIndex(Math.max(0, index - 1));
    } else if (e.key === "ArrowRight") {
      setPlaying(false);
      setIndex(Math.min(frames.length - 1, index + 1));
    }
  };

  const settingsControl = (
    <div className="radar-settings" ref={settingsRef}>
      <button
        type="button"
        className={`radar-ctl-btn ${settingsOpen ? "active" : ""}`}
        onClick={() => setSettingsOpen((o) => !o)}
        title={tr("Nastavení radaru")}
        aria-label={tr("Nastavení radaru")}
        aria-expanded={settingsOpen}
      >
        <GearGlyph />
      </button>

      {settingsOpen && (
        <div className="radar-settings-panel">
          <div className="radar-set-group">
            <span className="radar-set-label">{tr("Zdroj")}</span>
            <div className="radar-seg radar-seg-wrap">
              {inCz && (
                <button
                  className={source === "chmi" ? "active" : ""}
                  onClick={() => setSource("chmi")}
                >
                  ČHMÚ
                </button>
              )}
              <button
                className={source === "rain" ? "active" : ""}
                onClick={() => setSource("rain")}
              >
                RainViewer
              </button>
              <button
                className={source === "omforecast" ? "active" : ""}
                onClick={() => setSource("omforecast")}
              >
                {tr("Předpověď")}
              </button>
              <button
                className={source === "accum" ? "active" : ""}
                onClick={() => setSource("accum")}
              >
                {tr("Úhrn")}
              </button>
            </div>
          </div>

          {source === "omforecast" && (
            <p className="radar-set-note">
              {tr(
                "Předpověď srážek z modelu (Open-Meteo, ICON). Není to radar – ukazuje očekávaný vývoj na příštích 24 h.",
              )}
            </p>
          )}

          {source === "accum" && (
            <div className="radar-set-group">
              <span className="radar-set-label">{tr("Období")}</span>
              <div className="radar-seg radar-seg-wrap">
                {ACCUM_PERIODS.map((p) => (
                  <button
                    key={p.id}
                    className={accumPeriodId === p.id ? "active" : ""}
                    onClick={() => setAccumPeriodId(p.id)}
                  >
                    {tr(p.label)}
                  </button>
                ))}
              </div>
              <span className="radar-set-note">
                {accumChmi
                  ? tr("Úhrn srážek z radaru ČHMÚ (MERGE, mm za období).")
                  : tr("Úhrn srážek z modelu Open-Meteo (mm za období).")}
              </span>
            </div>
          )}

          {inCz && source === "chmi" && (
            <p className="radar-set-note">
              {motion
                ? tr(
                    "Za posledním snímkem je predikce na {n} min – srážky se posouvají {v} km/h k {d}. Mraky jedou podle družice, ne podle radaru. Čím dál dopředu, tím průhlednější.",
                    {
                      n: PRED_HORIZON_MIN,
                      v: Math.round(motion.speedKmh),
                      d: windDirLabel(motion.dirDeg),
                    },
                  )
                : tr(
                    "Predikci spočítáme z posunu pole mezi dvěma posledními snímky – teď na ni nejsou data.",
                  )}
            </p>
          )}

          {inCz && source === "chmi" && (
            <div className="radar-set-group">
              <span className="radar-set-label">{tr("Interval")}</span>
              <div className="radar-seg">
                {[
                  { h: 6, label: "6h" },
                  { h: 24, label: "24h" },
                  { h: 72, label: "3d" },
                ].map((o) => (
                  <button
                    key={o.h}
                    className={chmiHours === o.h ? "active" : ""}
                    onClick={() => setChmiHours(o.h)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="radar-set-group">
            <span className="radar-set-label">{tr("Mapa")}</span>
            <div className="radar-seg">
              <button
                className={basemap === "tourist" ? "active" : ""}
                onClick={() => setBasemap("tourist")}
              >
                {tr("Světlá")}
              </button>
              <button
                className={basemap === "dark" ? "active" : ""}
                onClick={() => setBasemap("dark")}
              >
                {tr("Tmavá")}
              </button>
            </div>
          </div>

          <div className="radar-set-group">
            <span className="radar-set-label">{tr("Vrstvy")}</span>
            <label className="radar-toggle">
              <input
                type="checkbox"
                checked={showFavs}
                onChange={(e) => setShowFavs(e.target.checked)}
              />
              <span>{tr("Oblíbená místa")}</span>
            </label>
            <label className="radar-toggle">
              <input
                type="checkbox"
                checked={cloudsOn}
                onChange={(e) => setShowClouds(e.target.checked)}
              />
              <span>{tr("Oblačnost")}</span>
            </label>
            <span className="radar-set-note">
              {tr("Oblačnost = družice ČHMÚ (orientačně umístěná).")}
            </span>
            <label className="radar-toggle">
              <input
                type="checkbox"
                checked={showWebcams}
                onChange={(e) => setShowWebcams(e.target.checked)}
              />
              <span>{tr("Webkamery")}</span>
            </label>
            <span className="radar-set-note">
              {tr("Webkamery v okolí zobrazené na mapě (zdroj Windy).")}
            </span>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <section
      className={`card radar-card ${fullscreen ? "radar-fullscreen" : ""}${visible ? "" : " radar-hidden"}`}
      aria-hidden={!visible}
    >
      <div className="radar-map">
        <div ref={containerRef} className="radar-canvas" />

        {(hoursHint != null ||
          (source !== "accum" && !errored && frames.length > 0)) && (
          <div className="radar-map-captions">
            {hoursHint != null && (
              <div className="radar-zoomhint" aria-hidden="true">
                {radarHoursLabel(hoursHint)}
              </div>
            )}
            {source !== "accum" && !errored && frames.length > 0 && (
              <div className={`radar-timebadge ${isForecast ? "forecast" : ""}`}>
                {isForecast ? tr("predikce · {t}", { t: timeLabel }) : timeLabel}
              </div>
            )}
          </div>
        )}

        {onLocate && (
          <div className="radar-locatectl">
            <button
              type="button"
              className={`hb-locate${followLocation ? " on" : ""}`}
              onClick={onLocate}
              disabled={locating}
              aria-label={tr("Použít moji polohu")}
              title={
                locating ? tr("Zjišťuji polohu…") : tr("Použít moji polohu")
              }
            >
              {locating ? (
                <span className="spinner hb-locate-spin" />
              ) : (
                <LocationArrowGlyph size={16} />
              )}
            </button>
          </div>
        )}

        {modal && <div className="radar-mapctl">{settingsControl}</div>}

        {errored ? (
          <div className="radar-loading">{tr("Radar není k dispozici")}</div>
        ) : !allLoaded ? (
          <div className="radar-loading">
            {frames.length > 0 ? (
              <>
                <span className="spinner" /> {tr("Přednačítám snímky…")}{" "}
                {loaded.size}/{realFrames.length}
              </>
            ) : (
              <>
                <span className="spinner" />{" "}
                {source === "accum" ? tr("Načítám úhrn…") : tr("Načítám radar…")}
              </>
            )}
          </div>
        ) : null}

        <div className="radar-attr">
          © OpenStreetMap · {basemap === "tourist" ? "MapTiler" : "CARTO"} ·{" "}
          {source === "chmi"
            ? predReady
              ? "radar ČHMÚ (CZRAD) + predikce posunu"
              : "radar ČHMÚ (CZRAD)"
            : source === "omforecast"
              ? "předpověď Open-Meteo (ICON)"
              : source === "accum"
                ? accumChmi
                  ? "úhrn ČHMÚ (MERGE)"
                  : "úhrn Open-Meteo"
                : "RainViewer"}
          {cloudsOn && " · družice ČHMÚ"}
          {showWebcams && (
            <>
              {" · "}
              <WindyCourtesy />
            </>
          )}
        </div>
      </div>

      {activeWebcam && (
        <WebcamModal
          webcam={activeWebcam}
          onClose={() => setActiveWebcam(null)}
        />
      )}

      {source === "accum" ? (
        <div className="radar-bar radar-accum-bar">
          {!modal && (
            <button
              type="button"
              className="radar-ctl-btn"
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? tr("Zmenšit") : tr("Na celou obrazovku")}
              aria-label={
                expanded ? tr("Zmenšit radar") : tr("Radar na celou obrazovku")
              }
            >
              {expanded ? <CompressGlyph /> : <ExpandGlyph />}
            </button>
          )}
          <div className="radar-accum-legend">
            <span className="radar-accum-title">
              {tr("Úhrn")} · {tr(accumPeriod.label)} · {tr("mm")}
            </span>
            <div className="radar-accum-swatches">
              {PRECIP_SCALE.map((s) => (
                <span
                  key={s.min}
                  className="radar-accum-swatch"
                  style={{
                    background: `rgb(${s.color[0]},${s.color[1]},${s.color[2]})`,
                  }}
                />
              ))}
            </div>
            <div className="radar-accum-ticks">
              {PRECIP_SCALE.map((s) => (
                <span key={s.min}>
                  {PRECIP_LEGEND_LABELS.includes(s.min) ? s.min : ""}
                </span>
              ))}
            </div>
          </div>
          {!modal && settingsControl}
        </div>
      ) : (
        <div
          ref={footerRef}
          className={`radar-footer${dragging ? " is-scrubbing" : ""}`}
          role="slider"
          tabIndex={0}
          aria-label={tr("Posuvník času radaru")}
          aria-valuemin={0}
          aria-valuemax={Math.max(0, frames.length - 1)}
          aria-valuenow={index}
          aria-valuetext={timeLabel}
          onPointerDown={onScrubDown}
          onPointerMove={onScrubMove}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
          onKeyDown={onScrubKey}
        >
          {!modal && (
            <button
              type="button"
              className="radar-ctl-btn"
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? tr("Zmenšit") : tr("Na celou obrazovku")}
              aria-label={
                expanded ? tr("Zmenšit radar") : tr("Radar na celou obrazovku")
              }
            >
              {expanded ? <CompressGlyph /> : <ExpandGlyph />}
            </button>
          )}

          <button
            type="button"
            className={`radar-ctl-btn${playing ? " active" : ""}`}
            onClick={() => setPlaying((p) => !p)}
            aria-label={playing ? tr("Pozastavit") : tr("Přehrát")}
            title={playing ? tr("Pozastavit") : tr("Přehrát")}
          >
            {playing ? <PauseGlyph /> : <PlayGlyph />}
          </button>

          <div className="radar-scrub">
            <div className="radar-scrub-top">
              {daySpans.length > 1 &&
                daySpans.map((d) => {
                  const left = (d.start / nFrames) * 100;
                  if (Math.abs(left - nowFrac) < 12) return null;
                  return (
                    <span
                      key={`${d.label}-${d.start}`}
                      className="radar-scrub-day"
                      style={{
                        left: `${left}%`,
                        width: `${((d.end - d.start) / nFrames) * 100}%`,
                      }}
                    >
                      {d.label}
                    </span>
                  );
                })}
              {nFrames > 0 && (
                <span
                  className="radar-scrub-nowlab"
                  style={{
                    left: `${nowFrac}%`,
                    transform:
                      nowFrac < 8
                        ? "translateX(0)"
                        : nowFrac > 92
                          ? "translateX(-100%)"
                          : "translateX(-50%)",
                  }}
                >
                  {tr("teď")}
                </span>
              )}
            </div>

            <div className="radar-scrub-track" ref={trackRef}>
              <div className="radar-scrub-cells">
                {frames.map((_, i) => {
                  const future = source === "omforecast" || i >= nowcastStart;
                  const pred = i >= realFrames.length || source === "omforecast";
                  const status = pred
                    ? "pred"
                    : succeeded.has(radarLayerId(frames[i].time))
                      ? "ok"
                      : "pending";
                  return (
                    <span
                      key={i}
                      className={`radar-scrub-cell ${status}${future && !pred ? " future" : ""}`}
                    />
                  );
                })}
                {nFrames > 0 && nowFrac < 100 && (
                  <div
                    className="radar-scrub-future"
                    style={{ left: `${nowFrac}%` }}
                  />
                )}
              </div>
              {daySpans.slice(1).map((d) => (
                <span
                  key={`div-${d.start}`}
                  className="radar-scrub-dayline"
                  style={{ left: `${(d.start / nFrames) * 100}%` }}
                />
              ))}
              {nFrames > 0 && (
                <span
                  className="radar-scrub-nowline"
                  style={{ left: `${nowFrac}%` }}
                />
              )}
              {nFrames > 0 && (
                <span
                  className="radar-scrub-thumb"
                  style={{ left: `${thumbFrac}%` }}
                />
              )}
            </div>

            <div className="radar-scrub-hours">
              {hourTicks.map((t) => (
                <span
                  key={t.i}
                  className="radar-scrub-hour"
                  style={{
                    left: `${t.left}%`,
                    transform:
                      t.left < 4
                        ? "translateX(0)"
                        : t.left > 96
                          ? "translateX(-100%)"
                          : "translateX(-50%)",
                  }}
                >
                  {t.label}
                </span>
              ))}
            </div>
          </div>

          {!modal && settingsControl}
        </div>
      )}
    </section>
  );
}

function PlayGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 5l12 7-12 7z" fill="currentColor" />
    </svg>
  );
}

function PauseGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
      <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
    </svg>
  );
}

function ExpandGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9 3H4a1 1 0 0 0-1 1v5M15 3h5a1 1 0 0 1 1 1v5M9 21H4a1 1 0 0 1-1-1v-5M15 21h5a1 1 0 0 0 1-1v-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Den snímku: Dnes / Včera / Zítra, jinak "d.m.".
function radarDayLabel(d: Date): string {
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diff = Math.round((day(d).getTime() - day(new Date()).getTime()) / 86_400_000);
  if (diff === 0) return tr("Dnes");
  if (diff === -1) return tr("Včera");
  if (diff === 1) return tr("Zítra");
  return `${d.getDate()}.${d.getMonth() + 1}.`;
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

function CompressGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Mapový pin (teardrop). Barvu určuje `color` rodičovského elementu (CSS).
const pinSvg =
  '<svg class="map-pin" width="26" height="34" viewBox="0 0 24 32" aria-hidden="true"><path d="M12 .8C6.4.8 1.9 5.3 1.9 10.9c0 7.2 10.1 20.3 10.1 20.3S22.1 18.1 22.1 10.9C22.1 5.3 17.6.8 12 .8z" fill="currentColor" stroke="#fff" stroke-width="1.6"/><circle cx="12" cy="11" r="3.7" fill="#fff"/></svg>';

// Hvězdička pro oblíbená místa. Barvu určuje `color` rodiče (CSS).
const starSvg =
  '<svg class="map-star" width="30" height="30" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.8l2.94 6.32 6.86.86-5.06 4.7 1.32 6.82L12 18.02l-6.06 3.28 1.32-6.82L2.2 8.98l6.86-.86z" fill="currentColor" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>';

// Ikona markeru webkamery (vkládá se do DOM elementu markeru MapLibre).
const webcamMarkerSvg =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m23 7-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>';
