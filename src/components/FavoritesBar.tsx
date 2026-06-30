import { useState } from "react";
import type { GeoLocation } from "../types";

interface Props {
  favorites: GeoLocation[];
  current: GeoLocation;
  isCurrentFav: boolean;
  onSelect: (loc: GeoLocation) => void;
  onToggleCurrent: () => void;
  onRemove: (loc: GeoLocation) => void;
}

export function sameLocation(a: GeoLocation, b: GeoLocation): boolean {
  return (
    Math.abs(a.latitude - b.latitude) < 0.02 &&
    Math.abs(a.longitude - b.longitude) < 0.02
  );
}

export default function FavoritesBar({
  favorites,
  current,
  isCurrentFav,
  onSelect,
  onToggleCurrent,
  onRemove,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [shared, setShared] = useState(false);

  async function share() {
    const url = window.location.href;
    const title = `Počasí – ${current.name}`;
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
    <div className="favbar">
      <button
        type="button"
        className={`fav-toggle ${isCurrentFav ? "on" : ""}`}
        onClick={onToggleCurrent}
        title={isCurrentFav ? "Odebrat z oblíbených" : "Přidat do oblíbených"}
      >
        <StarGlyph filled={isCurrentFav} />
        <span>{isCurrentFav ? "Uloženo" : "Uložit"}</span>
      </button>

      <button
        type="button"
        className={`fav-share ${shared ? "ok" : ""}`}
        onClick={share}
        title="Sdílet odkaz na toto místo"
      >
        <ShareGlyph />
        <span>{shared ? "Zkopírováno" : "Sdílet"}</span>
      </button>

      <div className="fav-chips">
        {favorites.map((f) => {
          const active = sameLocation(f, current);
          return (
            <span
              key={`${f.latitude},${f.longitude}`}
              className={`fav-chip ${active ? "active" : ""} ${editing ? "editing" : ""}`}
            >
              <button
                type="button"
                className="fav-chip-name"
                onClick={() => onSelect(f)}
              >
                {f.name}
              </button>
              {editing && (
                <button
                  type="button"
                  className="fav-chip-x"
                  onClick={() => onRemove(f)}
                  title="Odebrat"
                  aria-label={`Odebrat ${f.name}`}
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
      </div>

      {favorites.length > 0 && (
        <button
          type="button"
          className={`fav-edit ${editing ? "on" : ""}`}
          onClick={() => setEditing((e) => !e)}
          title={editing ? "Hotovo" : "Upravit oblíbená"}
        >
          {editing ? "Hotovo" : <PencilGlyph />}
        </button>
      )}
    </div>
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

function StarGlyph({ filled }: { filled: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
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

function PencilGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
