import { useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { tr, useLang } from "../lib/i18n";

// Jak často zkontrolovat, jestli není na serveru novější verze (i když je
// PWA dlouho otevřená na pozadí – typicky na telefonu).
const UPDATE_CHECK_MS = 60 * 60 * 1000;

export default function ReloadPrompt() {
  useLang();
  // „Později" schová jen vyskakovací výzvu (tlačítko v patičce zůstává), aby
  // uživatel mohl aktualizovat později, až se mu to bude hodit.
  const [dismissed, setDismissed] = useState(false);
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      // Periodická kontrola aktualizací a hned jedna po registraci.
      const check = () => {
        registration.update().catch(() => {
          /* offline – zkusíme příště */
        });
      };
      check();
      setInterval(check, UPDATE_CHECK_MS);
      // PWA je na mobilu většinu času na pozadí a interval tam neběží spolehlivě.
      // Zkontrolujeme aktualizaci i při každém návratu do appky, ať se nabídka
      // objeví hned a nezůstane „viset" na staré verzi.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
    },
  });

  if (!needRefresh) return null;

  return (
    <>
      {/* Trvalé tlačítko v patičce – zůstane i po zavření vyskakovací výzvy. */}
      <button
        type="button"
        className="footer-update-btn"
        onClick={() => updateServiceWorker(true)}
      >
        <span className="footer-update-dot" aria-hidden="true" />
        {tr("Aktualizovat aplikaci")}
      </button>

      {/* Vyskakovací výzva – aktivně upozorní na novou verzi. */}
      {!dismissed && (
        <div
          className="update-prompt"
          role="dialog"
          aria-live="polite"
          aria-label={tr("Je dostupná nová verze aplikace.")}
        >
          <div className="update-prompt-body">
            <span className="update-prompt-dot" aria-hidden="true" />
            <span className="update-prompt-text">
              {tr("Je dostupná nová verze aplikace.")}
            </span>
          </div>
          <div className="update-prompt-actions">
            <button
              type="button"
              className="update-prompt-later"
              onClick={() => setDismissed(true)}
            >
              {tr("Později")}
            </button>
            <button
              type="button"
              className="update-prompt-btn"
              onClick={() => updateServiceWorker(true)}
            >
              {tr("Aktualizovat")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
