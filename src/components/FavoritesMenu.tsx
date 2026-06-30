import { useEffect, useRef, useState } from "react";
import type { GeoLocation } from "../types";
import { sameLocation } from "./FavoritesBar";

interface Props {
  favorites: GeoLocation[];
  current: GeoLocation;
  onSelect: (loc: GeoLocation) => void;
}

export default function FavoritesMenu({ favorites, current, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  if (favorites.length === 0) return null;

  return (
    <div className="favmenu" ref={boxRef}>
      <button
        type="button"
        className={`favmenu-btn ${open ? "open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title="Oblíbená místa"
        aria-label="Oblíbená místa"
      >
        <StarGlyph />
        <ChevronDown />
      </button>
      {open && (
        <ul className="favmenu-list">
          {favorites.map((f) => {
            const active = sameLocation(f, current);
            return (
              <li key={`${f.latitude},${f.longitude}`}>
                <button
                  type="button"
                  className={active ? "active" : ""}
                  onClick={() => {
                    onSelect(f);
                    setOpen(false);
                  }}
                >
                  {active && <span className="favmenu-dot" />}
                  <span className="favmenu-name">{f.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function StarGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.9 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z"
        fill="#ffd166"
        stroke="#ffd166"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg className="favmenu-chevron" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
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
