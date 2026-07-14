import { useEffect, useState } from "react";
import { fetchWebcams, type Webcam } from "../lib/webcams";
import { tr } from "../lib/i18n";
import { WindyCourtesy } from "./WebcamModal";

interface Props {
  lat: number;
  lon: number;
}

export default function Webcams({ lat, lon }: Props) {
  const [cams, setCams] = useState<Webcam[]>([]);
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  // Pro které místo už máme kamery načtené (aby se při zavření/otevření
  // nestahovaly znovu, ale po změně lokace ano).
  const [fetchedKey, setFetchedKey] = useState<string | null>(null);

  const key = `${lat},${lon}`;

  // Změna lokace → zahodíme dosavadní kamery a vynutíme nové načtení při otevření.
  useEffect(() => {
    setCams([]);
    setActiveId(null);
    setFetchedKey(null);
  }, [key]);

  // Kamery stahujeme až po otevření sekce (a jen jednou na místo).
  useEffect(() => {
    if (!open || fetchedKey === key) return;
    let cancelled = false;
    setLoading(true);
    fetchWebcams(lat, lon)
      .then((c) => {
        if (cancelled) return;
        setCams(c);
        setFetchedKey(key);
      })
      .catch(() => {
        if (cancelled) return;
        setCams([]);
        setFetchedKey(key);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, key, fetchedKey, lat, lon]);

  const loaded = fetchedKey === key;
  const active = cams.find((c) => c.id === activeId) ?? null;
  const embed = active ? active.liveEmbed || active.dayEmbed : null;

  const onPick = (c: Webcam) => {
    // Kamera s přehrávačem/náhledem se rozbalí přímo v kartě; bez nich vede
    // rovnou na detail na Windy.
    if (c.liveEmbed || c.dayEmbed || c.preview) {
      setActiveId((id) => (id === c.id ? null : c.id));
    } else if (c.detailUrl) {
      window.open(c.detailUrl, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <section className="card webcams-card">
      <button
        type="button"
        className={`details-head ${open ? "open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <CamIcon />
        <span className="details-title">{tr("Webkamery v okolí")}</span>
        {loaded && cams.length > 0 && (
          <span className="webcams-count">{cams.length}</span>
        )}
        <Chevron open={open} />
      </button>

      {open && (
        <div className="webcams-body">
          {loading && (
            <p className="webcams-empty">
              <span className="spinner" /> {tr("Načítám webkamery…")}
            </p>
          )}
          {loaded && !cams.length && !loading && (
            <p className="webcams-empty">
              {tr("V okolí nejsou žádné webkamery.")}
            </p>
          )}
          {active && (
            <div className="webcam-player">
              {embed ? (
                <iframe
                  key={active.id}
                  src={embed}
                  title={active.title}
                  loading="lazy"
                  allow="autoplay; fullscreen"
                  allowFullScreen
                />
              ) : active.preview ? (
                <img src={active.preview} alt={active.title} loading="lazy" />
              ) : null}
              <div className="webcam-player-foot">
                <span className="webcam-player-title">{active.title}</span>
                {active.detailUrl && (
                  <a
                    href={active.detailUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {tr("Otevřít na Windy")}
                  </a>
                )}
              </div>
            </div>
          )}

          {cams.length > 0 && (
          <div className="webcams-scroll">
            {cams.map((c) => (
              <button
                type="button"
                key={c.id}
                className={`webcam-item ${activeId === c.id ? "active" : ""}`}
                onClick={() => onPick(c)}
                title={c.title}
              >
                <span className="webcam-thumb">
                  {c.thumbnail || c.preview ? (
                    <img
                      src={c.thumbnail || (c.preview as string)}
                      alt={c.title}
                      loading="lazy"
                    />
                  ) : (
                    <CamIcon />
                  )}
                  {c.live && <span className="webcam-live">{tr("živě")}</span>}
                </span>
                <span className="webcam-meta">
                  <span className="webcam-name">{c.city || c.title}</span>
                  {c.distanceKm != null && (
                    <span className="webcam-dist">{c.distanceKm} km</span>
                  )}
                </span>
              </button>
            ))}
          </div>
          )}

          {cams.length > 0 && (
            <div className="webcams-src">
              <WindyCourtesy />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function CamIcon() {
  return (
    <svg
      className="webcams-ico"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m23 7-7 5 7 5V7z" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{
        transform: open ? "rotate(180deg)" : "none",
        transition: "transform 0.2s",
        flexShrink: 0,
      }}
    >
      <path
        d="M6 9l6 6 6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
