import { useEffect, useRef, useState } from "react";
import type { GeoLocation } from "../types";
import { searchLocations } from "../lib/openMeteo";
import { tr } from "../lib/i18n";
import { sameLocation } from "./FavoritesBar";

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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
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
    }
  }, [open]);

  // Zamkni scroll pozadí + zavírání klávesou Escape, když je modál otevřený.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  function pick(loc: GeoLocation) {
    onSelect(loc);
    onClose();
  }

  if (!open) return null;

  const isSearching = query.trim().length >= 2;

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
            placeholder={tr("Hledat město nebo obec…")}
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
          {isSearching ? (
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
    </div>
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

