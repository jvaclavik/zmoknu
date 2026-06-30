import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { GeoLocation, RadarData } from "../types";
import { radarTileUrl } from "../lib/rainviewer";
import { buildChmiRadar, CHMI_BOUNDS, isInChmiCoverage } from "../lib/chmi";
import { clockTime } from "../lib/format";
import { darkStyle, loadTouristStyle, loadTouristDarkStyle } from "../lib/mapStyle";
import { useStoredState } from "../lib/useStoredState";
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

type Source = "rain" | "chmi";

// Rohy ČHMÚ snímku jako [lon, lat] (pro image source MapLibre).
const [[chmiS, chmiW], [chmiN, chmiE]] = CHMI_BOUNDS;
const CHMI_COORDS: [[number, number], [number, number], [number, number], [number, number]] = [
  [chmiW, chmiN],
  [chmiE, chmiN],
  [chmiE, chmiS],
  [chmiW, chmiS],
];

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
  const [expanded, setExpanded] = useState(false);
  const [chmiTick, setChmiTick] = useState(0);
  const [chmiHours, setChmiHours] = useStoredState<number>("zmoknu.chmiHours", 6);
  const [mapReady, setMapReady] = useState(false);
  const [basemap, setBasemap] = useStoredState<Basemap>("zmoknu.basemap", "tourist");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const radarSrcIds = useRef<string[]>([]);
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

  const data = source === "chmi" ? chmiRadar : radar;
  const frames = useMemo(() => data?.frames ?? [], [data]);
  const nowcastStart = data?.nowcastStartIndex ?? frames.length;

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
    const settle = (sourceId?: string) => {
      if (!sourceId?.startsWith("radar-src-")) return;
      setLoaded((prev) => {
        if (prev.has(sourceId)) return prev;
        const next = new Set(prev);
        next.add(sourceId);
        return next;
      });
    };
    const onSourceData = (e: maplibregl.MapSourceDataEvent) => {
      if (e.isSourceLoaded) settle(e.sourceId);
    };
    const onError = (e: maplibregl.ErrorEvent) => {
      settle((e as { sourceId?: string }).sourceId);
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
    setMapReady(false);
    radarSrcIds.current = [];
    const applyStyle = (style: maplibregl.StyleSpecification) => {
      if (cancelled) return;
      // diff:false vynutí plný reload stylu – jinak může MapLibre udělat jen
      // „diff" a událost style.load se znovu nespustí (radar by se nepřidal).
      map.setStyle(style, { diff: false });
      const markReady = () => {
        if (!cancelled) setMapReady(true);
      };
      if (map.isStyleLoaded()) markReady();
      else map.once("style.load", markReady);
    };
    const loader = basemap === "dark" ? loadTouristDarkStyle : loadTouristStyle;
    loader()
      .then(applyStyle)
      .catch(() => applyStyle(darkStyle));
    return () => {
      cancelled = true;
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
    setLoaded(new Set());

    const startIdx = Math.max(0, nowcastStart - 1);
    setIndex(startIdx);

    frames.forEach((f, i) => {
      const id = `radar-src-${i}`;
      if (source === "chmi") {
        map.addSource(id, { type: "image", url: f.path, coordinates: CHMI_COORDS });
      } else if (radar) {
        map.addSource(id, {
          type: "raster",
          tiles: [radarTileUrl(radar.host, f.path)],
          tileSize: 256,
          // RainViewer nad svým maximem vykresluje do dlaždice text
          // „zoom level not supported" – omezíme maxzoom, MapLibre pak
          // dlaždici jen zvětší (rozostří) místo načtení nepodporované.
          maxzoom: 10,
        });
      } else {
        return;
      }
      map.addLayer({
        id: `lyr-${id}`,
        type: "raster",
        source: id,
        paint: {
          "raster-opacity": i === startIdx ? 0.8 : 0,
          "raster-opacity-transition": { duration: 0 },
          "raster-fade-duration": 0,
        },
      });
      radarSrcIds.current.push(id);
    });

    // Pojistka: kdyby se některý snímek nikdy neohlásil (pomalá síť, tichá
    // chyba), po 8 s přednačítání i tak dokončíme, aby šlo přehrávat.
    const ids = radarSrcIds.current.slice();
    const safety = window.setTimeout(() => setLoaded(new Set(ids)), 8000);
    return () => window.clearTimeout(safety);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, source, framesKey]);

  // Přepínání viditelného snímku.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    frames.forEach((_, i) => {
      const lyr = `lyr-radar-src-${i}`;
      if (map.getLayer(lyr)) {
        map.setPaintProperty(lyr, "raster-opacity", i === index ? 0.8 : 0);
      }
    });
  }, [index, mapReady, frames]);

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

  // Zamknout scroll a Esc při celé obrazovce + resize mapy.
  useEffect(() => {
    if (!fullscreen) {
      const t = setTimeout(() => mapRef.current?.resize(), 80);
      return () => clearTimeout(t);
    }
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (modal) onClose?.();
      else setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    const t = setTimeout(() => mapRef.current?.resize(), 80);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [fullscreen, modal, onClose]);

  const allLoaded = frames.length > 0 && loaded.size >= frames.length;

  useEffect(() => {
    if (!playing || frames.length === 0 || !allLoaded) return;
    timer.current = window.setInterval(() => {
      setIndex((i) => (i + 1) % frames.length);
    }, 700);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [playing, frames.length, allLoaded]);

  const active = frames[index];
  const isForecast = source === "rain" && index >= nowcastStart;
  const timeLabel = useMemo(() => {
    if (!active) return "";
    const d = new Date(active.time * 1000);
    return `${radarDayLabel(d)} ${clockTime(d)}`;
  }, [active]);

  // Značky na slideru – tečka u každého snímku, zvýrazněná na celých hodinách.
  const ticks = useMemo(() => {
    const n = frames.length;
    if (n <= 1) return [];
    return frames.map((f, i) => {
      const d = new Date(f.time * 1000);
      return {
        left: (i / (n - 1)) * 100,
        hour: d.getMinutes() === 0,
        major: d.getMinutes() === 0 && d.getHours() % 6 === 0,
      };
    });
  }, [frames]);

  return (
    <section className={`card radar-card ${fullscreen ? "radar-fullscreen" : ""}`}>
      <div className="radar-map">
        <div ref={containerRef} className="radar-canvas" />

        {frames.length === 0 ? (
          <div className="radar-loading">
            {source === "rain" && radarStatus === "error" ? (
              "Radar není k dispozici"
            ) : (
              <>
                <span className="spinner" /> Načítám radar…
              </>
            )}
          </div>
        ) : (
          !allLoaded && (
            <div className="radar-loading">
              <span className="spinner" /> Přednačítám snímky… {loaded.size}/
              {frames.length}
            </div>
          )
        )}

        <div className="radar-attr">
          © OpenStreetMap · {basemap === "tourist" ? "MapTiler" : "CARTO"} ·{" "}
          {source === "chmi" ? "radar ČHMÚ (CZRAD)" : "RainViewer"}
        </div>
      </div>

      <div className="radar-scale">
        <span>
          {source === "chmi"
            ? chmiHours >= 24
              ? `před ${Math.round(chmiHours / 24)} dny`
              : `před ${chmiHours} h`
            : "minulost"}
        </span>
        {source === "rain" && (
          <span
            className="radar-now-marker"
            style={{ left: `${(nowcastStart / Math.max(1, frames.length)) * 100}%` }}
          >
            nyní
          </span>
        )}
        <span>{source === "chmi" ? "teď" : "předpověď"}</span>
      </div>

      <div className="radar-bar">
        {modal && (
          <button
            type="button"
            className="radar-ctl-btn"
            onClick={() => onClose?.()}
            title="Zavřít"
            aria-label="Zavřít radar"
          >
            <CloseGlyph />
          </button>
        )}
        {!modal && (
          <button
            type="button"
            className="radar-ctl-btn"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "Zmenšit" : "Na celou obrazovku"}
            aria-label={expanded ? "Zmenšit radar" : "Radar na celou obrazovku"}
          >
            {expanded ? <CompressGlyph /> : <ExpandGlyph />}
          </button>
        )}

        <button
          type="button"
          className="play-btn"
          onClick={() => setPlaying((p) => !p)}
          aria-label={playing ? "Pozastavit" : "Přehrát"}
        >
          {playing ? <PauseGlyph /> : <PlayGlyph />}
        </button>

        <div className="radar-slider-wrap">
          <div className="radar-ticks">
            {ticks.map((t, i) =>
              t.hour ? (
                <span
                  key={i}
                  className={`radar-tick ${t.major ? "major" : ""}`}
                  style={{ left: `${t.left}%` }}
                />
              ) : null,
            )}
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(0, frames.length - 1)}
            value={index}
            onChange={(e) => {
              setPlaying(false);
              setIndex(Number(e.target.value));
            }}
            className="radar-slider"
            style={{ ["--pct" as string]: `${(index / Math.max(1, frames.length - 1)) * 100}%` }}
            aria-label="Posuvník času radaru"
          />
        </div>

        <span className={`radar-tag ${isForecast ? "forecast" : ""}`}>
          {isForecast ? `predikce · ${timeLabel}` : timeLabel}
        </span>

        <div className="radar-settings" ref={settingsRef}>
          <button
            type="button"
            className={`radar-ctl-btn ${settingsOpen ? "active" : ""}`}
            onClick={() => setSettingsOpen((o) => !o)}
            title="Nastavení radaru"
            aria-label="Nastavení radaru"
            aria-expanded={settingsOpen}
          >
            <GearGlyph />
          </button>

          {settingsOpen && (
            <div className="radar-settings-panel">
              {inCz && (
                <div className="radar-set-group">
                  <span className="radar-set-label">Zdroj</span>
                  <div className="radar-seg">
                    <button
                      className={source === "chmi" ? "active" : ""}
                      onClick={() => setSource("chmi")}
                    >
                      ČHMÚ · ČR
                    </button>
                    <button
                      className={source === "rain" ? "active" : ""}
                      onClick={() => setSource("rain")}
                    >
                      RainViewer · svět
                    </button>
                  </div>
                </div>
              )}

              {inCz && source === "chmi" && (
                <div className="radar-set-group">
                  <span className="radar-set-label">Interval</span>
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
                <span className="radar-set-label">Mapa</span>
                <div className="radar-seg">
                  <button
                    className={basemap === "tourist" ? "active" : ""}
                    onClick={() => setBasemap("tourist")}
                  >
                    Světlá
                  </button>
                  <button
                    className={basemap === "dark" ? "active" : ""}
                    onClick={() => setBasemap("dark")}
                  >
                    Tmavá
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
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
  if (diff === 0) return "Dnes";
  if (diff === -1) return "Včera";
  if (diff === 1) return "Zítra";
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
