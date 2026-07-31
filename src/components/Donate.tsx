import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import posthog from "posthog-js";
import { tr } from "../lib/i18n";

const BTC_ADDRESS = "openclimbing@lnbits.cz";

const LINKS = [
  { id: "github", href: "https://github.com/sponsors/jvaclavik", label: "GitHub Sponsors" },
  { id: "revolut", href: "https://revolut.me/jvaclavik", label: "Revolut" },
  {
    id: "buymeacoffee",
    href: "https://buymeacoffee.com/openclimbing.org",
    label: "Buy Me a Coffee",
  },
] as const;

export default function Donate() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const openModal = () => {
    posthog.capture("donate_opened");
    setOpen(true);
  };

  const copyBtc = async () => {
    try {
      await navigator.clipboard.writeText(BTC_ADDRESS);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard nedostupný – uživatel adresu opíše ručně */
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="install-hint">
      <button
        type="button"
        className="install-btn"
        onClick={openModal}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <HeartGlyph />
        {tr("Podpořit projekt")}
      </button>

      {open &&
        createPortal(
          <div
            className="dbg-modal"
            role="dialog"
            aria-modal="true"
            aria-label={tr("Podpořit projekt")}
          >
            <div className="dbg-backdrop" onClick={() => setOpen(false)} />
            <div className="dbg-sheet donate-sheet">
              <div className="dbg-head">
                <h2>{tr("Podpořit projekt")}</h2>
                <button
                  type="button"
                  className="dbg-close"
                  onClick={() => setOpen(false)}
                  aria-label={tr("Zavřít")}
                >
                  <CloseX />
                </button>
              </div>

              <div className="donate-panel">
                {LINKS.map((l) => (
                  <a
                    key={l.id}
                    className="donate-link"
                    href={l.href}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() =>
                      posthog.capture("donate_link_clicked", { via: l.id })
                    }
                  >
                    {l.label}
                  </a>
                ))}

                <div className="donate-btc">
                  <img
                    className="donate-qr"
                    src="/btc-qr.png"
                    alt={tr("QR kód pro platbu Bitcoin / Lightning")}
                    width={116}
                    height={116}
                    loading="lazy"
                  />
                  <div className="donate-btc-info">
                    <span className="donate-btc-label">Bitcoin / Lightning</span>
                    <button
                      type="button"
                      className="donate-copy"
                      onClick={copyBtc}
                      title={tr("Kopírovat adresu")}
                    >
                      <code>{BTC_ADDRESS}</code>
                      <span className="donate-copy-hint">
                        {copied ? tr("Zkopírováno") : tr("Kopírovat")}
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

function CloseX() {
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
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function HeartGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20.5S3.5 14.8 3.5 8.9A4.4 4.4 0 0 1 12 7a4.4 4.4 0 0 1 8.5 1.9c0 5.9-8.5 11.6-8.5 11.6Z" />
    </svg>
  );
}
