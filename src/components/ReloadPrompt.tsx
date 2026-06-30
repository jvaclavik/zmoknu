import { useRegisterSW } from "virtual:pwa-register/react";
import { tr, useLang } from "../lib/i18n";

// Jak často zkontrolovat, jestli není na serveru novější verze (i když je
// PWA dlouho otevřená na pozadí – typicky na telefonu).
const UPDATE_CHECK_MS = 60 * 60 * 1000;

export default function ReloadPrompt() {
  useLang();
  const {
    needRefresh: [needRefresh, setNeedRefresh],
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
    },
  });

  if (!needRefresh) return null;

  return (
    <>
      <div className="pwa-backdrop" aria-hidden="true" />
      <div className="pwa-toast" role="alert" aria-live="polite">
        <span className="pwa-toast-msg">
          {tr("Je dostupná nová verze aplikace.")}
        </span>
        <div className="pwa-toast-actions">
          <button
            type="button"
            className="pwa-toast-btn primary"
            onClick={() => updateServiceWorker(true)}
          >
            {tr("Aktualizovat")}
          </button>
          <button
            type="button"
            className="pwa-toast-btn"
            onClick={() => setNeedRefresh(false)}
          >
            {tr("Později")}
          </button>
        </div>
      </div>
    </>
  );
}
