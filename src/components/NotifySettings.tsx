import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import posthog from "posthog-js";
import { tr } from "../lib/i18n";
import { useBodyScrollLock } from "../lib/scrollLock";
import {
  ALERT_TYPES,
  alertTypeName,
  loadRules,
  newRule,
  notifyPermission,
  requestNotifyPermission,
  saveRules,
  showAlert,
  thresholdMin,
  thresholdStep,
  thresholdUnit,
  usesThreshold,
  type AlertRule,
  type AlertType,
  type PermState,
} from "../lib/notify";

interface Props {
  onClose: () => void;
}

const WITHIN_OPTIONS = [1, 2, 3, 6, 12, 24];

export default function NotifySettings({ onClose }: Props) {
  const [rules, setRules] = useState<AlertRule[]>(loadRules);
  const [perm, setPerm] = useState<PermState>(notifyPermission());
  const [addType, setAddType] = useState<AlertType>("rainStart");
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [counting, setCounting] = useState(false);
  const timers = useRef<number[]>([]);

  useBodyScrollLock(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Naplánované časovače (odpočet testu) po zavření uklidíme.
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach((id) => window.clearTimeout(id));
  }, []);

  // Změny pravidel rovnou ukládáme.
  const update = (next: AlertRule[]) => {
    setRules(next);
    saveRules(next);
  };
  const patch = (id: string, p: Partial<AlertRule>) =>
    update(rules.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const remove = (id: string) => update(rules.filter((r) => r.id !== id));
  const add = () => {
    posthog.capture("notification_rule_added", { alert_type: addType });
    update([...rules, newRule(addType)]);
  };

  const enableNotifications = async () => {
    const res = await requestNotifyPermission();
    setPerm(res);
    if (res === "granted") {
      posthog.capture("notification_permission_granted");
    }
  };

  const TEST_DELAY = 5;

  const sendTest = async () => {
    if (counting) return;
    let p = perm;
    if (p === "default") {
      p = await requestNotifyPermission();
      setPerm(p);
    }
    if (p !== "granted") {
      setTestMsg(
        p === "denied"
          ? tr(
              "Notifikace jsou zakázané. Povol je v nastavení prohlížeče pro tuto stránku.",
            )
          : tr("Bez povolení nelze notifikaci zobrazit."),
      );
      return;
    }
    // Odpočet, ať se stihne appka minimalizovat (na telefonu jinak notifikaci
    // „spolkne" popředí a neukáže se v oznamovací liště).
    setCounting(true);
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
    for (let s = TEST_DELAY; s >= 1; s--) {
      timers.current.push(
        window.setTimeout(
          () =>
            setTestMsg(
              tr("Notifikaci pošlu za {n} s – přepni se z aplikace.", { n: s }),
            ),
          (TEST_DELAY - s) * 1000,
        ),
      );
    }
    timers.current.push(
      window.setTimeout(async () => {
        await showAlert(
          tr("Zkušební upozornění"),
          tr("Takto bude upozornění vypadat."),
        );
        setCounting(false);
        setTestMsg(
          tr(
            "Notifikace odeslána. Když ji nevidíš, zkontroluj oprávnění v systému a prohlížeči.",
          ),
        );
      }, TEST_DELAY * 1000),
    );
  };

  const granted = perm === "granted";

  return createPortal(
    <div
      className="dbg-modal"
      role="dialog"
      aria-modal="true"
      aria-label={tr("Upozornění na počasí")}
    >
      <div className="dbg-backdrop" onClick={onClose} />
      <div className="dbg-sheet notif-sheet">
        <div className="dbg-head">
          <h2>{tr("Upozornění na počasí")}</h2>
          <button
            className="dbg-close"
            onClick={onClose}
            aria-label={tr("Zavřít")}
          >
            <CloseX />
          </button>
        </div>

        <div className="notif-body">
          {perm === "unsupported" ? (
            <p className="notif-note notif-warn">
              {tr(
                "Tento prohlížeč notifikace nepodporuje. Na iPhonu appku nejdřív přidej na plochu.",
              )}
            </p>
          ) : !granted ? (
            <div className="notif-perm">
              <p className="notif-note">
                {perm === "denied"
                  ? tr(
                      "Notifikace jsou zakázané. Povol je v nastavení prohlížeče pro tuto stránku.",
                    )
                  : tr("Nejdřív povol zobrazování notifikací.")}
              </p>
              {perm !== "denied" && (
                <button
                  type="button"
                  className="notif-enable"
                  onClick={enableNotifications}
                >
                  {tr("Povolit notifikace")}
                </button>
              )}
            </div>
          ) : null}

          <div className="notif-rules">
            {rules.length === 0 && (
              <p className="notif-empty">
                {tr("Zatím žádná pravidla. Přidej si první níže.")}
              </p>
            )}
            {rules.map((r) => (
              <div className="notif-rule" key={r.id}>
                <label className="notif-switch" title={tr("Zapnout/vypnout")}>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={(e) => patch(r.id, { enabled: e.target.checked })}
                  />
                  <span className="notif-switch-track" aria-hidden="true" />
                </label>
                <div className="notif-rule-main">
                  <span className="notif-rule-name">{alertTypeName(r.type)}</span>
                  <div className="notif-rule-ctl">
                    {usesThreshold(r.type) && (
                      <span className="notif-field">
                        <input
                          type="number"
                          className="notif-num"
                          value={r.threshold}
                          step={thresholdStep(r.type)}
                          min={thresholdMin(r.type)}
                          onChange={(e) =>
                            patch(r.id, { threshold: Number(e.target.value) })
                          }
                        />
                        <span className="notif-unit">
                          {thresholdUnit(r.type)}
                        </span>
                      </span>
                    )}
                    <label className="notif-field">
                      <span className="notif-within-label">{tr("do")}</span>
                      <select
                        className="notif-select"
                        value={r.withinHours}
                        onChange={(e) =>
                          patch(r.id, { withinHours: Number(e.target.value) })
                        }
                      >
                        {WITHIN_OPTIONS.map((h) => (
                          <option key={h} value={h}>
                            {tr("{n} h", { n: h })}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
                <button
                  type="button"
                  className="notif-del"
                  onClick={() => remove(r.id)}
                  aria-label={tr("Smazat pravidlo")}
                  title={tr("Smazat pravidlo")}
                >
                  <TrashGlyph />
                </button>
              </div>
            ))}
          </div>

          <div className="notif-add">
            <select
              className="notif-select"
              value={addType}
              onChange={(e) => setAddType(e.target.value as AlertType)}
            >
              {ALERT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {alertTypeName(t)}
                </option>
              ))}
            </select>
            <button type="button" className="notif-add-btn" onClick={add}>
              {tr("Přidat pravidlo")}
            </button>
          </div>

          {perm !== "unsupported" && (
            <div className="notif-test-row">
              <button
                type="button"
                className="notif-test"
                onClick={sendTest}
                disabled={counting}
              >
                {counting
                  ? tr("Přepni se z aplikace…")
                  : tr("Poslat zkušební notifikaci ({n} s)", { n: TEST_DELAY })}
              </button>
              {testMsg && <p className="notif-note">{testMsg}</p>}
            </div>
          )}

          <p className="notif-note notif-foot">
            {tr(
              "Upozornění se vyhodnocují podle předpovědi pro aktuální lokaci, dokud je appka spuštěná (i na pozadí). Doručení, když je appka úplně zavřená, web negarantuje.",
            )}
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CloseX() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TrashGlyph() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
    </svg>
  );
}
