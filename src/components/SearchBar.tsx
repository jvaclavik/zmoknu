import { useEffect, useRef, useState } from "react";
import type { GeoLocation } from "../types";
import { searchLocations } from "../lib/openMeteo";
import { sameLocation } from "./FavoritesBar";

interface Props {
  current: GeoLocation | null;
  onSelect: (loc: GeoLocation) => void;
  onLocate: () => void;
  locating: boolean;
  favorites: GeoLocation[];
  isCurrentFav: boolean;
  onToggleCurrent: () => void;
  onRemove: (loc: GeoLocation) => void;
}

export default function SearchBar({
  current,
  onSelect,
  onLocate,
  locating,
  favorites,
  isCurrentFav,
  onToggleCurrent,
  onRemove,
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeoLocation[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [shared, setShared] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  // Po otevření panelu rovnou zaměříme input.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  function pick(loc: GeoLocation) {
    onSelect(loc);
    setQuery("");
    setResults([]);
    setOpen(false);
  }

  async function share() {
    const url = window.location.href;
    const title = current ? `Počasí – ${current.name}` : "Počasí";
    try {
      if (navigator.share) {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setShared(true);
      setTimeout(() => setShared(false), 1800);
    } catch {
      /* uživatel zrušil sdílení nebo schránka není dostupná */
    }
  }

  return (
    <div className="searchbar" ref={boxRef}>
      <button
        type="button"
        className={`search-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title="Hledat místo"
        aria-label="Hledat místo"
        aria-expanded={open}
      >
        <SearchGlyph />
        <span className="search-trigger-name">
          {current ? current.name : "Hledat"}
        </span>
        <ChevronDown />
      </button>

      {open && (
        <div className="search-panel">
          <div className="search-input-wrap">
            <SearchGlyph />
            <input
              ref={inputRef}
              type="text"
              value={query}
              placeholder="Hledat město…"
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Hledat město"
            />
            {loading && <span className="spinner" aria-hidden="true" />}
            <button
              type="button"
              className="locate-btn"
              onClick={onLocate}
              disabled={locating}
              title="Použít moji polohu"
              aria-label="Použít moji polohu"
            >
              {locating ? <span className="spinner" /> : <LocateGlyph />}
            </button>
          </div>

          {results.length > 0 && (
            <ul className="search-results">
              {results.map((r) => (
                <li key={`${r.id}-${r.latitude}`}>
                  <button type="button" onClick={() => pick(r)}>
                    <span className="res-name">{r.name}</span>
                    <span className="res-meta">
                      {[r.admin1, r.country].filter(Boolean).join(", ")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Uložení aktuálního místa + sdílení */}
          {current && (
            <div className="search-actions">
              <button
                type="button"
                className={`search-save ${isCurrentFav ? "on" : ""}`}
                onClick={onToggleCurrent}
                title={
                  isCurrentFav ? "Odebrat z oblíbených" : "Přidat do oblíbených"
                }
              >
                <StarGlyph filled={isCurrentFav} />
                {isCurrentFav ? "Uloženo" : `Uložit „${current.name}"`}
              </button>
              <button
                type="button"
                className={`search-share ${shared ? "ok" : ""}`}
                onClick={share}
                title="Sdílet odkaz na toto místo"
              >
                <ShareGlyph />
                {shared ? "Zkopírováno" : "Sdílet"}
              </button>
            </div>
          )}

          {/* Seznam oblíbených se smazáním */}
          {favorites.length > 0 && (
            <>
              <div className="search-fav-title">Oblíbená místa</div>
              <ul className="search-fav-list">
                {favorites.map((f) => {
                  const active = current ? sameLocation(f, current) : false;
                  return (
                    <li key={`${f.latitude},${f.longitude}`}>
                      <button
                        type="button"
                        className={`search-fav-pick ${active ? "active" : ""}`}
                        onClick={() => pick(f)}
                      >
                        {active && <span className="search-fav-dot" />}
                        <span className="search-fav-name">{f.name}</span>
                      </button>
                      <button
                        type="button"
                        className="search-fav-x"
                        onClick={() => onRemove(f)}
                        title={`Odebrat ${f.name}`}
                        aria-label={`Odebrat ${f.name}`}
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
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

function ChevronDown() {
  return (
    <svg
      className="search-chevron"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        d="M6 9l6 6 6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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

function ShareGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="6" cy="12" r="2.4" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="18" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="18" cy="18" r="2.4" stroke="currentColor" strokeWidth="1.8" />
      <line x1="8" y1="11" x2="16" y2="7" stroke="currentColor" strokeWidth="1.8" />
      <line x1="8" y1="13" x2="16" y2="17" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}
