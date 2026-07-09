import { useEffect, useRef, useState } from "react";
import type { GeoLocation } from "../types";
import { searchLocations, reverseGeocode } from "../lib/openMeteo";
import { tr } from "../lib/i18n";
import { useStoredState } from "../lib/useStoredState";
import { useBodyScrollLock } from "../lib/scrollLock";
import { sameLocation } from "./FavoritesBar";
import MapPicker from "./MapPicker";

const HISTORY_MAX = 8;

// Rozpozná zadané GPS souřadnice ve formátu „lat, lon" (desetinné stupně),
// volitelně s příponou N/S/E/W. Vrací null, když to souřadnice nejsou.
function parseCoords(q: string): { lat: number; lon: number } | null {
  const s = q.trim().replace(/°/g, "");
  const m = s.match(
    /^(-?\d{1,3}(?:\.\d+)?)\s*([NS])?\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*([EW])?$/i,
  );
  if (!m) return null;
  let lat = parseFloat(m[1]);
  let lon = parseFloat(m[3]);
  const latH = m[2]?.toUpperCase();
  const lonH = m[4]?.toUpperCase();
  if (latH === "S") lat = -Math.abs(lat);
  else if (latH === "N") lat = Math.abs(lat);
  if (lonH === "W") lon = -Math.abs(lon);
  else if (lonH === "E") lon = Math.abs(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function coordLabel(lat: number, lon: number): string {
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

interface Props {
  open: boolean;
  onClose: () => void;
  current: GeoLocation | null;
  onSelect: (loc: GeoLocation) => void;
  onLocate: () => void;
  locating: boolean;
  favorites: GeoLocation[];
  isCurrentFav: boolean;
  onToggleCurrent: () => void;
  onToggleFavorite: (loc: GeoLocation) => void;
  onRemove: (loc: GeoLocation) => void;
}

export default function SearchBar({
  open,
  onClose,
  current,
  onSelect,
  onLocate,
  locating,
  favorites,
  isCurrentFav,
  onToggleCurrent,
  onToggleFavorite,
  onRemove,
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeoLocation[]>([]);
  const [loading, setLoading] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [history, setHistory] = useStoredState<GeoLocation[]>(
    "zmoknu.searchHistory",
    [],
  );
  const inputRef = useRef<HTMLInputElement>(null);

  const pushHistory = (loc: GeoLocation) =>
    setHistory(
      [loc, ...history.filter((h) => !sameLocation(h, loc))].slice(
        0,
        HISTORY_MAX,
      ),
    );

  const coords = parseCoords(query);

  useEffect(() => {
    if (query.trim().length < 2 || parseCoords(query)) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await searchLocations(query);
        setResults(r);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  // Po otevření panelu rovnou zaměříme input a vyčistíme starý dotaz.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    } else {
      setQuery("");
      setResults([]);
      setMapOpen(false);
    }
  }, [open]);

  // Zamkni scroll pozadí (spolehlivě i na iOS) + zavírání klávesou Escape.
  useBodyScrollLock(open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function pick(loc: GeoLocation) {
    pushHistory(loc);
    onSelect(loc);
    onClose();
  }

  async function pickCoords(lat: number, lon: number) {
    let name = coordLabel(lat, lon);
    try {
      const rev = await reverseGeocode(lat, lon);
      if (rev && rev !== "Moje poloha") name = rev;
    } catch {
      /* název necháme jako souřadnice */
    }
    const loc: GeoLocation = { name, latitude: lat, longitude: lon };
    pushHistory(loc);
    onSelect(loc);
    setMapOpen(false);
    onClose();
  }

  if (!open) return null;

  const isSearching = query.trim().length >= 2;
  // Historie bez aktuálního místa (to je zobrazené výš samostatně).
  const recent = history.filter(
    (h) => !(current && sameLocation(h, current)),
  );

  return (
    <div className="locpick" role="dialog" aria-modal="true">
      <button
        type="button"
        className="locpick-backdrop"
        aria-label={tr("Zavřít")}
        onClick={onClose}
      />
      <div className="locpick-sheet">
        <div className="locpick-head">
          <h2 className="locpick-title">{tr("Vybrat místo")}</h2>
          <button
            type="button"
            className="locpick-close"
            onClick={onClose}
            aria-label={tr("Zavřít")}
          >
            <CloseX />
          </button>
        </div>

        <div className="locpick-search">
          <SearchGlyph />
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder={tr("Město, obec nebo GPS…")}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={tr("Hledat město")}
          />
          {query && (
            <button
              type="button"
              className="locpick-clear"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              aria-label={tr("Vymazat")}
            >
              <CloseX />
            </button>
          )}
        </div>

        <div className="locpick-body">
          {isSearching && coords ? (
            <section className="locpick-section">
              <div className="locpick-label">{tr("GPS souřadnice")}</div>
              <ul className="locpick-list">
                <li className="locpick-row">
                  <button
                    type="button"
                    className="locpick-pick"
                    onClick={() => pickCoords(coords.lat, coords.lon)}
                  >
                    <PinGlyph />
                    <span className="locpick-rowtext">
                      <span className="locpick-name">
                        {coordLabel(coords.lat, coords.lon)}
                      </span>
                      <span className="locpick-meta">
                        {tr("Zobrazit počasí pro tyto souřadnice")}
                      </span>
                    </span>
                  </button>
                </li>
              </ul>
            </section>
          ) : isSearching ? (
            <section className="locpick-section">
              <div className="locpick-label">
                {loading ? tr("Hledám…") : tr("Výsledky")}
              </div>
              {results.length > 0 ? (
                <ul className="locpick-list">
                  {results.map((r) => {
                    const fav = favorites.some((f) => sameLocation(f, r));
                    return (
                      <li key={`${r.id}-${r.latitude}`} className="locpick-row">
                        <button
                          type="button"
                          className="locpick-pick"
                          onClick={() => pick(r)}
                        >
                          <PinGlyph />
                          <span className="locpick-rowtext">
                            <span className="locpick-name">{r.name}</span>
                            <span className="locpick-meta">
                              {[r.admin1, r.country].filter(Boolean).join(", ")}
                            </span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className={`locpick-star ${fav ? "on" : ""}`}
                          onClick={() => onToggleFavorite(r)}
                          aria-label={
                            fav
                              ? tr("Odebrat z oblíbených")
                              : tr("Přidat do oblíbených")
                          }
                          title={
                            fav
                              ? tr("Odebrat z oblíbených")
                              : tr("Přidat do oblíbených")
                          }
                        >
                          <StarGlyph filled={fav} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                !loading && (
                  <div className="locpick-empty">{tr("Nic nenalezeno")}</div>
                )
              )}
            </section>
          ) : (
            <>
              <button
                type="button"
                className="locpick-locate"
                onClick={onLocate}
                disabled={locating}
              >
                {locating ? <span className="spinner" /> : <LocateGlyph />}
                <span>
                  {locating ? tr("Zjišťuji polohu…") : tr("Použít moji polohu")}
                </span>
              </button>

              <button
                type="button"
                className="locpick-locate subtle"
                onClick={() => setMapOpen(true)}
              >
                <MapGlyph />
                <span>{tr("Vybrat na mapě")}</span>
              </button>

              {current && (
                <section className="locpick-section">
                  <div className="locpick-label">{tr("Aktuální místo")}</div>
                  <div className="locpick-row">
                    <button
                      type="button"
                      className="locpick-pick"
                      onClick={onClose}
                    >
                      <PinGlyph active />
                      <span className="locpick-rowtext">
                        <span className="locpick-name">{current.name}</span>
                        <span className="locpick-meta">
                          {[current.admin1, current.country]
                            .filter(Boolean)
                            .join(", ")}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`locpick-star ${isCurrentFav ? "on" : ""}`}
                      onClick={onToggleCurrent}
                      aria-label={
                        isCurrentFav
                          ? tr("Odebrat z oblíbených")
                          : tr("Přidat do oblíbených")
                      }
                      title={
                        isCurrentFav
                          ? tr("Odebrat z oblíbených")
                          : tr("Přidat do oblíbených")
                      }
                    >
                      <StarGlyph filled={isCurrentFav} />
                    </button>
                  </div>
                </section>
              )}

              {recent.length > 0 && (
                <section className="locpick-section">
                  <div className="locpick-label locpick-label-row">
                    <span>{tr("Naposledy hledané")}</span>
                    <button
                      type="button"
                      className="locpick-clearall"
                      onClick={() => setHistory([])}
                    >
                      {tr("Vymazat")}
                    </button>
                  </div>
                  <ul className="locpick-list">
                    {recent.map((h) => {
                      const fav = favorites.some((f) => sameLocation(f, h));
                      return (
                        <li
                          key={`h-${h.latitude},${h.longitude}`}
                          className="locpick-row"
                        >
                          <button
                            type="button"
                            className="locpick-pick"
                            onClick={() => pick(h)}
                          >
                            <ClockGlyph />
                            <span className="locpick-rowtext">
                              <span className="locpick-name">{h.name}</span>
                              <span className="locpick-meta">
                                {[h.admin1, h.country]
                                  .filter(Boolean)
                                  .join(", ")}
                              </span>
                            </span>
                          </button>
                          <button
                            type="button"
                            className={`locpick-star ${fav ? "on" : ""}`}
                            onClick={() => onToggleFavorite(h)}
                            aria-label={
                              fav
                                ? tr("Odebrat z oblíbených")
                                : tr("Přidat do oblíbených")
                            }
                            title={
                              fav
                                ? tr("Odebrat z oblíbených")
                                : tr("Přidat do oblíbených")
                            }
                          >
                            <StarGlyph filled={fav} />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              <section className="locpick-section">
                <div className="locpick-label">{tr("Oblíbená místa")}</div>
                {favorites.length > 0 ? (
                  <ul className="locpick-list">
                    {favorites.map((f) => {
                      const active = current ? sameLocation(f, current) : false;
                      return (
                        <li
                          key={`${f.latitude},${f.longitude}`}
                          className="locpick-row"
                        >
                          <button
                            type="button"
                            className={`locpick-pick ${active ? "active" : ""}`}
                            onClick={() => pick(f)}
                          >
                            <StarGlyph filled />
                            <span className="locpick-rowtext">
                              <span className="locpick-name">{f.name}</span>
                            </span>
                          </button>
                          <button
                            type="button"
                            className="locpick-remove"
                            onClick={() => onRemove(f)}
                            aria-label={tr("Odebrat {name}", { name: f.name })}
                            title={tr("Odebrat {name}", { name: f.name })}
                          >
                            <CloseX />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <div className="locpick-empty">
                    {tr("Zatím žádná. Vyhledej místo a přidej ho hvězdičkou.")}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>

      <MapPicker
        open={mapOpen}
        initial={{
          lat: current?.latitude ?? 49.82,
          lon: current?.longitude ?? 15.47,
        }}
        onCancel={() => setMapOpen(false)}
        onConfirm={pickCoords}
      />
    </div>
  );
}

function MapGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9 3 3 5v16l6-2 6 2 6-2V3l-6 2-6-2z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M9 3v16M15 5v16" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

function CloseX() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function PinGlyph({ active = false }: { active?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"
        fill={active ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="10" r="2.5" fill={active ? "#fff" : "none"} stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function ClockGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12 7.5V12l3 2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <line x1="16.5" y1="16.5" x2="21" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function LocateGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="2" />
      <line x1="12" y1="2" x2="12" y2="5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="12" y1="19" x2="12" y2="22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="2" y1="12" x2="5" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="19" y1="12" x2="22" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function StarGlyph({ filled }: { filled: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.9 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z"
        fill={filled ? "#ffd166" : "none"}
        stroke={filled ? "#ffd166" : "currentColor"}
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

