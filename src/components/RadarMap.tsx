import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { GeoLocation, RadarData } from "../types";
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
  CHMI_SAT_CZ_COORDS,
  type SatFrame,
} from "../lib/chmiSat";
import { clockTime } from "../lib/format";
import { tr, getLang } from "../lib/i18n";
import { darkStyle, loadTouristStyle, loadTouristDarkStyle } from "../lib/mapStyle";
import { useStoredState } from "../lib/useStoredState";
import { useBodyScrollLock } from "../lib/scrollLock";
import { sameLocation } from "./FavoritesBar";

type Basemap = "tourist" | "dark";

interface Props {
  location: GeoLocation;
  radar: RadarData | null;
  radarStatus: "loading" | "ok" | "error";
  favorites?: GeoLocation[];
  onSelect?: (loc: GeoLocation) => void;
  modal?: boolean;
  onClose?: () => void;
}

type Source = "rain" | "chmi" | "omforecast" | "accum";

// ID vrstev/zdrojů: předpovědní radar (Open-Meteo heatmapa), úhrn srážek
// (akumulovaná heatmapa) a oblačnost (družice ČHMÚ jako image overlay).
const OMF_ID = "omf-precip";
const ACC_ID = "om-accum";
const CLOUD_ID = "chmi-sat-cloud";

// Váha heatmapy podle srážek daného časového kroku (mm/h → 0–1).
function omfWeight(i: number): maplibregl.ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["coalesce", ["get", `p${i}`], 0],
    0,
    0,
    0.3,
    0.18,
    2,
    0.5,
    6,
    1,
  ] as maplibregl.ExpressionSpecification;
}

// Poloměr heatmapy podle zoomu – dost velký, ať se řídká mřížka bodů slije do
// souvislého pole a je dobře vidět (platí pro předpověď).
const ACC_RADIUS: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  4,
  22,
  6,
  55,
  8,
  150,
  10,
  380,
] as maplibregl.ExpressionSpecification;

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

export default function RadarMap({
  location,
  radar,
  radarStatus,
  favorites = [],
  onSelect,
  modal = false,
  onClose,
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
  // Vrstva oblačnosti (družice ČHMÚ) – vždy dostupná, animuje se s časem.
  const cloudsOn = showClouds;
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
  const radarSrcIds = useRef<string[]>([]);
  const failedSrcIds = useRef<Set<string>>(new Set());
  const cloudSrcIds = useRef<string[]>([]);
  const didAutoIndex = useRef(false);
  const initialCenter = useRef<[number, number]>([
    location.longitude,
    location.latitude,
  ]);

  useEffect(() => {
    if (!inCz && source === "chmi") setSource("rain");
  }, [inCz, source]);

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
    () => buildChmiRadar(chmiHours),
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

  // Družicové snímky ČHMÚ (oblačnost) za posledních ~6 h po 15 min. Přepočítá
  // se při zapnutí vrstvy, ať se okno posune na aktuální čas.
  const satFrames = useMemo<SatFrame[]>(
    () => (cloudsOn ? buildChmiSatFrames(6) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cloudsOn],
  );

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

  const frames = useMemo(() => {
    if (source === "accum") return [];
    if (source === "omforecast") return omFrames;
    return (source === "chmi" ? chmiRadar : radar)?.frames ?? [];
  }, [source, omFrames, chmiRadar, radar]);
  const nowcastStart =
    source === "omforecast"
      ? 0
      : (source === "chmi" ? chmiRadar : radar)?.nowcastStartIndex ??
        frames.length;

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
      if (!sourceId?.startsWith("radar-src-")) return;
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
      const ids = radarSrcIds.current;
      if (!ids.length) return;
      setLoaded((prev) => (prev.size >= ids.length ? prev : new Set(ids)));
    };
    map.on("sourcedata", onSourceData);
    map.on("error", onError);
    map.on("idle", onIdle);

    return () => {
      map.off("sourcedata", onSourceData);
      map.off("error", onError);
      map.off("idle", onIdle);
      map.remove();
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

  // Přidání/výměna radarových snímků (po načtení stylu nebo změně zdroje/dat).
  const framesKey = frames.map((f) => f.path).join("|");
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    // Odstraníme předchozí radarové vrstvy a zdroje.
    for (const id of radarSrcIds.current) {
      if (map.getLayer(`lyr-${id}`)) map.removeLayer(`lyr-${id}`);
      if (map.getSource(id)) map.removeSource(id);
    }
    radarSrcIds.current = [];
    failedSrcIds.current = new Set();
    didAutoIndex.current = false;
    setLoaded(new Set());
    setSucceeded(new Set());

    // Předpovědní radar a úhrn používají heatmapu (jiný efekt), dlaždice sem
    // nepatří.
    if (source === "omforecast" || source === "accum") return;

    const startIdx = Math.max(0, nowcastStart - 1);
    setIndex(startIdx);

    // Radar vkládáme pod hranice a popisky, ať zůstanou čitelné navrchu.
    const before = labelsBeforeId(map);
    frames.forEach((f, i) => {
      const id = `radar-src-${i}`;
      if (source === "chmi") {
        map.addSource(id, { type: "image", url: f.path, coordinates: CHMI_COORDS });
      } else if (radar) {
        map.addSource(id, {
          type: "raster",
          tiles: [radarTileUrl(radar.host, f.path)],
          tileSize: 256,
          // RainViewer servíruje dlaždice jen do zoomu 7; výš vrací obrázek
          // s textem „zoom level not supported". Omezíme maxzoom, MapLibre
          // pak z7 dlaždici jen zvětší (rozostří) místo nepodporované.
          maxzoom: 7,
        });
      } else {
        return;
      }
      map.addLayer(
        {
          id: `lyr-${id}`,
          type: "raster",
          source: id,
          paint: {
            "raster-opacity": i === startIdx ? 0.8 : 0,
            "raster-opacity-transition": { duration: 0 },
            "raster-fade-duration": 0,
          },
        },
        before,
      );
      radarSrcIds.current.push(id);
    });

    // Pojistka: kdyby se některý snímek nikdy neohlásil (pomalá síť, tichá
    // chyba), po 8 s přednačítání i tak dokončíme, aby šlo přehrávat.
    const ids = radarSrcIds.current.slice();
    const safety = window.setTimeout(() => setLoaded(new Set(ids)), 8000);
    return () => window.clearTimeout(safety);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, source, framesKey]);

  // Přepínání viditelného snímku (dlaždicové zdroje) nebo času heatmapy.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (source === "omforecast") {
      if (map.getLayer(`lyr-${OMF_ID}`)) {
        map.setPaintProperty(`lyr-${OMF_ID}`, "heatmap-weight", omfWeight(index));
      }
      return;
    }
    frames.forEach((_, i) => {
      const lyr = `lyr-radar-src-${i}`;
      if (map.getLayer(lyr)) {
        map.setPaintProperty(lyr, "raster-opacity", i === index ? 0.8 : 0);
      }
    });
  }, [index, mapReady, frames, source]);

  // Předpovědní radar: heatmapa srážek z mřížky Open-Meteo. Každý bod nese
  // hodnoty p0..pK (srážky v jednotlivých hodinách); slider mění, kterou čteme.
  const omKey = omGrid ? `${omGrid.lats.length}:${omGrid.times[0] ?? 0}` : "";
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    if (map.getLayer(`lyr-${OMF_ID}`)) map.removeLayer(`lyr-${OMF_ID}`);
    if (map.getSource(OMF_ID)) map.removeSource(OMF_ID);

    if (source !== "omforecast" || !omGrid) return;

    const features = omGrid.lats.map((la, pi) => {
      const props: Record<string, number> = {};
      omGrid.values.forEach((row, ti) => {
        props[`p${ti}`] = row[pi];
      });
      return {
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [omGrid.lons[pi], la],
        },
        properties: props,
      };
    });

    map.addSource(OMF_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features },
    });
    map.addLayer(
      {
        id: `lyr-${OMF_ID}`,
        type: "heatmap",
        source: OMF_ID,
        paint: {
          "heatmap-weight": omfWeight(0),
          "heatmap-intensity": [
            "interpolate",
            ["linear"],
            ["zoom"],
            4,
            2,
            10,
            1.3,
          ],
          // Poloměr musí překrýt rozestup bodů mřížky, ať pole nemá díry.
          "heatmap-radius": ACC_RADIUS,
          "heatmap-opacity": 0.92,
          "heatmap-color": [
            "interpolate",
            ["linear"],
            ["heatmap-density"],
            0,
            "rgba(0,0,0,0)",
            0.08,
            "rgba(120,200,255,0.7)",
            0.3,
            "rgba(60,140,240,0.85)",
            0.55,
            "rgba(120,90,230,0.9)",
            0.8,
            "rgba(214,70,120,0.94)",
            1,
            "rgba(240,60,90,0.98)",
          ],
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

    if (map.getLayer(`lyr-${ACC_ID}`)) map.removeLayer(`lyr-${ACC_ID}`);
    if (map.getSource(ACC_ID)) map.removeSource(ACC_ID);

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

  // Vybere index družicového snímku nejbližšího času daného radarového snímku.
  const nearestSatIdx = (t: number): number => {
    if (!satFrames.length) return -1;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < satFrames.length; i++) {
      const d = Math.abs(satFrames[i].time - t);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };

  // Oblačnost = družice ČHMÚ jako image overlay POD radarem. Všechny snímky
  // přednačteme jako samostatné image vrstvy (jako u radaru) a při posunu času
  // jen přepínáme jejich průhlednost – žádné dotahování ze sítě, žádný lag.
  const satKey = satFrames.length
    ? `${satFrames.length}:${satFrames[0]?.time ?? 0}`
    : "";
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const dropSource = (id: string) => {
      try {
        if (map.getLayer(`lyr-${id}`)) map.removeLayer(`lyr-${id}`);
        if (map.getSource(id)) map.removeSource(id);
      } catch {
        /* vrstva/zdroj už nemusí existovat (po přestylování) */
      }
    };

    // Teardown starých vrstev oblačnosti (spolehlivě i při vypnutí – cleanup).
    const teardown = () => {
      for (const id of cloudSrcIds.current) dropSource(id);
      cloudSrcIds.current = [];
      // Legacy jednosnímková vrstva (kdyby po hot-reloadu zůstala).
      dropSource(CLOUD_ID);
    };

    teardown();

    if (!cloudsOn || !satFrames.length) return teardown;

    // Vlož pod srážkovou vrstvu (dlaždice radaru / heatmapu), případně aspoň
    // pod hranice a popisky, ať zůstanou nahoře.
    const beforeId = radarSrcIds.current.length
      ? `lyr-${radarSrcIds.current[0]}`
      : map.getLayer(`lyr-${OMF_ID}`)
        ? `lyr-${OMF_ID}`
        : labelsBeforeId(map);

    const cur = frames[index];
    const activeSat = nearestSatIdx(cur ? cur.time : Date.now() / 1000);

    satFrames.forEach((f, i) => {
      const id = `${CLOUD_ID}-${i}`;
      // Idempotentně – kdyby zdroj po rychlém přepnutí/StrictMode zůstal.
      dropSource(id);
      map.addSource(id, {
        type: "image",
        url: f.url,
        coordinates: CHMI_SAT_CZ_COORDS,
      });
      map.addLayer(
        {
          id: `lyr-${id}`,
          type: "raster",
          source: id,
          paint: {
            "raster-opacity": i === activeSat ? 0.85 : 0,
            "raster-opacity-transition": { duration: 0 },
            "raster-fade-duration": 0,
          },
        },
        beforeId,
      );
      cloudSrcIds.current.push(id);
    });
    return teardown;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, cloudsOn, satKey, basemap, framesKey, source]);

  // Posun oblačnosti podle času aktivního snímku – jen přepnutí průhlednosti
  // přednačtených vrstev, takže se hýbe současně s radarem bez lagu.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !cloudsOn || !cloudSrcIds.current.length) return;
    const cur = frames[index];
    const activeSat = nearestSatIdx(cur ? cur.time : Date.now() / 1000);
    cloudSrcIds.current.forEach((id, i) => {
      const lyr = `lyr-${id}`;
      if (map.getLayer(lyr)) {
        map.setPaintProperty(lyr, "raster-opacity", i === activeSat ? 0.85 : 0);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, mapReady, cloudsOn, satKey, frames, source]);

  // Markery: aktuální místo + oblíbená.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    favorites
      .filter((f) => !sameLocation(f, location))
      .forEach((f) => {
        const el = document.createElement("button");
        el.className = "fav-marker";
        el.type = "button";
        el.title = f.name;
        el.innerHTML = '<span class="fav-dot"></span>';
        el.addEventListener("click", () => onSelect?.(f));
        const m = new maplibregl.Marker({ element: el, anchor: "center" })
          .setLngLat([f.longitude, f.latitude])
          .addTo(map);
        markersRef.current.push(m);
      });

    const locEl = document.createElement("div");
    locEl.className = "loc-marker";
    locEl.title = location.name;
    locEl.innerHTML = '<span class="loc-dot"></span><span class="loc-pulse"></span>';
    const locMarker = new maplibregl.Marker({ element: locEl, anchor: "center" })
      .setLngLat([location.longitude, location.latitude])
      .addTo(map);
    markersRef.current.push(locMarker);
  }, [location, favorites, onSelect]);

  // Vycentrování při změně místa.
  useEffect(() => {
    mapRef.current?.easeTo({
      center: [location.longitude, location.latitude],
      duration: 600,
    });
  }, [location]);

  const fullscreen = modal || expanded;

  // Spolehlivé zamčení scrollu pozadí při celé obrazovce (i na iOS).
  useBodyScrollLock(fullscreen);
  // Esc při celé obrazovce + resize mapy.
  useEffect(() => {
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
  }, [fullscreen, modal, onClose]);

  const allLoaded =
    source === "omforecast"
      ? !!omGrid
      : source === "accum"
        ? !!accumImg
        : frames.length > 0 && loaded.size >= frames.length;

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
    while (idx > 0 && !succeeded.has(`radar-src-${idx}`)) idx--;
    // Když se nepovedlo nic (fallback), zůstaň na nejnovějším.
    setIndex(succeeded.has(`radar-src-${idx}`) ? idx : target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allLoaded, source, playing, nowcastStart, succeeded]);

  useEffect(() => {
    if (!playing || frames.length === 0 || !allLoaded) return;
    timer.current = window.setInterval(() => {
      setIndex((i) => (i + 1) % frames.length);
    }, 500);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [playing, frames.length, allLoaded]);

  const active = frames[index];
  const isForecast =
    source === "omforecast" || (source === "rain" && index >= nowcastStart);
  const spanHours = frames.length > 0 ? frames.length - 1 : 0;
  const lang = getLang();
  const timeLabel = useMemo(() => {
    if (!active) return "";
    const d = new Date(active.time * 1000);
    return `${radarDayLabel(d)} ${clockTime(d)}`;
    // lang v deps: přepočítej popisek i po přepnutí jazyka.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, lang]);

  // Šířka dráhy – podle ní počítáme, kolik časových popisků se vejde vedle sebe.
  const [trackW, setTrackW] = useState(0);

  // Časové popisky u bodů slideru – ukážeme jen ty, které se vedle sebe vejdou.
  // Kandidáti jsou celé hodiny; greedy zleva je řídneme podle změřené šířky, ať
  // na úzké obrazovce nebylo popisků moc a nepřekrývaly se.
  const ticks = useMemo(() => {
    const n = frames.length;
    if (n <= 1) return [];
    const pxPerFrame = trackW > 0 ? trackW / (n - 1) : 0;
    const MIN_GAP = 44; // min. rozestup popisků v px (šířka „14:00“ + rezerva)
    const out: { left: number; label: string }[] = [];
    let lastPx = -Infinity;
    frames.forEach((f, i) => {
      const d = new Date(f.time * 1000);
      if (d.getMinutes() !== 0) return; // popisky jen na celé hodiny
      // Dokud nemáme změřenou šířku, drž se řídkých 6h značek (ať to nepřeteče).
      if (pxPerFrame === 0) {
        if (d.getHours() % 6 === 0)
          out.push({ left: (i / (n - 1)) * 100, label: clockTime(d) });
        return;
      }
      const px = i * pxPerFrame;
      if (px - lastPx >= MIN_GAP) {
        out.push({ left: (i / (n - 1)) * 100, label: clockTime(d) });
        lastPx = px;
      }
    });
    return out;
  }, [frames, trackW]);

  // Scrubování časem přes celou spodní lištu – tažení kdekoliv (ne jen po thumbu).
  // Tažná zóna = celý footer; měříme ale podle vizuální dráhy (trackRef).
  const trackRef = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
  const scrubFrac = frames.length > 1 ? index / (frames.length - 1) : 0;

  // Měření šířky dráhy (trackW deklarován výše, u výpočtu popisků).
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) =>
      setTrackW(entries[0].contentRect.width),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, [frames.length]);

  const scrubTo = (clientX: number) => {
    const el = trackRef.current;
    if (!el || frames.length <= 1) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0) return;
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    setIndex(Math.round(f * (frames.length - 1)));
  };

  const onScrubDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Kliknutí/tap na ovládací prvky (play, nastavení…) nescrubujeme.
    if ((e.target as HTMLElement).closest("button, .radar-settings")) return;
    scrubbing.current = true;
    setPlaying(false);
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubTo(e.clientX);
  };
  const onScrubMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (scrubbing.current) scrubTo(e.clientX);
  };
  const endScrub = (e: React.PointerEvent<HTMLDivElement>) => {
    scrubbing.current = false;
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
                checked={cloudsOn}
                onChange={(e) => setShowClouds(e.target.checked)}
              />
              <span>{tr("Oblačnost")}</span>
            </label>
            <span className="radar-set-note">
              {tr("Oblačnost = družice ČHMÚ (orientačně umístěná).")}
            </span>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <section className={`card radar-card ${fullscreen ? "radar-fullscreen" : ""}`}>
      <div className="radar-map">
        <div ref={containerRef} className="radar-canvas" />

        {source !== "accum" && !errored && frames.length > 0 && (
          <div className={`radar-timebadge ${isForecast ? "forecast" : ""}`}>
            {isForecast ? tr("predikce · {t}", { t: timeLabel }) : timeLabel}
          </div>
        )}

        {modal && (
          <div className="radar-mapctl">
            {settingsControl}
            <button
              type="button"
              className="radar-ctl-btn radar-mapctl-close"
            onClick={() => onClose?.()}
            title={tr("Zavřít radar")}
            aria-label={tr("Zavřít radar")}
            >
              <CloseGlyph />
            </button>
          </div>
        )}

        {errored ? (
          <div className="radar-loading">{tr("Radar není k dispozici")}</div>
        ) : !allLoaded ? (
          <div className="radar-loading">
            {frames.length > 0 ? (
              <>
                <span className="spinner" /> {tr("Přednačítám snímky…")}{" "}
                {loaded.size}/{frames.length}
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
            ? "radar ČHMÚ (CZRAD)"
            : source === "omforecast"
              ? "předpověď Open-Meteo (ICON)"
              : source === "accum"
                ? accumChmi
                  ? "úhrn ČHMÚ (MERGE)"
                  : "úhrn Open-Meteo"
                : "RainViewer"}
          {cloudsOn && " · družice ČHMÚ"}
        </div>
      </div>

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
          className="radar-footer"
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
          <div className="radar-scale">
            <span className="radar-scale-end">
              {source === "chmi"
                ? chmiHours >= 24
                  ? tr("před {n} dny", { n: Math.round(chmiHours / 24) })
                  : tr("před {n} h", { n: chmiHours })
                : source === "omforecast"
                  ? tr("teď")
                  : tr("minulost")}
            </span>
            <span className="radar-scale-end">
              {source === "chmi"
                ? tr("teď")
                : source === "omforecast"
                  ? tr("za {n} h", { n: spanHours })
                  : tr("předpověď")}
            </span>
          </div>

          <div className="radar-bar">
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
              className="play-btn"
              onClick={() => setPlaying((p) => !p)}
              aria-label={playing ? tr("Pozastavit") : tr("Přehrát")}
            >
              {playing ? <PauseGlyph /> : <PlayGlyph />}
            </button>

            <div className="radar-scrub">
              <div className="radar-scrub-track" ref={trackRef}>
                <div className="radar-scrub-line" />
                <div
                  className="radar-scrub-fill"
                  style={{ width: `${scrubFrac * 100}%` }}
                />
                {frames.length > 1 &&
                  frames.map((_, i) => {
                    const status =
                      source === "omforecast"
                        ? "plain"
                        : succeeded.has(`radar-src-${i}`)
                          ? "ok"
                          : "pending";
                    return (
                      <span
                        key={i}
                        className={`radar-scrub-dot ${status}`}
                        style={{ left: `${(i / (frames.length - 1)) * 100}%` }}
                      />
                    );
                  })}
                {ticks.map((t, i) => (
                  <span
                    key={`l${i}`}
                    className="radar-scrub-label"
                    style={{ left: `${t.left}%` }}
                  >
                    {t.label}
                  </span>
                ))}
                <span
                  className="radar-scrub-thumb"
                  style={{ left: `${scrubFrac * 100}%` }}
                />
              </div>
            </div>

            {!modal && settingsControl}
          </div>
        </div>
      )}
    </section>
  );
}

function PlayGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 5l12 7-12 7z" fill="currentColor" />
    </svg>
  );
}

function PauseGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
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
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1l-.4-2.5H10.9l-.4 2.5a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4L4.6 11a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1c.5.4 1.1.8 1.7 1l.4 2.5h4.2l.4-2.5c.6-.2 1.2-.6 1.7-1l2.4 1 2-3.4-2-1.6z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
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
