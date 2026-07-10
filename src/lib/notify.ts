import type { Forecast } from "../types";
import { describeWeather } from "./weatherCodes";
import { tr } from "./i18n";

// Lokální (klientská) upozornění na počasí. Fungují, dokud je aplikace otevřená
// (na popředí i na pozadí záložky) – vyhodnocují se proti načtené předpovědi.
// Doručení, když je appka úplně zavřená, web bez push serveru spolehlivě neumí
// (zvlášť iOS), na to by byl potřeba backend s Web Push – viz poznámka v UI.

export type AlertType =
  | "rainStart"
  | "tempBelow"
  | "tempAbove"
  | "windAbove"
  | "snow";

export interface AlertRule {
  id: string;
  type: AlertType;
  // Práh: °C pro teploty, m/s pro vítr. U rainStart/snow se nepoužívá.
  threshold: number;
  // Jak daleko dopředu se koukáme (h).
  withinHours: number;
  enabled: boolean;
}

const RULES_KEY = "zmoknu.alerts";
const FIRED_KEY = "zmoknu.alerts.fired";
// Aby se stejné pravidlo nespouštělo dokola, dokud podmínka trvá.
const COOLDOWN_MS = 3 * 60 * 60 * 1000;

export function notifySupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export type PermState = NotificationPermission | "unsupported";

export function notifyPermission(): PermState {
  if (!notifySupported()) return "unsupported";
  return Notification.permission;
}

export async function requestNotifyPermission(): Promise<PermState> {
  if (!notifySupported()) return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function loadRules(): AlertRule[] {
  try {
    const raw = localStorage.getItem(RULES_KEY);
    if (raw) return JSON.parse(raw) as AlertRule[];
  } catch {
    /* ignore */
  }
  return [];
}

export function saveRules(rules: AlertRule[]): void {
  try {
    localStorage.setItem(RULES_KEY, JSON.stringify(rules));
  } catch {
    /* ignore */
  }
}

function loadFired(): Record<string, number> {
  try {
    const raw = localStorage.getItem(FIRED_KEY);
    if (raw) return JSON.parse(raw) as Record<string, number>;
  } catch {
    /* ignore */
  }
  return {};
}

function saveFired(m: Record<string, number>): void {
  try {
    localStorage.setItem(FIRED_KEY, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}

const DEFAULTS: Record<AlertType, { threshold: number; withinHours: number }> = {
  // rainStart: threshold = minimální intenzita v mm/h (0,2 ≈ slabý déšť).
  rainStart: { threshold: 0.2, withinHours: 3 },
  tempBelow: { threshold: -2, withinHours: 12 },
  tempAbove: { threshold: 30, withinHours: 12 },
  windAbove: { threshold: 15, withinHours: 12 },
  snow: { threshold: 0, withinHours: 12 },
};

export const ALERT_TYPES: AlertType[] = [
  "rainStart",
  "tempBelow",
  "tempAbove",
  "windAbove",
  "snow",
];

export function newRule(type: AlertType): AlertRule {
  const d = DEFAULTS[type];
  return {
    id:
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2),
    type,
    threshold: d.threshold,
    withinHours: d.withinHours,
    enabled: true,
  };
}

// Používá práh (teplota/vítr/intenzita deště)?
export function usesThreshold(type: AlertType): boolean {
  return (
    type === "tempBelow" ||
    type === "tempAbove" ||
    type === "windAbove" ||
    type === "rainStart"
  );
}

// Jednotka prahu podle typu.
export function thresholdUnit(type: AlertType): string {
  if (type === "windAbove") return "m/s";
  if (type === "rainStart") return "mm/h";
  if (type === "tempBelow" || type === "tempAbove") return "°C";
  return "";
}

// Krok/minimum pro editaci prahu.
export function thresholdStep(type: AlertType): number {
  return type === "rainStart" ? 0.1 : 1;
}
export function thresholdMin(type: AlertType): number | undefined {
  // Déšť i vítr nedávají smysl záporné; teploty klidně mohou být pod nulou.
  return type === "rainStart" || type === "windAbove" ? 0 : undefined;
}

export function alertTypeName(type: AlertType): string {
  switch (type) {
    case "rainStart":
      return tr("Začne pršet");
    case "tempBelow":
      return tr("Teplota klesne pod");
    case "tempAbove":
      return tr("Teplota vystoupá nad");
    case "windAbove":
      return tr("Vítr zesílí nad");
    case "snow":
      return tr("Začne sněžit");
  }
}

// Krátký nadpis notifikace.
function ruleTitle(rule: AlertRule): string {
  switch (rule.type) {
    case "rainStart":
      return tr("Začne pršet");
    case "tempBelow":
      return tr("Ochlazení");
    case "tempAbove":
      return tr("Vysoká teplota");
    case "windAbove":
      return tr("Silný vítr");
    case "snow":
      return tr("Sněžení");
  }
}

// Popisek do seznamu pravidel (včetně prahu a okna).
export function ruleLabel(rule: AlertRule): string {
  const win = tr("do {n} h", { n: rule.withinHours });
  switch (rule.type) {
    case "rainStart":
      return `${tr("Začne pršet (≥ {t} mm/h)", { t: rule.threshold })} (${win})`;
    case "tempBelow":
      return `${tr("Teplota klesne pod {t} °C", { t: rule.threshold })} (${win})`;
    case "tempAbove":
      return `${tr("Teplota vystoupá nad {t} °C", { t: rule.threshold })} (${win})`;
    case "windAbove":
      return `${tr("Vítr zesílí nad {t} m/s", { t: rule.threshold })} (${win})`;
    case "snow":
      return `${tr("Začne sněžit")} (${win})`;
  }
}

export interface AlertHit {
  ruleId: string;
  title: string;
  body: string;
}

function hourLabel(iso: string): string {
  return iso.length >= 16 ? iso.slice(11, 16) : iso;
}

// Hodinové body v okně [teď−1 h, teď + hours].
function upcomingHours(fc: Forecast, hours: number, now: number) {
  const end = now + hours * 3600e3;
  return fc.hourly.filter((h) => {
    const t = new Date(h.time).getTime();
    return t >= now - 3600e3 && t <= end;
  });
}

function isSnow(code: number): boolean {
  const icon = describeWeather(code).icon;
  return icon === "snow" || icon === "sleet";
}

function evalOne(
  fc: Forecast,
  rule: AlertRule,
  loc: string,
  now: number,
): AlertHit | null {
  const hrs = upcomingHours(fc, rule.withinHours, now);
  const title = ruleTitle(rule);

  switch (rule.type) {
    case "rainStart": {
      // Práh vydatnosti v mm/h (minimum 0,1, ať to vždy něco znamená).
      const rate = Math.max(0.1, rule.threshold);
      // Když už prší aspoň zadanou intenzitou, upozornění na „začátek" nedává smysl.
      if (fc.current.precipitation >= rate) return null;
      // Nejdřív zkusíme minutová data (přesnější „za pár minut").
      // Pozor: minutely15.precipitation je úhrn za 15 min → mm/h = hodnota × 4.
      const mm = fc.minutely15;
      if (mm) {
        for (let i = 0; i < mm.time.length; i++) {
          const t = new Date(mm.time[i]).getTime();
          if (t < now) continue;
          if (t > now + rule.withinHours * 3600e3) break;
          if (mm.precipitation[i] * 4 >= rate) {
            const mins = Math.round((t - now) / 60000);
            const body =
              mins <= 90
                ? tr("Do {m} min začne pršet – {loc}", { m: mins, loc })
                : tr("Kolem {t} začne pršet – {loc}", {
                    t: hourLabel(mm.time[i]),
                    loc,
                  });
            return { ruleId: rule.id, title, body };
          }
        }
      }
      // Hodinové srážky jsou přímo v mm/h.
      const h = hrs.find(
        (p) =>
          new Date(p.time).getTime() >= now &&
          p.precipitation >= rate &&
          p.precipitationProbability >= 40,
      );
      if (h)
        return {
          ruleId: rule.id,
          title,
          body: tr("Kolem {t} začne pršet – {loc}", {
            t: hourLabel(h.time),
            loc,
          }),
        };
      return null;
    }
    case "tempBelow": {
      if (fc.current.temperature <= rule.threshold)
        return {
          ruleId: rule.id,
          title,
          body: tr("Právě je {v} °C – {loc}", {
            v: Math.round(fc.current.temperature),
            loc,
          }),
        };
      const h = hrs.find(
        (p) =>
          new Date(p.time).getTime() >= now && p.temperature <= rule.threshold,
      );
      if (h)
        return {
          ruleId: rule.id,
          title,
          body: tr("Kolem {t} klesne na {v} °C – {loc}", {
            t: hourLabel(h.time),
            v: Math.round(h.temperature),
            loc,
          }),
        };
      return null;
    }
    case "tempAbove": {
      if (fc.current.temperature >= rule.threshold)
        return {
          ruleId: rule.id,
          title,
          body: tr("Právě je {v} °C – {loc}", {
            v: Math.round(fc.current.temperature),
            loc,
          }),
        };
      const h = hrs.find(
        (p) =>
          new Date(p.time).getTime() >= now && p.temperature >= rule.threshold,
      );
      if (h)
        return {
          ruleId: rule.id,
          title,
          body: tr("Kolem {t} vystoupá na {v} °C – {loc}", {
            t: hourLabel(h.time),
            v: Math.round(h.temperature),
            loc,
          }),
        };
      return null;
    }
    case "windAbove": {
      if (fc.current.windGusts >= rule.threshold)
        return {
          ruleId: rule.id,
          title,
          body: tr("Právě fouká až {v} m/s – {loc}", {
            v: Math.round(fc.current.windGusts),
            loc,
          }),
        };
      const h = hrs.find(
        (p) =>
          new Date(p.time).getTime() >= now && p.windGusts >= rule.threshold,
      );
      if (h)
        return {
          ruleId: rule.id,
          title,
          body: tr("Kolem {t} vítr až {v} m/s – {loc}", {
            t: hourLabel(h.time),
            v: Math.round(h.windGusts),
            loc,
          }),
        };
      return null;
    }
    case "snow": {
      if (isSnow(fc.current.weatherCode))
        return {
          ruleId: rule.id,
          title,
          body: tr("Právě sněží – {loc}", { loc }),
        };
      const h = hrs.find(
        (p) => new Date(p.time).getTime() >= now && isSnow(p.weatherCode),
      );
      if (h)
        return {
          ruleId: rule.id,
          title,
          body: tr("Kolem {t} bude sněžit – {loc}", {
            t: hourLabel(h.time),
            loc,
          }),
        };
      return null;
    }
  }
}

export function evaluateRules(
  fc: Forecast,
  rules: AlertRule[],
  loc: string,
  now = Date.now(),
): AlertHit[] {
  const hits: AlertHit[] = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    const hit = evalOne(fc, r, loc, now);
    if (hit) hits.push(hit);
  }
  return hits;
}

export async function showAlert(title: string, body: string): Promise<void> {
  if (notifyPermission() !== "granted") return;
  const opts: NotificationOptions = {
    body,
    icon: "/pwa-192x192.png",
    badge: "/pwa-192x192.png",
    tag: "zmoknu-weather",
  };
  // POZOR: navigator.serviceWorker.ready se bez zaregistrovaného SW (typicky v
  // dev režimu) NIKDY nevyřeší → čekání by zamrzlo. getRegistration() se vrátí
  // hned (undefined, když SW není), takže spolehlivě spadneme na new Notification.
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.showNotification(title, opts);
      return;
    }
  } catch {
    /* ignore – fallback níže */
  }
  try {
    new Notification(title, opts);
  } catch {
    /* ignore */
  }
}

// Hlavní kontrola: vyhodnotí pravidla proti předpovědi a pošle notifikace
// (s respektem k cooldownu, ať nespamují).
export async function runAlertChecks(
  fc: Forecast,
  loc: string,
  now = Date.now(),
): Promise<void> {
  if (notifyPermission() !== "granted") return;
  const rules = loadRules();
  if (!rules.some((r) => r.enabled)) return;
  const hits = evaluateRules(fc, rules, loc, now);
  if (!hits.length) return;
  const fired = loadFired();
  let changed = false;
  for (const h of hits) {
    if (now - (fired[h.ruleId] ?? 0) < COOLDOWN_MS) continue;
    await showAlert(h.title, h.body);
    fired[h.ruleId] = now;
    changed = true;
  }
  if (changed) saveFired(fired);
}
