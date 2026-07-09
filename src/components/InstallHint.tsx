import { useEffect, useState } from "react";
import { getLang, tr } from "../lib/i18n";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS Safari
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  const ua = navigator.userAgent || "";
  return /iphone|ipad|ipod/i.test(ua);
}

export default function InstallHint() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null,
  );
  const [open, setOpen] = useState(false);
  const [installed, setInstalled] = useState(isStandalone());

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) return null;

  const ios = isIos();

  const install = async () => {
    if (!deferred) {
      setOpen((o) => !o);
      return;
    }
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  };

  return (
    <div className="install-hint">
      <button
        type="button"
        className="install-btn"
        onClick={deferred ? install : () => setOpen((o) => !o)}
        aria-expanded={deferred ? undefined : open}
      >
        <PhoneGlyph />
        {deferred ? tr("Nainstalovat aplikaci") : tr("Nainstalovat do telefonu")}
      </button>

      {open && !deferred && (
        <div className="install-steps">
          {ios ? (
            <ol>
              <li>
                {tr("V Safari klepni na")} <ShareGlyph />{" "}
                <strong>{tr("Sdílet")}</strong>.
              </li>
              <li>
                {tr("Zvol")} <strong>{tr("Přidat na plochu")}</strong>.
              </li>
              <li>{tr("Potvrď „Přidat“ – appka bude na ploše jako ikona.")}</li>
            </ol>
          ) : (
            <ol>
              <li>
                {tr("Otevři menu prohlížeče")} <DotsGlyph />.
              </li>
              <li>
                {tr("Zvol")}{" "}
                <strong>
                  {getLang() === "en"
                    ? "Install app / Add to Home screen"
                    : "Nainstalovat aplikaci / Přidat na plochu"}
                </strong>
                .
              </li>
              <li>{tr("Potvrď – appka se přidá mezi aplikace.")}</li>
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function PhoneGlyph() {
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
      <rect x="7" y="2.5" width="10" height="19" rx="2.4" />
      <path d="M11 18.5h2" />
    </svg>
  );
}

function ShareGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ verticalAlign: "-2px" }}
    >
      <path d="M12 15V3M8.5 6.5 12 3l3.5 3.5" />
      <path d="M6 12v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7" />
    </svg>
  );
}

function DotsGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      style={{ verticalAlign: "-2px" }}
    >
      <circle cx="12" cy="5" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="12" cy="19" r="1.7" />
    </svg>
  );
}
