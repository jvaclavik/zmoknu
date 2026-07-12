import { useState } from "react";
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

  const toggle = () => {
    setOpen((o) => {
      if (!o) posthog.capture("donate_opened");
      return !o;
    });
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

  return (
    <div className="install-hint">
      <button
        type="button"
        className="install-btn"
        onClick={toggle}
        aria-expanded={open}
      >
        <HeartGlyph />
        {tr("Podpořit projekt")}
      </button>

      {open && (
        <div className="donate-panel">
          {LINKS.map((l) => (
            <a
              key={l.id}
              className="donate-link"
              href={l.href}
              target="_blank"
              rel="noreferrer"
              onClick={() => posthog.capture("donate_link_clicked", { via: l.id })}
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
      )}
    </div>
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
