import { useCallback, useRef, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { tr, useLang } from "../lib/i18n";

const UPDATE_CHECK_MS = 60 * 60 * 1000;
// Po kliknutí na aktualizaci nevolat update() hned po reloadu – jinak zůstane
// needRefresh zapnuté, i když už běží nová verze.
const UPDATE_SUPPRESS_MS = 15_000;
const PWA_UPDATED_KEY = "zmoknu.pwaUpdatedAt";

function recentPwaUpdate(): boolean {
  const t = Number(sessionStorage.getItem(PWA_UPDATED_KEY) || 0);
  return t > 0 && Date.now() - t < UPDATE_SUPPRESS_MS;
}

export default function ReloadPrompt() {
  useLang();
  const [dismissed, setDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const reloadFallbackRef = useRef<number | null>(null);

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onNeedReload() {
      sessionStorage.setItem(PWA_UPDATED_KEY, String(Date.now()));
      window.location.reload();
    },
    onNeedRefresh() {
      if (recentPwaUpdate()) setNeedRefresh(false);
    },
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;

      if (!registration.waiting) {
        sessionStorage.removeItem(PWA_UPDATED_KEY);
      } else if (recentPwaUpdate()) {
        setNeedRefresh(false);
      }

      const check = () => {
        if (recentPwaUpdate()) return;
        registration.update().catch(() => {
          /* offline – zkusíme příště */
        });
      };

      check();
      window.setInterval(check, UPDATE_CHECK_MS);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
    },
  });

  const clearReloadFallback = useCallback(() => {
    if (reloadFallbackRef.current != null) {
      window.clearTimeout(reloadFallbackRef.current);
      reloadFallbackRef.current = null;
    }
  }, []);

  const applyUpdate = useCallback(async () => {
    if (updating) return;
    setUpdating(true);
    setDismissed(true);
    setNeedRefresh(false);
    sessionStorage.setItem(PWA_UPDATED_KEY, String(Date.now()));
    clearReloadFallback();

    const reloadOnce = () => {
      sessionStorage.setItem(PWA_UPDATED_KEY, String(Date.now()));
      window.location.reload();
    };

    reloadFallbackRef.current = window.setTimeout(() => {
      reloadOnce();
    }, 4000);

    try {
      await updateServiceWorker();
    } catch {
      clearReloadFallback();
      setNeedRefresh(true);
      setUpdating(false);
    }
  }, [clearReloadFallback, setNeedRefresh, updateServiceWorker, updating]);

  if (!needRefresh) return null;

  return (
    <>
      <button
        type="button"
        className="footer-update-btn"
        disabled={updating}
        onClick={() => void applyUpdate()}
      >
        <span className="footer-update-dot" aria-hidden="true" />
        {updating ? tr("Aktualizuji…") : tr("Aktualizovat aplikaci")}
      </button>

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
              disabled={updating}
              onClick={() => setDismissed(true)}
            >
              {tr("Později")}
            </button>
            <button
              type="button"
              className="update-prompt-btn"
              disabled={updating}
              onClick={() => void applyUpdate()}
            >
              {updating ? tr("Aktualizuji…") : tr("Aktualizovat")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
