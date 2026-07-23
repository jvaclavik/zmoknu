import type { CSSProperties, ReactNode } from "react";
import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import CustomizeContent, {
  type WidgetDef,
} from "./components/CustomizeContent";
import DayDetails from "./components/DayDetails";
import DaySelector from "./components/DaySelector";
import Donate from "./components/Donate";
import { sameLocation } from "./components/FavoritesBar";
import HourlyForecast from "./components/HourlyForecast";
import InstallHint from "./components/InstallHint";
import Meteogram from "./components/Meteogram";
import NotifySettings from "./components/NotifySettings";
import ReloadPrompt from "./components/ReloadPrompt";
import SearchBar from "./components/SearchBar";
import Skeleton from "./components/Skeleton";
import SmartSummary from "./components/SmartSummary";
import Webcams from "./components/Webcams";
import WeatherAlerts from "./components/WeatherAlerts";
import WhatToWear from "./components/WhatToWear";
import { fetchAirQuality, type AirByDate } from "./lib/airQuality";
import { dayHeader, isoDate, todayISO } from "./lib/format";
import { tr, useLang } from "./lib/i18n";
import { DEFAULT_MODEL, WEATHER_MODELS, modelLabel } from "./lib/models";
import {
  fetchForecast,
  getOfflineForecast,
  reverseGeocode,
  saveOfflineForecast,
} from "./lib/openMeteo";
import { runAlertChecks } from "./lib/notify";
import { fetchRadar } from "./lib/rainviewer";
import { tempTier, tierColor } from "./lib/tiers";
import { setThemePalette } from "./lib/themeState";
import { useStoredState } from "./lib/useStoredState";
import { describeWeather } from "./lib/weatherCodes";
import type { Forecast, GeoLocation, RadarData } from "./types";
import posthog from "posthog-js";
// RadarMap tahá maplibre-gl (~800 kB) – načteme ho až po zbytku appky, aby
// počáteční bundle byl malý a layout/skeleton se vykreslil co nejdřív. Chunk pak
// na pozadí přednačteme (viz efekt níže), ať je otevření radaru okamžité.
const importRadarMap = () => import("./components/RadarMap");
const RadarMap = lazy(importRadarMap);

type RadarStatus = "loading" | "ok" | "error";

type ThemeMode = "system" | "light" | "dark";

const DEFAULT_LOCATION: GeoLocation = {
  name: "Praha",
  latitude: 50.0755,
  longitude: 14.4378,
  country: "Česko",
  admin1: "Praha",
};

const STORAGE_KEY = "zmoknu.location";
const FAV_KEY = "zmoknu.favorites";

// Lokace z URL (deep-link), např. ?lat=50.08&lon=14.42&name=Praha.
function locationFromUrl(): GeoLocation | null {
  try {
    const p = new URLSearchParams(window.location.search);
    const lat = parseFloat(p.get("lat") ?? "");
    const lon = parseFloat(p.get("lon") ?? "");
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return {
        latitude: lat,
        longitude: lon,
        name: p.get("name") ?? tr("Sdílené místo"),
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function loadSavedLocation(): GeoLocation {
  const fromUrl = locationFromUrl();
  if (fromUrl) return fromUrl;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as GeoLocation;
  } catch {
    /* ignore */
  }
  return DEFAULT_LOCATION;
}

// „Naposledy aktualizováno" jako relativní čas (právě teď / před X min / před X h).
function relUpdated(from: number, now: number): string {
  const s = Math.max(0, Math.round((now - from) / 1000));
  if (s < 60) return tr("právě teď");
  const m = Math.round(s / 60);
  if (m < 60) return tr("před {n} min", { n: m });
  const h = Math.round(m / 60);
  return tr("před {n} h", { n: h });
}

// Posun ISO data (YYYY-MM-DD) o daný počet dní.
function shiftIso(iso: string, days: number): string {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

function loadFavorites(): GeoLocation[] {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    if (raw) return JSON.parse(raw) as GeoLocation[];
  } catch {
    /* ignore */
  }
  return [];
}

// Přizpůsobitelné sekce hlavního obsahu (pořadí = výchozí rozvržení).
const WIDGET_DEFS: WidgetDef[] = [
  { id: "summary", label: "Souhrn" },
  { id: "meteogram", label: "Meteogram" },
  { id: "wear", label: "Co na sebe" },
  { id: "outlook", label: "Výhled" },
  { id: "webcams", label: "Webkamery" },
  { id: "details", label: "Další detaily" },
];
const DEFAULT_WIDGETS = WIDGET_DEFS.map((w) => w.id);

export default function App() {
  const { lang, setLang } = useLang();
  const [location, setLocation] = useState<GeoLocation>(loadSavedLocation);
  const [favorites, setFavorites] = useState<GeoLocation[]>(loadFavorites);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [radar, setRadar] = useState<RadarData | null>(null);
  const [radarStatus, setRadarStatus] = useState<RadarStatus>("loading");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [selectedDate, setSelectedDate] = useState("");
  const [air, setAir] = useState<AirByDate>({});
  // Kolik dní historie načítáme (1–7) a den, na který skočit po donačtení.
  const [pastDays, setPastDays] = useState(1);
  const [model, setModel] = useStoredState<string>(
    "zmoknu.model",
    DEFAULT_MODEL
  );
  const [pendingDate, setPendingDate] = useState<string | null>(null);
  // Vizuální stav swipe gesta (šipka vylézající z kraje jako „zpět" v Chrome).
  const [swipe, setSwipe] = useState<{
    dir: 1 | -1;
    progress: number;
    ready: boolean;
  } | null>(null);
  // Zda lze v daném směru přepnout (čteme v gestu přes ref, ať je aktuální).
  const canPrevRef = useRef(true);
  const canNextRef = useRef(true);
  const swipeReadyRef = useRef(false);
  // Pull-to-refresh: vzdálenost tažení (px), stav obnovování a „tik" pro refetch.
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  // Kdy byla naposledy načtena předpověď + „tik" pro průběžný relativní čas.
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  // Rozvržení hlavního obsahu (pořadí zapnutých sekcí + skryté sekce).
  const [widgetEnabled, setWidgetEnabled] = useStoredState<string[]>(
    "zmoknu.widgetsEnabled",
    DEFAULT_WIDGETS,
  );
  const [widgetHidden, setWidgetHidden] = useStoredState<string[]>(
    "zmoknu.widgetsHidden",
    [],
  );
  // Normalizace: jen známé sekce, chybějící (nově přidané) doplníme na konec.
  const { enabledOrder, hiddenOrder } = useMemo(() => {
    const known = DEFAULT_WIDGETS;
    const en = widgetEnabled.filter((id) => known.includes(id));
    const hi = widgetHidden.filter(
      (id) => known.includes(id) && !en.includes(id),
    );
    const missing = known.filter((id) => !en.includes(id) && !hi.includes(id));
    return { enabledOrder: [...en, ...missing], hiddenOrder: hi };
  }, [widgetEnabled, widgetHidden]);
  // Zobrazujeme uloženou (offline) předpověď, protože síť selhala?
  const [offline, setOffline] = useState(false);
  const lastReloadTick = useRef(0);
  // Aktuální seznam oblíbených bez nutnosti re-fetche předpovědi při jeho změně.
  const favoritesRef = useRef<GeoLocation[]>([]);
  favoritesRef.current = favorites;
  // Aktuální předpověď (ref), ať selhání při rozšiřování historie nezahodí
  // funkční data ani nezablokuje přepínání dní.
  const forecastRef = useRef<Forecast | null>(null);
  forecastRef.current = forecast;
  // Header je fixed (aby nereagoval na bounce scrollu) → obsahu doplníme horní
  // odsazení podle jeho skutečné výšky (mění se s bezpečnou zónou, orientací…).
  const headerRef = useRef<HTMLElement>(null);
  const [headerH, setHeaderH] = useState(0);
  // Neblokující hláška (např. „starší historii se teď nepodařilo načíst").
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Pull-to-refresh (reloadTick) vynutí čerstvá data mimo cache.
    const force = reloadTick !== lastReloadTick.current;
    lastReloadTick.current = reloadTick;
    fetchForecast(location.latitude, location.longitude, pastDays, model, {
      force,
    })
      .then((f) => {
        if (!cancelled) {
          setForecast(f);
          setFetchedAt(Date.now());
          setOffline(false);
          setNotice(null);
          saveOfflineForecast(location, pastDays, model, f, favoritesRef.current);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        // Při výpadku sítě zkusíme obnovit uloženou předpověď pro dané místo
        // (ať appka funguje i offline a jde přepínat mezi uloženými místy).
        // Jiné chyby (např. model bez dat) řešíme jako dřív – jen hláškou.
        const isNetwork = !navigator.onLine || e instanceof TypeError;
        const saved = isNetwork
          ? getOfflineForecast(location.latitude, location.longitude)
          : null;
        if (saved) {
          setForecast(saved.forecast);
          setFetchedAt(saved.at);
          setOffline(true);
          setError(null);
        } else if (forecastRef.current) {
          // Už něco zobrazujeme – typicky rozšiřování historie šipkou doleva.
          // Selhání nesmí zahodit funkční předpověď ani zablokovat přepínání dní;
          // necháme původní data a jen nenápadně upozorníme (jde zkusit znovu).
          setPendingDate(null);
          setError(null);
          setNotice(
            tr("Starší historii se teď nepodařilo načíst. Zkuste to znovu."),
          );
        } else {
          setError(e instanceof Error ? e.message : tr("Chyba načítání"));
          // Nezobrazuj stará/rozbitá data – ať je vidět jen hláška.
          setForecast(null);
          setOffline(false);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [location, pastDays, model, reloadTick]);

  // Po dokončení načítání ukonči stav obnovování (pull-to-refresh).
  useEffect(() => {
    if (!loading) {
      setRefreshing(false);
      setPull(0);
    }
  }, [loading]);

  // Průběžně přepočítávej „naposledy aktualizováno před …" (jednou za 30 s).
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Neblokující hláška sama zmizí po chvíli.
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(id);
  }, [notice]);

  // Měření výšky fixed headeru → padding-top obsahu (aby nepodjížděl pod něj).
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const measure = () => setHeaderH(el.offsetHeight);
    measure();
    // Border-box: aby se měření spustilo i při změně paddingu (safe-area inset
    // se na iOS občas dorovná až po prvním renderu → jinak obsah podjede header).
    const ro = new ResizeObserver(measure);
    ro.observe(el, { box: "border-box" });
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    // Pojistka na opožděné dotažení fontů / safe-area insetů.
    const t = window.setTimeout(measure, 400);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      window.clearTimeout(t);
    };
  }, []);

  // Safe-area insety si nacachujeme do CSS proměnných. Na iOS totiž env(safe-area-*)
  // při scrollu/přetažení občas krátce spadne na 0 → header „vjede" pod výřez a
  // FAB radaru poskočí. Čtená hodnota přes probe element je stabilní.
  useEffect(() => {
    const root = document.documentElement;
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
      "padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);" +
      "padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left);";
    document.body.appendChild(probe);
    // iOS někdy při prvním načtení (a během scrollu/přetažení) hlásí env(safe-area-*)
    // jako 0. Kdybychom tu 0 uložili, maska status baru (body::before) by měla nulovou
    // výšku a header by při scrollu „vjel" do status baru. Proto hodnotu nikdy
    // nepřepisujeme dolů na menší – držíme dosavadní maximum (reset jen při otočení).
    const setMax = (name: string, val: string, reset: boolean) => {
      const next = parseFloat(val) || 0;
      const prev = reset
        ? 0
        : parseFloat(root.style.getPropertyValue(name)) || 0;
      root.style.setProperty(name, `${Math.max(prev, next)}px`);
    };
    const update = (reset = false) => {
      const s = getComputedStyle(probe);
      setMax("--sat", s.paddingTop, reset);
      setMax("--sar", s.paddingRight, reset);
      setMax("--sab", s.paddingBottom, reset);
      setMax("--sal", s.paddingLeft, reset);
    };
    update(true);
    const onChange = () => update(false);
    // Otočení mění insety (portrét×krajina) → nastavíme baseline znovu od nuly.
    const onOrient = () => window.setTimeout(() => update(true), 300);
    // Doměřovat při scrollu má smysl jen dokud iOS nenahlásí kladný inset – jakmile
    // ho známe, listener odpojíme, ať getComputedStyle nezdržuje každý frame scrollu.
    const onScroll = () => {
      update(false);
      if ((parseFloat(root.style.getPropertyValue("--sat")) || 0) > 0) {
        window.removeEventListener("scroll", onScroll);
      }
    };
    window.addEventListener("resize", onChange);
    window.addEventListener("orientationchange", onOrient);
    window.addEventListener("scroll", onScroll, { passive: true });
    // iOS reportuje správný inset až chvíli po prvním vykreslení – doměříme.
    const t1 = window.setTimeout(onChange, 300);
    const t2 = window.setTimeout(onChange, 1200);
    return () => {
      window.removeEventListener("resize", onChange);
      window.removeEventListener("orientationchange", onOrient);
      window.removeEventListener("scroll", onScroll);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      probe.remove();
    };
  }, []);

  // Při změně místa zahodíme načtenou historii.
  useEffect(() => {
    setPastDays(1);
    setPendingDate(null);
  }, [location]);

  // Lokální upozornění: vyhodnotíme pravidla proti čerstvé předpovědi hned po
  // načtení a pak průběžně (interval + návrat na záložku), dokud appka běží.
  useEffect(() => {
    if (!forecast) return;
    const run = () => {
      runAlertChecks(forecast, location.name).catch(() => {});
    };
    run();
    const id = window.setInterval(run, 10 * 60 * 1000);
    const onVis = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", run);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", run);
    };
  }, [forecast, location.name]);

  // Kvalita ovzduší + pyl (samostatné API, nebrání hlavní předpovědi).
  useEffect(() => {
    let cancelled = false;
    setAir({});
    fetchAirQuality(location.latitude, location.longitude)
      .then((a) => {
        if (!cancelled) setAir(a);
      })
      .catch(() => {
        if (!cancelled) setAir({});
      });
    return () => {
      cancelled = true;
    };
  }, [location]);

  // Prefetch oblíbených míst → přepnutí je okamžité a předpověď se zároveň
  // uloží pro offline použití (spolu s naposledy navštívenými místy).
  useEffect(() => {
    favorites
      .filter((f) => !sameLocation(f, location))
      .slice(0, 8)
      .forEach((f) => {
        fetchForecast(f.latitude, f.longitude, pastDays, model)
          .then((fc) =>
            saveOfflineForecast(f, pastDays, model, fc, favoritesRef.current),
          )
          .catch(() => {});
      });
  }, [favorites, location, model, pastDays]);

  // Až je appka načtená a chvíli klid, potichu přednačti radarový chunk
  // (maplibre). Otevření radaru je pak okamžité, ale nezdrží první vykreslení.
  const radarWarmed = useRef(false);
  useEffect(() => {
    if (radarWarmed.current || loading || !forecast) return;
    radarWarmed.current = true;
    const warm = () => {
      importRadarMap().catch(() => {
        radarWarmed.current = false; // zkus to příště znovu
      });
    };
    const ric = (
      window as unknown as {
        requestIdleCallback?: (
          cb: () => void,
          o?: { timeout: number }
        ) => number;
      }
    ).requestIdleCallback;
    if (ric) {
      const id = ric(warm, { timeout: 4000 });
      return () => {
        (
          window as unknown as { cancelIdleCallback?: (id: number) => void }
        ).cancelIdleCallback?.(id);
      };
    }
    const t = window.setTimeout(warm, 2000);
    return () => window.clearTimeout(t);
  }, [loading, forecast]);

  // Udržuj v URL aktuální lokaci, ať jde odkaz sdílet (deep-link).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    p.set("lat", location.latitude.toFixed(4));
    p.set("lon", location.longitude.toFixed(4));
    p.set("name", location.name);
    const url = `${window.location.pathname}?${p.toString()}`;
    window.history.replaceState(null, "", url);
  }, [location]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchRadar()
        .then((r) => {
          if (cancelled) return;
          setRadar(r);
          setRadarStatus("ok");
        })
        .catch(() => {
          if (!cancelled) setRadarStatus("error");
        });
    load();
    const id = window.setInterval(load, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Výchozí vybraný den = dnes; po donačtení historie skočíme na pending den.
  useEffect(() => {
    if (!forecast) return;
    const dates = forecast.daily.map((d) => d.time);
    if (pendingDate && dates.includes(pendingDate)) {
      setSelectedDate(pendingDate);
      setPendingDate(null);
      return;
    }
    // Dokud čekáme na donačtení, nepřepisujeme výběr na dnešek.
    if (!pendingDate && !dates.includes(selectedDate)) {
      const today = todayISO();
      setSelectedDate(dates.includes(today) ? today : dates[0] ?? "");
    }
  }, [forecast, selectedDate, pendingDate]);

  // Donačtení historie po týdnu (až ~3 měsíce zpět – limit Open-Meteo).
  // `selectDaysAgo` = na který den po načtení skočit (krokování šipkou/gestem).
  // Bez něj (tlačítko „Starší") jen přidáme starší dny a výběr necháme být.
  const HISTORY_STEP = 7;
  const loadMoreHistory = useCallback(
    (selectDaysAgo?: number) => {
      const next = Math.min(92, pastDays + HISTORY_STEP);
      if (next === pastDays) return;
      if (selectDaysAgo != null) {
        const target = new Date();
        target.setDate(target.getDate() - Math.min(next, selectDaysAgo));
        setPendingDate(isoDate(target));
      }
      setPastDays(next);
    },
    [pastDays],
  );

  const changeDay = useCallback(
    (delta: number) => {
      if (!forecast) return;
      const dates = forecast.daily.map((d) => d.time);
      const idx = dates.indexOf(selectedDate);
      if (idx === -1) return;
      // Na nejstarším dni a krok doleva → donačteme týden a skočíme o den zpět.
      if (delta < 0 && idx === 0) {
        loadMoreHistory(pastDays + 1);
        return;
      }
      const next = dates[Math.min(dates.length - 1, Math.max(0, idx + delta))];
      if (next) setSelectedDate(next);
    },
    [forecast, selectedDate, loadMoreHistory, pastDays],
  );

  // Na mobilu přepínej dny swipem do stran. Během vodorovného tažení zamkneme
  // svislý scroll (preventDefault) a z kraje vysuneme šipku jako „zpět" v Chrome.
  useEffect(() => {
    if (!forecast) return;
    // Delší práh = musíš táhnout výrazněji (přepnutí nesepne krátkým cuknutím),
    // takže gesto může začít i úplně u kraje, aniž by se pletlo se systémovým
    // „zpět" (to je krátký tah od kraje).
    const THRESHOLD = 150; // px do sepnutí přepnutí
    let startX = 0;
    let startY = 0;
    let track = false; // sledujeme gesto (dosud nerozhodnuté)
    let horizontal = false; // rozhodnuto = vodorovné tažení
    let dir: 1 | -1 = 1;
    let readyBuzzed = false; // haptika při sepnutí jen jednou za tah
    let edgeBuzzed = false; // jemný „odpor" na kraji jen jednou za tah

    // Prvky s vlastním vodorovným gestem – swipe tam neřešíme. Kromě
    // kontejnerů vyloučíme i všechny nativní slidery (posuvníky), protože
    // některé (počet dní v meteogramu, tester oblečení) se renderují přes
    // portál na document.body, takže by je selektory podle kontejneru minuly.
    const BLOCK = [
      ".meteogram-plot",
      ".wear-grid",
      ".radar-card",
      ".dayselect",
      ".tb-daypanel",
      ".search-panel",
      ".mg-view-menu",
      ".dbg-modal",
      ".webcams-scroll",
      "input[type='range']",
    ].join(",");

    const reset = () => {
      track = false;
      horizontal = false;
      readyBuzzed = false;
      edgeBuzzed = false;
      swipeReadyRef.current = false;
      setSwipe(null);
    };

    const onStart = (e: TouchEvent) => {
      if (!window.matchMedia("(max-width: 640px)").matches) return;
      if (e.touches.length !== 1) return;
      const el = e.target as Element | null;
      if (el && el.closest(BLOCK)) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      // Gesto smí začít kdekoliv (i úplně u kraje). Směr (předchozí/další den)
      // se rozhodne až podle směru tažení; delší práh brání kolizi se
      // systémovým „zpět".
      track = true;
      horizontal = false;
    };

    const onMove = (e: TouchEvent) => {
      if (!track) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;

      if (!horizontal) {
        // Dokud nemáme jasno, počkáme na výraznější pohyb. Svislý scroll
        // necháme prohlížeči (žádný preventDefault), dokud gesto nevyhodnotíme
        // jako vodorovné.
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        // Vyžadujeme jasnou vodorovnou převahu, aby se to nepletlo se scrollem.
        const goingHoriz = Math.abs(dx) > Math.abs(dy) * 1.5;
        const wantDir: 1 | -1 = dx < 0 ? 1 : -1;
        const allowed = wantDir === 1 ? canNextRef.current : canPrevRef.current;
        // Gesto pustíme, když není vodorovné nebo pro daný směr nejsou data
        // (svislý scroll se obnoví při dalším pohybu).
        if (!goingHoriz || !allowed) {
          // Vodorovné tažení do strany, kam už není kam přepnout → jemný
          // „odpor" (krátký pulz, jen jednou za tah, kde je podpora).
          if (goingHoriz && !allowed && !edgeBuzzed) {
            edgeBuzzed = true;
            navigator.vibrate?.(8);
          }
          track = false;
          return;
        }
        horizontal = true;
        dir = wantDir;
      }

      // Teď víme, že jde o vodorovné přepínání dne – zamkneme svislý scroll.
      if (e.cancelable) e.preventDefault();

      const progress = Math.min(1, Math.abs(dx) / THRESHOLD);
      const ready = progress >= 1;
      // Krátké cvaknutí v okamžiku, kdy tah překročí práh (sepne přepnutí).
      if (ready && !readyBuzzed) {
        readyBuzzed = true;
        navigator.vibrate?.(12);
      } else if (!ready && readyBuzzed) {
        readyBuzzed = false;
      }
      swipeReadyRef.current = ready;
      setSwipe({ dir, progress, ready });
    };

    const onEnd = () => {
      if (horizontal && swipeReadyRef.current) changeDay(dir);
      reset();
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", reset, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", reset);
    };
  }, [forecast, changeDay]);

  // Pull-to-refresh: tažení dolů od úplného vršku stránky obnoví data.
  useEffect(() => {
    const THRESHOLD = 70; // px (po odporu) do spuštění obnovení
    const MAX = 96;
    let startY = 0;
    let startX = 0;
    let active = false; // sledujeme tah shora dolů
    let decided = false;
    let buzzed = false; // haptika jen jednou za tah (při překročení prahu)

    const atTop = () => window.scrollY <= 0;
    // Když je otevřený modál (radar/hledání…), pozadí má zamčený scroll.
    const blocked = () => document.body.style.overflow === "hidden";

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || refreshing || !atTop() || blocked()) {
        active = false;
        return;
      }
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      active = true;
      decided = false;
      buzzed = false;
    };

    const onMove = (e: TouchEvent) => {
      if (!active) return;
      const dy = e.touches[0].clientY - startY;
      const dx = e.touches[0].clientX - startX;
      if (!decided) {
        if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
        // Rozhodni: jasný tah dolů (ne do strany) a pořád na vršku.
        if (dy <= 0 || dy <= Math.abs(dx) || !atTop()) {
          active = false;
          return;
        }
        decided = true;
      }
      if (dy <= 0) {
        setPull(0);
        return;
      }
      if (e.cancelable) e.preventDefault();
      // Odpor – tažení se postupně zpomaluje.
      const dist = Math.min(MAX, dy * 0.5);
      // Krátká haptika při překročení prahu (jen jednou za tah, kde je podpora).
      if (!buzzed && dist >= THRESHOLD) {
        buzzed = true;
        navigator.vibrate?.(10);
      } else if (buzzed && dist < THRESHOLD) {
        buzzed = false;
      }
      setPull(dist);
    };

    const onEnd = () => {
      if (!active) return;
      active = false;
      setPull((d) => {
        if (d >= THRESHOLD) {
          setRefreshing(true);
          setReloadTick((t) => t + 1);
          return THRESHOLD; // podrž indikátor, dokud běží načítání
        }
        return 0;
      });
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [refreshing]);

  // Přepínání dne šipkami doleva/doprava.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        changeDay(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        changeDay(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [changeDay]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(location));
    } catch {
      /* ignore */
    }
  }, [location]);

  useEffect(() => {
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
    } catch {
      /* ignore */
    }
  }, [favorites]);

  const isCurrentFav = favorites.some((f) => sameLocation(f, location));

  const toggleFavorite = useCallback(() => {
    const isFav = favorites.some((f) => sameLocation(f, location));
    posthog.capture(isFav ? "favorite_removed" : "favorite_added", {
      location_name: location.name,
    });
    setFavorites((prev) =>
      prev.some((f) => sameLocation(f, location))
        ? prev.filter((f) => !sameLocation(f, location))
        : [...prev, location]
    );
  }, [location, favorites]);

  const removeFavorite = useCallback((loc: GeoLocation) => {
    posthog.capture("favorite_removed", { location_name: loc.name });
    setFavorites((prev) => prev.filter((f) => !sameLocation(f, loc)));
  }, []);

  const renameFavorite = useCallback((loc: GeoLocation, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    posthog.capture("favorite_renamed", { location_name: trimmed });
    setFavorites((prev) =>
      prev.map((f) =>
        f.latitude === loc.latitude && f.longitude === loc.longitude
          ? { ...f, name: trimmed }
          : f,
      ),
    );
  }, []);

  const toggleFavoriteFor = useCallback((loc: GeoLocation) => {
    const isFav = favorites.some((f) => sameLocation(f, loc));
    posthog.capture(isFav ? "favorite_removed" : "favorite_added", {
      location_name: loc.name,
    });
    setFavorites((prev) =>
      prev.some((f) => sameLocation(f, loc))
        ? prev.filter((f) => !sameLocation(f, loc))
        : [...prev, loc]
    );
  }, [favorites]);

  // Aktualizace barevného motivu pozadí podle aktuálního počasí. Motiv
  // ukládáme do localStorage a nastavujeme na <html>, aby ho preload v
  // index.html mohl aplikovat hned při dalším otevření (bez skoku barvy).
  useEffect(() => {
    if (!forecast) return;
    const theme = skyTheme(
      forecast.current.weatherCode,
      forecast.current.isDay
    );
    document.documentElement.dataset.sky = theme;
    try {
      localStorage.setItem("sky", theme);
    } catch {
      /* localStorage může být nedostupné (privátní režim) */
    }
  }, [forecast]);

  const handleLocate = useCallback(() => {
    if (!navigator.geolocation) {
      setError(tr("Geolokace není v tomto prohlížeči dostupná."));
      return;
    }
    posthog.capture("geolocation_used");
    setLocating(true);
    // Modál výběru místa hned zavřeme – poloha se dohledá na pozadí a lokace
    // se vybere, jakmile ji prohlížeč vrátí.
    setSearchOpen(false);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        const name = await reverseGeocode(latitude, longitude);
        setLocation({ name, latitude, longitude });
        setLocating(false);
      },
      () => {
        setError(tr("Polohu se nepodařilo zjistit."));
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }, []);

  const selectedDay =
    forecast?.daily.find((d) => d.time === selectedDate) ?? forecast?.daily[0];

  const today = todayISO();

  // Rozbalovací výběr dnů přímo v hlavičce (toggle přes tb-day).
  const [dayPanelOpen, setDayPanelOpen] = useState(false);
  const [radarOpen, setRadarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shared, setShared] = useState(false);

  // Motiv: "system" sleduje nastavení OS, "light"/"dark" je ruční volba.
  const [themeMode, setThemeMode] = useStoredState<ThemeMode>(
    "zmoknu.theme",
    "dark",
  );
  const [systemDark, setSystemDark] = useState(
    () =>
      typeof window === "undefined" ||
      !window.matchMedia ||
      window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const resolvedTheme: "light" | "dark" =
    themeMode === "system" ? (systemDark ? "dark" : "light") : themeMode;
  // Nastavíme paletu barevných utilit synchronně během renderu, aby ji potomci
  // (tempColor/tierColor) při tomto renderu už četli správně.
  setThemePalette(resolvedTheme);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta)
      meta.setAttribute(
        "content",
        resolvedTheme === "light" ? "#eef2f8" : "#05080f",
      );
  }, [resolvedTheme]);
  // Cyklus motivu: Systém → Světlý → Tmavý → Systém.
  const cycleTheme = () => {
    const order: ThemeMode[] = ["system", "light", "dark"];
    const next = order[(order.indexOf(themeMode) + 1) % order.length];
    setThemeMode(next);
  };

  // Klávesové zkratky: Opt/Alt+L přepíná modal lokace, Opt/Alt+D skočí na dnešek,
  // Opt/Alt+T cyklí motiv (systém → světlý → tmavý).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === "l" || e.key === "L" || e.code === "KeyL") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      } else if (e.key === "d" || e.key === "D" || e.code === "KeyD") {
        e.preventDefault();
        setSelectedDate(todayISO());
      } else if (e.key === "t" || e.key === "T" || e.code === "KeyT") {
        e.preventDefault();
        cycleTheme();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeMode, setThemeMode]);
  const dayBtnRef = useRef<HTMLButtonElement>(null);
  const dayPanelRef = useRef<HTMLDivElement>(null);
  const [dayArrowX, setDayArrowX] = useState<number | null>(null);

  // Šipka od panelu výběru dne míří na tlačítko s aktuálním dnem.
  useEffect(() => {
    if (!dayPanelOpen) return;
    const measure = () => {
      const btn = dayBtnRef.current;
      const panel = dayPanelRef.current;
      if (!btn || !panel) return;
      const b = btn.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      setDayArrowX(b.left + b.width / 2 - p.left);
    };
    measure();
    const row2 = document.querySelector(".hb-row2");
    window.addEventListener("resize", measure);
    row2?.addEventListener("scroll", measure, { passive: true });
    return () => {
      window.removeEventListener("resize", measure);
      row2?.removeEventListener("scroll", measure);
    };
  }, [dayPanelOpen]);

  const shareLink = useCallback(async () => {
    const url = window.location.href;
    const title = location
      ? tr("Počasí – {name}", { name: location.name })
      : "Zmoknu?";
    try {
      if (navigator.share) {
        await navigator.share({ title, url });
        posthog.capture("link_shared", { method: "native_share" });
        return;
      }
      await navigator.clipboard.writeText(url);
      posthog.capture("link_shared", { method: "clipboard" });
      setShared(true);
      setTimeout(() => setShared(false), 1800);
    } catch {
      /* uživatel zrušil sdílení nebo schránka není dostupná */
    }
  }, [location]);

  // Klávesa "r" přepíná radar. Ignoruje psaní v inputech/textarea/contenteditable.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "r" && e.key !== "R") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.isContentEditable ||
          t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT")
      )
        return;
      e.preventDefault();
      setRadarOpen((v) => !v);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!dayPanelOpen) return;
    function onClick(e: MouseEvent) {
      // Zavři jen když klik míří mimo tlačítko dnů i mimo samotný panel.
      if (!(e.target as Element).closest(".tb-daygroup")) {
        setDayPanelOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [dayPanelOpen]);

  // Navigace dnů v hlavičce: doleva lze i donačíst historii, doprava do konce dat.
  const dayDates = forecast?.daily.map((d) => d.time) ?? [];
  const dayIdx = dayDates.indexOf(selectedDate);
  const canPrev = dayIdx > 0 || pastDays < 92;
  const canNext = dayIdx >= 0 && dayIdx < dayDates.length - 1;
  canPrevRef.current = canPrev;
  canNextRef.current = canNext;

  // Pocitová teplota vybraného dne (pro doporučení oblečení).
  const dayHours =
    forecast?.hourly.filter((h) => h.time.slice(0, 10) === selectedDate) ?? [];
  const feelsMax = dayHours.length
    ? Math.max(...dayHours.map((h) => h.apparentTemperature))
    : selectedDay?.tempMax ?? 0;
  const feelsMin = dayHours.length
    ? Math.min(...dayHours.map((h) => h.apparentTemperature))
    : selectedDay?.tempMin ?? 0;

  // Srážky přes den (6–22 h) – brzká rána (0–6 h) a pozdní noc (22–24 h)
  // deštník neřeší (kromě extrémů, ty řeší WhatToWear přes celodenní úhrn).
  const wakeHours = dayHours.filter((h) => {
    const hr = new Date(h.time).getHours();
    return hr >= 6 && hr < 22;
  });
  const wakeRainSum = wakeHours.length
    ? wakeHours.reduce((s, h) => s + h.precipitation, 0)
    : selectedDay?.precipitationSum ?? 0;
  const wakeRainProb = wakeHours.length
    ? Math.max(...wakeHours.map((h) => h.precipitationProbability))
    : selectedDay?.precipitationProbabilityMax ?? 0;

  // Má vybraný den vůbec data? Krátkodobé/regionální modely (např. ČHMÚ) je
  // nemají pro vzdálené dny → skryjeme denní widgety a nabídneme jiný model.
  const dayHasData =
    (selectedDay != null && Number.isFinite(selectedDay.weatherCode)) ||
    dayHours.some((h) => Number.isFinite(h.temperature));

  return (
    <div
      className="app"
      style={
        headerH ? ({ paddingTop: `${headerH + 16}px` } as CSSProperties) : undefined
      }
    >
      <div
        className={`ptr ${refreshing ? "refreshing" : ""}`}
        style={
          {
            "--pull": `${pull}px`,
            "--p": Math.min(1, pull / 70),
          } as CSSProperties
        }
        aria-hidden={pull === 0 && !refreshing}
      >
        <span className="ptr-spinner">
          <RefreshGlyph />
        </span>
        <span className="ptr-label">
          {refreshing
            ? tr("Obnovuji…")
            : fetchedAt != null
              ? `${tr("Aktualizováno")} ${relUpdated(fetchedAt, nowTick)}`
              : ""}
        </span>
      </div>
      {swipe && (
        <div
          className={`swipe-hint ${swipe.dir === 1 ? "right" : "left"} ${
            swipe.ready ? "ready" : ""
          }`}
          style={{ "--p": swipe.progress } as CSSProperties}
          aria-hidden="true"
        >
          <span className="swipe-hint-circle">
            <SwipeArrow dir={swipe.dir} />
          </span>
          <span className="swipe-hint-day">
            {dayHeader(shiftIso(selectedDate || today, swipe.dir))}
          </span>
        </div>
      )}
      {fetchedAt != null && (
        <div
          className="last-refresh"
          style={{ top: `${headerH}px` } as CSSProperties}
          aria-hidden="true"
        >
          {tr("Aktualizováno")} {relUpdated(fetchedAt, nowTick)}
        </div>
      )}
      <header className="topbar" ref={headerRef}>
        <div className="hb-row1">
          <span className="hb-brand" aria-hidden="true">
            <img
              src={resolvedTheme === "light" ? "/logo-light.svg" : "/logo.svg"}
              alt=""
              className="hb-logo-img"
            />
          </span>
          <span className="hb-brandname">
            zmoknu<span className="hb-q">?</span>
          </span>
          {forecast && selectedDate && selectedDate !== today && (
            <button
              type="button"
              className="hb-today"
              onClick={() => setSelectedDate(today)}
              title={tr("Přejít na dnešek")}
              aria-label={tr("Přejít na dnešek")}
            >
              <ClockGlyph />
              <span className="hb-today-label">{tr("Dnes")}</span>
            </button>
          )}
        </div>
        <div className="hb-row2">
          <span className="hb-text">
            {tr("předpověď pro")}{" "}
            <button
              type="button"
              className="hb-pick hb-place"
              onClick={() => setSearchOpen(true)}
              title={tr("Vybrat místo")}
            >
              {location ? location.name : tr("místo")}
            </button>{" "}
            {tr("na")}{" "}
            {forecast ? (
              <button
                ref={dayBtnRef}
                type="button"
                className={`hb-pick hb-day tb-daygroup ${
                  dayPanelOpen ? "open" : ""
                }`}
                style={
                  selectedDay
                    ? ({
                        "--tier": tierColor(tempTier(selectedDay.tempMax)),
                      } as CSSProperties)
                    : undefined
                }
                onClick={() => setDayPanelOpen((o) => !o)}
                aria-expanded={dayPanelOpen}
                title="Vybrat den"
              >
                {dayHeader(selectedDate || today)}
              </button>
            ) : (
              <span className="hb-pick hb-day-static" aria-hidden="true">
                {dayHeader(today)}
              </span>
            )}
          </span>
        </div>
        {forecast && dayPanelOpen && (
          <div
            ref={dayPanelRef}
            className="tb-daypanel tb-daygroup"
            style={
              {
                "--arrow-x": dayArrowX != null ? `${dayArrowX}px` : "50%",
                "--tier": selectedDay
                  ? tierColor(tempTier(selectedDay.tempMax))
                  : undefined,
              } as CSSProperties
            }
          >
            <span className="tb-daypanel-arrow" aria-hidden="true" />
            <DaySelector
              days={forecast.daily}
              selected={selectedDate}
              onSelect={(d) => setSelectedDate(d)}
              onLoadPast={loadMoreHistory}
              canLoadPast={pastDays < 92}
            />
          </div>
        )}
      </header>

      {notifyOpen && <NotifySettings onClose={() => setNotifyOpen(false)} />}

      {customizeOpen && (
        <CustomizeContent
          defs={WIDGET_DEFS}
          enabled={enabledOrder}
          hidden={hiddenOrder}
          onChange={(en, hi) => {
            setWidgetEnabled(en);
            setWidgetHidden(hi);
          }}
          onClose={() => setCustomizeOpen(false)}
        />
      )}

      <SearchBar
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        current={location}
        onSelect={setLocation}
        onLocate={handleLocate}
        locating={locating}
        favorites={favorites}
        isCurrentFav={isCurrentFav}
        onToggleCurrent={toggleFavorite}
        onToggleFavorite={toggleFavoriteFor}
        onRemove={removeFavorite}
        onRename={renameFavorite}
      />

      {forecast && (
        <button
          type="button"
          className="radar-fab"
          onClick={() => { posthog.capture("radar_opened"); setRadarOpen(true); }}
          title={tr("Radar srážek")}
          aria-label={tr("Otevřít radar")}
        >
          <RadarGlyph />
          <span className="radar-fab-label">{tr("Radar srážek")}</span>
        </button>
      )}

      {error && <div className="banner error">{error}</div>}
      {notice && forecast && <div className="banner notice">{notice}</div>}
      {offline && forecast && (
        <div className="banner offline">
          {fetchedAt != null
            ? tr(
                "Jste offline – zobrazuji uloženou předpověď z {when} ({rel}).",
                {
                  when: new Date(fetchedAt).toLocaleString(
                    lang === "cs" ? "cs-CZ" : "en-GB",
                    { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" },
                  ),
                  rel: relUpdated(fetchedAt, nowTick),
                },
              )
            : tr("Jste offline – zobrazuji naposledy uloženou předpověď.")}
        </div>
      )}
      {loading && !forecast ? (
        <Skeleton />
      ) : forecast ? (
        <main className="content">
          <div className="col-main">
            <WeatherAlerts lat={location.latitude} lon={location.longitude} />
            {!dayHasData && (
              <div className="banner notice nodata-notice">
                <span>
                  {tr(
                    "Pro tento den nemá model {model} předpověď – nejde dál než jeho horizont.",
                    { model: modelLabel(model) },
                  )}
                </span>
                {model !== DEFAULT_MODEL && (
                  <button
                    type="button"
                    className="nodata-switch"
                    onClick={() => setModel(DEFAULT_MODEL)}
                  >
                    {tr("Přepnout na Automaticky")}
                  </button>
                )}
              </div>
            )}
            {(() => {
              const els: Record<string, ReactNode> = {
                summary: selectedDay && dayHasData ? (
                  <SmartSummary
                    day={selectedDay}
                    hourly={forecast.hourly}
                    date={selectedDate}
                    isToday={selectedDate === today}
                    minutely={forecast.minutely15}
                    lat={location.latitude}
                    lon={location.longitude}
                    feelsMax={feelsMax}
                    feelsMin={feelsMin}
                  />
                ) : null,
                meteogram: dayHasData ? (
                  <Meteogram
                    hourly={forecast.hourly}
                    activeDate={selectedDate}
                    lat={location.latitude}
                    lon={location.longitude}
                    model={model}
                    theme={resolvedTheme}
                  />
                ) : null,
                wear: selectedDay && dayHasData ? (
                  <WhatToWear
                    day={selectedDay}
                    feelsMax={feelsMax}
                    feelsMin={feelsMin}
                    wakeRainSum={wakeRainSum}
                    wakeRainProb={wakeRainProb}
                    hourly={forecast.hourly}
                    date={selectedDate}
                  />
                ) : null,
                outlook: (
                  <HourlyForecast
                    hourly={forecast.hourly}
                    activeDate={selectedDate}
                    onSelectDay={setSelectedDate}
                  />
                ),
                webcams: (
                  <Webcams
                    lat={location.latitude}
                    lon={location.longitude}
                  />
                ),
                details: selectedDay && dayHasData ? (
                  <DayDetails
                    day={selectedDay}
                    air={air[selectedDate] ?? null}
                    date={selectedDate}
                    lat={location.latitude}
                    lon={location.longitude}
                    hourly={forecast.hourly}
                  />
                ) : null,
              };
              return enabledOrder.map((id) => (
                <Fragment key={id}>{els[id]}</Fragment>
              ));
            })()}
          </div>
        </main>
      ) : null}

      {radarOpen && (
        <Suspense fallback={null}>
          <RadarMap
            location={location}
            radar={radar}
            radarStatus={radarStatus}
            favorites={favorites}
            onSelect={setLocation}
            modal
            onClose={() => setRadarOpen(false)}
          />
        </Suspense>
      )}

      <div className="settings-bar">
        <label className="settings-model">
          <span className="settings-model-label">
            {tr("Zdroj dat (model)")}
          </span>
          <select
            className="settings-model-select"
            value={model}
            onChange={(e) => { posthog.capture("weather_model_changed", { model: e.target.value }); setModel(e.target.value); }}
          >
            {WEATHER_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.flag} {tr(m.label)}
              </option>
            ))}
          </select>
        </label>
        <div className="lang-switch" role="group" aria-label={tr("jazyk")}>
          <button
            type="button"
            className={`lang-btn ${lang === "cs" ? "active" : ""}`}
            onClick={() => { posthog.capture("language_changed", { language: "cs" }); setLang("cs"); }}
            aria-pressed={lang === "cs"}
            title="Čeština"
          >
            <FlagCZ />
          </button>
          <button
            type="button"
            className={`lang-btn ${lang === "en" ? "active" : ""}`}
            onClick={() => { posthog.capture("language_changed", { language: "en" }); setLang("en"); }}
            aria-pressed={lang === "en"}
            title="English"
          >
            <FlagEN />
          </button>
        </div>
        <button
          type="button"
          className="theme-toggle"
          onClick={() => {
            posthog.capture("theme_toggled", { from: themeMode });
            cycleTheme();
          }}
          aria-label={tr("Přepnout režim (systém/světlý/tmavý)")}
          title={tr("Přepnout režim (systém/světlý/tmavý)")}
        >
          {themeMode === "system" ? (
            <SystemGlyph />
          ) : themeMode === "light" ? (
            <SunGlyph />
          ) : (
            <MoonGlyph />
          )}
          <span>
            {themeMode === "system"
              ? tr("Podle systému")
              : themeMode === "light"
                ? tr("Světlý režim")
                : tr("Tmavý režim")}
          </span>
        </button>
      </div>

      <button
        type="button"
        className="customize-btn"
        onClick={() => {
          posthog.capture("customize_opened");
          setCustomizeOpen(true);
        }}
      >
        <GearGlyph />
        {tr("Přizpůsobit obsah")}
      </button>

      <footer className="footer">
        <p className="footer-note">
          {tr(
            "Vzniklo z frustrace, že chybělo počasí s intuitivním UX a přehledným zobrazením dat bez paywallu a reklam."
          )}
          <br />— <span className="footer-name">Jan Václavík</span>
          <br />
          <br />
          <a href="mailto:jvaclavik@gmail.com">{tr("Dejte mi vědět")}</a>
          {tr(", jak se vám líbí.")}
        </p>

        {fetchedAt != null && (
          <p
            className="footer-updated"
            title={new Date(fetchedAt).toLocaleString(
              lang === "en" ? "en-GB" : "cs-CZ"
            )}
          >
            {tr("Aktualizováno")} {relUpdated(fetchedAt, nowTick)}
          </p>
        )}

        <InstallHint />

        <div className="install-hint">
          <button
            type="button"
            className="install-btn"
            onClick={() => { posthog.capture("notification_settings_opened"); setNotifyOpen(true); }}
          >
            <BellGlyph />
            {tr("Upozornění na počasí")}
          </button>
        </div>

        <Donate />

        <div className="footer-links">
          <button type="button" className="footer-link-btn" onClick={shareLink}>
            {shared ? tr("Odkaz zkopírován") : tr("Sdílet odkaz")}
          </button>
          <span className="footer-sep">·</span>
          <a href="https://open-meteo.com" target="_blank" rel="noreferrer">
            Data: Open-Meteo (CC BY 4.0)
          </a>
          <span className="footer-sep">·</span>
          <a
            href="https://github.com/jvaclavik/zmoknu"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </div>

        <ReloadPrompt />
      </footer>
    </div>
  );
}

function skyTheme(code: number, isDay: boolean): string {
  if (!isDay) return "night";
  const icon = describeWeather(code).icon;
  if (icon === "clear" || icon === "partly") return "clear";
  if (icon === "rain" || icon === "drizzle" || icon === "thunder")
    return "rain";
  if (icon === "snow" || icon === "sleet") return "snow";
  return "cloud";
}

function BellGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </svg>
  );
}

function SunGlyph() {
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
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2 12h2.5M19.5 12H22M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
    </svg>
  );
}

function MoonGlyph() {
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
      <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
    </svg>
  );
}

function SystemGlyph() {
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
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

function GearGlyph() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 13a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.5 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.7 8.5a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
    </svg>
  );
}

function RadarGlyph() {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <circle
        cx="12"
        cy="12"
        r="5"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity="0.6"
      />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <path
        d="M12 12L19 7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SwipeArrow({ dir }: { dir: 1 | -1 }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d={dir === 1 ? "M9 6l6 6-6 6" : "M15 6l-6 6 6 6"}
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RefreshGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M20 11a8 8 0 1 0-.9 4.5"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M20 4v6h-6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FlagCZ() {
  return (
    <svg width="22" height="16" viewBox="0 0 6 4" aria-hidden="true">
      <rect width="6" height="2" y="0" fill="#fff" />
      <rect width="6" height="2" y="2" fill="#d7141a" />
      <path d="M0 0l3 2-3 2z" fill="#11457e" />
    </svg>
  );
}

function FlagEN() {
  return (
    <svg width="22" height="16" viewBox="0 0 60 40" aria-hidden="true">
      <rect width="60" height="40" fill="#012169" />
      <path d="M0 0l60 40M60 0L0 40" stroke="#fff" strokeWidth="8" />
      <path d="M0 0l60 40M60 0L0 40" stroke="#c8102e" strokeWidth="4" />
      <path d="M30 0v40M0 20h60" stroke="#fff" strokeWidth="12" />
      <path d="M30 0v40M0 20h60" stroke="#c8102e" strokeWidth="7" />
    </svg>
  );
}

function ClockGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12 7.5V12l3 2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
