import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { Webcam } from "../lib/webcams";
import { useBodyScrollLock } from "../lib/scrollLock";
import { tr } from "../lib/i18n";

// Povinná atribuce Windy (Terms of Use → Courtesy). Nesmí chybět tam, kde se
// webkamery zobrazují. Znění a odkazy dle specifikace Windy.
export function WindyCourtesy() {
  return (
    <span className="windy-courtesy">
      {tr("Webkamery poskytuje")}{" "}
      <a href="https://www.windy.com/" target="_blank" rel="noopener noreferrer">
        windy.com
      </a>
    </span>
  );
}

interface Props {
  webcam: Webcam;
  onClose: () => void;
}

export default function WebcamModal({ webcam, onClose }: Props) {
  useBodyScrollLock(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Embed (timelapse přehrávač) splňuje podmínku „link every image“, takže
  // uživatele nikam neposíláme. Když embed není, ukážeme aspoň náhled.
  const embed = webcam.dayEmbed || webcam.liveEmbed;
  const bits = [
    webcam.city,
    webcam.distanceKm != null ? `${webcam.distanceKm} km` : "",
  ].filter(Boolean);

  return createPortal(
    <div
      className="webcam-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={webcam.title}
    >
      <div className="webcam-modal" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="webcam-modal-close"
          onClick={onClose}
          aria-label={tr("Zavřít")}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M6 6l12 12M18 6L6 18"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <div className="webcam-modal-view">
          {embed ? (
            <iframe
              src={embed}
              title={webcam.title}
              loading="lazy"
              allow="autoplay; fullscreen"
              allowFullScreen
            />
          ) : webcam.preview ? (
            <img src={webcam.preview} alt={webcam.title} loading="lazy" />
          ) : null}
        </div>
        <div className="webcam-modal-info">
          <div className="webcam-modal-title">{webcam.title}</div>
          {bits.length > 0 && (
            <div className="webcam-modal-meta">{bits.join(" · ")}</div>
          )}
          <WindyCourtesy />
        </div>
      </div>
    </div>,
    document.body,
  );
}
