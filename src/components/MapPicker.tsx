import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { tr } from "../lib/i18n";
import { useBodyScrollLock } from "../lib/scrollLock";
import { darkStyle, loadTouristStyle } from "../lib/mapStyle";

interface Props {
  open: boolean;
  initial: { lat: number; lon: number };
  onCancel: () => void;
  onConfirm: (lat: number, lon: number) => void;
}

// Výběr místa na mapě: MapLibre s pevným křížem uprostřed. Uživatel posouvá
// mapou a potvrzením vezmeme střed (map.getCenter()).
export default function MapPicker({ open, initial, onCancel, onConfirm }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [center, setCenter] = useState<{ lat: number; lon: number }>(initial);

  useEffect(() => {
    if (!open || !containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: darkStyle,
      center: [initial.lon, initial.lat],
      zoom: 9,
      attributionControl: false,
    });
    mapRef.current = map;

    // Turistický styl se načítá asynchronně – když je klíč k dispozici.
    loadTouristStyle()
      .then((s) => map.setStyle(s))
      .catch(() => {
        /* fallback zůstane tmavý CARTO podklad */
      });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");

    const onMove = () => {
      const c = map.getCenter();
      setCenter({ lat: c.lat, lon: c.lng });
    };
    map.on("move", onMove);
    onMove();

    return () => {
      map.off("move", onMove);
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useBodyScrollLock(open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="mappick" role="dialog" aria-modal="true">
      <div className="mappick-head">
        <button
          type="button"
          className="mappick-back"
          onClick={onCancel}
          aria-label={tr("Zpět")}
        >
          <BackGlyph />
          <span>{tr("Zpět")}</span>
        </button>
        <span className="mappick-coords">
          {center.lat.toFixed(4)}, {center.lon.toFixed(4)}
        </span>
      </div>

      <div className="mappick-map" ref={containerRef}>
        <span className="mappick-crosshair" aria-hidden="true">
          <PinGlyph />
        </span>
      </div>

      <div className="mappick-foot">
        <button
          type="button"
          className="mappick-confirm"
          onClick={() => onConfirm(center.lat, center.lon)}
        >
          {tr("Vybrat toto místo")}
        </button>
      </div>
    </div>
  );
}

function BackGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PinGlyph() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 22s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"
        fill="var(--accent)"
        stroke="#05203a"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="11" r="2.5" fill="#fff" />
    </svg>
  );
}
