import { useRegisterSW } from "virtual:pwa-register/react";
import { tr, useLang } from "../lib/i18n";

// Jak často zkontrolovat, jestli není na serveru novější verze (i když je
// PWA dlouho otevřená na pozadí – typicky na telefonu).
const UPDATE_CHECK_MS = 60 * 60 * 1000;

export default function ReloadPrompt() {
  useLang();
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
    <button
      type="button"
      className="footer-update-btn"
      onClick={() => updateServiceWorker(true)}
    >
      <span className="footer-update-dot" aria-hidden="true" />
      {tr("Aktualizovat aplikaci")}
    </button>
  );
}
