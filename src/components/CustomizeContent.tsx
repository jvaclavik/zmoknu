import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tr } from "../lib/i18n";
import { useBodyScrollLock } from "../lib/scrollLock";

export interface WidgetDef {
  id: string;
  label: string;
}

interface Props {
  defs: WidgetDef[];
  enabled: string[];
  hidden: string[];
  onChange: (enabled: string[], hidden: string[]) => void;
  onClose: () => void;
}

// Přesune `id` v poli tak, aby skončil před/za `targetId` (podle `after`).
function moveBefore(
  arr: string[],
  id: string,
  targetId: string,
  after: boolean,
): string[] {
  const a = arr.filter((x) => x !== id);
  let idx = a.indexOf(targetId);
  if (idx < 0) return arr;
  if (after) idx += 1;
  a.splice(idx, 0, id);
  return a;
}

export default function CustomizeContent({
  defs,
  enabled: enabledProp,
  hidden: hiddenProp,
  onChange,
  onClose,
}: Props) {
  const [enabled, setEnabled] = useState<string[]>(enabledProp);
  const [hidden, setHidden] = useState<string[]>(hiddenProp);
  const [dragId, setDragId] = useState<string | null>(null);
  const rowsRef = useRef<Map<string, HTMLElement>>(new Map());

  useBodyScrollLock(true);

  // Změny hned promítneme do rodiče (a tím do localStorage).
  useEffect(() => {
    onChange(enabled, hidden);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, hidden]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const labelFor = (id: string) =>
    tr(defs.find((d) => d.id === id)?.label ?? id);

  const remove = (id: string) => {
    setEnabled((e) => e.filter((x) => x !== id));
    setHidden((h) => (h.includes(id) ? h : [...h, id]));
  };
  const add = (id: string) => {
    setHidden((h) => h.filter((x) => x !== id));
    setEnabled((e) => (e.includes(id) ? e : [...e, id]));
  };

  // Drag & drop (pointer): funguje myší i dotykem. Při přejetí přes jiný řádek
  // přeskládáme pole, přetahovaný řádek si drží zvýraznění.
  const startDrag = (e: React.PointerEvent, id: string) => {
    e.preventDefault();
    setDragId(id);
    const move = (ev: PointerEvent) => {
      const y = ev.clientY;
      let targetId: string | null = null;
      let after = false;
      for (const [rid, el] of rowsRef.current) {
        const r = el.getBoundingClientRect();
        if (y >= r.top && y <= r.bottom) {
          targetId = rid;
          after = y > r.top + r.height / 2;
          break;
        }
      }
      if (targetId && targetId !== id) {
        setEnabled((prev) => moveBefore(prev, id, targetId!, after));
      }
    };
    const up = () => {
      setDragId(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return createPortal(
    <div
      className="dbg-modal"
      role="dialog"
      aria-modal="true"
      aria-label={tr("Přizpůsobit obsah")}
    >
      <div className="dbg-backdrop" onClick={onClose} />
      <div className="dbg-sheet cz-sheet">
        <div className="dbg-head">
          <h2>{tr("Přizpůsobit obsah")}</h2>
          <button
            className="dbg-close"
            onClick={onClose}
            aria-label={tr("Zavřít")}
          >
            <CloseX />
          </button>
        </div>

        <div className="cz-body">
          <p className="cz-note">
            {tr("Přetáhni sekce za úchyt a seřaď je. Skryté můžeš zase přidat.")}
          </p>

          <div className="cz-list">
            {enabled.map((id) => (
              <div
                key={id}
                ref={(el) => {
                  if (el) rowsRef.current.set(id, el);
                  else rowsRef.current.delete(id);
                }}
                className={`cz-row ${dragId === id ? "dragging" : ""}`}
              >
                <button
                  type="button"
                  className="cz-handle"
                  onPointerDown={(e) => startDrag(e, id)}
                  aria-label={tr("Přetáhnout")}
                  title={tr("Přetáhnout")}
                >
                  <GripGlyph />
                </button>
                <span className="cz-name">{labelFor(id)}</span>
                <button
                  type="button"
                  className="cz-remove"
                  onClick={() => remove(id)}
                  aria-label={tr("Odebrat")}
                  title={tr("Odebrat")}
                >
                  <MinusGlyph />
                </button>
              </div>
            ))}
            {enabled.length === 0 && (
              <p className="cz-empty">{tr("Vše skryto – přidej sekce níže.")}</p>
            )}
          </div>

          {hidden.length > 0 && (
            <div className="cz-add">
              <div className="cz-add-title">{tr("Skryté sekce")}</div>
              {hidden.map((id) => (
                <div key={id} className="cz-row cz-row-hidden">
                  <span className="cz-name">{labelFor(id)}</span>
                  <button
                    type="button"
                    className="cz-add-btn"
                    onClick={() => add(id)}
                    aria-label={tr("Přidat")}
                    title={tr("Přidat")}
                  >
                    <PlusGlyph />
                    <span>{tr("Přidat")}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CloseX() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function GripGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  );
}

function MinusGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="#ff5b5b" />
      <path d="M8 12h8" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
