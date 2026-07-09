import { useEffect, useState } from "react";
import { fetchChmiAlerts, type ChmiAlert } from "../lib/chmiAlerts";
import { getLang, tr } from "../lib/i18n";

interface Props {
  lat: number;
  lon: number;
}

function fmtRange(expires: string): string {
  const en = getLang() === "en";
  const e = new Date(expires);
  if (!Number.isFinite(e.getTime())) return "";
  const loc = en ? "en-GB" : "cs-CZ";
  const now = new Date();
  const sameDay =
    e.getDate() === now.getDate() &&
    e.getMonth() === now.getMonth() &&
    e.getFullYear() === now.getFullYear();
  const time = e.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
  const day = `${e.getDate()}. ${e.getMonth() + 1}.`;
  const until = sameDay ? time : `${day} ${time}`;
  return en ? `until ${until}` : `platí do ${until}`;
}

export default function WeatherAlerts({ lat, lon }: Props) {
  const [alerts, setAlerts] = useState<ChmiAlert[]>([]);

  useEffect(() => {
    let cancelled = false;
    setAlerts([]);
    fetchChmiAlerts(lat, lon)
      .then((a) => !cancelled && setAlerts(a))
      .catch(() => !cancelled && setAlerts([]));
    return () => {
      cancelled = true;
    };
  }, [lat, lon]);

  if (!alerts.length) return null;
  const en = getLang() === "en";

  return (
    <div className="wx-alerts" role="region" aria-label={tr("Výstrahy ČHMÚ")}>
      {alerts.map((a, i) => {
        const title = en ? a.eventEn : a.event;
        const desc = en ? a.descriptionEn : a.description;
        return (
          <details className={`wx-alert lvl-${a.color}`} key={`${title}-${i}`}>
            <summary>
              <WarnIcon />
              <span className="wx-alert-title">{title}</span>
              <span className="wx-alert-when">{fmtRange(a.expires)}</span>
              {desc && <ChevronMini />}
            </summary>
            {desc && <p className="wx-alert-desc">{desc}</p>}
          </details>
        );
      })}
    </div>
  );
}

function WarnIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="wx-alert-ico"
    >
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

function ChevronMini() {
  return (
    <svg
      className="wx-alert-chev"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
