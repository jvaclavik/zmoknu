import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import DayDetails from "./components/DayDetails";
import DaySelector from "./components/DaySelector";
import { sameLocation } from "./components/FavoritesBar";
import HourlyForecast from "./components/HourlyForecast";
import Meteogram from "./components/Meteogram";
import RadarMap from "./components/RadarMap";
import SearchBar from "./components/SearchBar";
import WhatToWear from "./components/WhatToWear";
import { fetchAirQuality, type AirByDate } from "./lib/airQuality";
import { dayHeader, isoDate, todayISO } from "./lib/format";
import { DEFAULT_MODEL, WEATHER_MODELS } from "./lib/models";
import { fetchForecast, reverseGeocode } from "./lib/openMeteo";
import { fetchRadar } from "./lib/rainviewer";
import { tr, useLang } from "./lib/i18n";
import { TIER_COLOR, tempTier } from "./lib/tiers";
import { useStoredState } from "./lib/useStoredState";
import { describeWeather } from "./lib/weatherCodes";
import type { Forecast, GeoLocation, RadarData } from "./types";

type RadarStatus = "loading" | "ok" | "error";

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
  const [model, setModel] = useStoredState<string>("zmoknu.model", DEFAULT_MODEL);
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchForecast(location.latitude, location.longitude, pastDays, model)
      .then((f) => {
        if (!cancelled) setForecast(f);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : tr("Chyba načítání"));
          // Nezobrazuj stará/rozbitá data – ať je vidět jen hláška.
          setForecast(null);
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

  // Při změně místa zahodíme načtenou historii.
  useEffect(() => {
    setPastDays(1);
    setPendingDate(null);
  }, [location]);

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

  // Donačtení dalšího dne historie (až ~3 měsíce zpět – limit Open-Meteo).
  const loadMoreHistory = useCallback(() => {
    const next = Math.min(92, pastDays + 1);
    if (next === pastDays) return;
    const earliest = new Date();
    earliest.setDate(earliest.getDate() - next);
    setPendingDate(isoDate(earliest));
    setPastDays(next);
  }, [pastDays]);

  const changeDay = useCallback(
    (delta: number) => {
      if (!forecast) return;
      const dates = forecast.daily.map((d) => d.time);
      const idx = dates.indexOf(selectedDate);
      if (idx === -1) return;
      // Na nejstarším dni a krok doleva → zkusíme donačíst historii.
      if (delta < 0 && idx === 0) {
        loadMoreHistory();
        return;
      }
      const next = dates[Math.min(dates.length - 1, Math.max(0, idx + delta))];
      if (next) setSelectedDate(next);
    },
    [forecast, selectedDate, loadMoreHistory]
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
    setFavorites((prev) =>
      prev.some((f) => sameLocation(f, location))
        ? prev.filter((f) => !sameLocation(f, location))
        : [...prev, location]
    );
  }, [location]);

  const removeFavorite = useCallback((loc: GeoLocation) => {
    setFavorites((prev) => prev.filter((f) => !sameLocation(f, loc)));
  }, []);

  const toggleFavoriteFor = useCallback((loc: GeoLocation) => {
    setFavorites((prev) =>
      prev.some((f) => sameLocation(f, loc))
        ? prev.filter((f) => !sameLocation(f, loc))
        : [...prev, loc]
    );
  }, []);

  // Aktualizace barevného motivu pozadí podle aktuálního počasí.
  useEffect(() => {
    const code = forecast?.current.weatherCode ?? 0;
    const isDay = forecast?.current.isDay ?? true;
    document.body.dataset.sky = skyTheme(code, isDay);
  }, [forecast]);

  const handleLocate = useCallback(() => {
    if (!navigator.geolocation) {
      setError(tr("Geolokace není v tomto prohlížeči dostupná."));
      return;
    }
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
        return;
      }
      await navigator.clipboard.writeText(url);
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

  return (
    <div className="app">
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
      <header className="topbar">
        <div className="hb-row1">
          <span className="hb-brand" aria-hidden="true">
            <img src="/logo.svg" alt="" className="hb-logo-img" />
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
                        "--tier": TIER_COLOR[tempTier(selectedDay.tempMax)],
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
              <span className="hb-day-static">{tr("dnes")}</span>
            )}
          </span>
        </div>
        {forecast && dayPanelOpen && (
          <div
            ref={dayPanelRef}
            className="tb-daypanel tb-daygroup"
            style={
              {
                "--arrow-x":
                  dayArrowX != null ? `${dayArrowX}px` : "50%",
                "--tier": selectedDay
                  ? TIER_COLOR[tempTier(selectedDay.tempMax)]
                  : undefined,
              } as CSSProperties
            }
          >
            <span className="tb-daypanel-arrow" aria-hidden="true" />
            <DaySelector
              days={forecast.daily}
              selected={selectedDate}
              onSelect={(d) => setSelectedDate(d)}
              onStep={changeDay}
              canLoadPast={pastDays < 92}
            />
          </div>
        )}
      </header>

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
      />

      {forecast && (
        <button
          type="button"
          className="radar-fab"
          onClick={() => setRadarOpen(true)}
          title={tr("Radar srážek")}
          aria-label={tr("Otevřít radar")}
        >
          <RadarGlyph />
        </button>
      )}

      {error && <div className="banner error">{error}</div>}

      {loading && !forecast ? (
        <div className="loading-screen">
          <RainLoader />
          <p>{tr("Načítám počasí…")}</p>
        </div>
      ) : forecast ? (
        <main className="content">
          <div className="col-main">
            <Meteogram
              hourly={forecast.hourly}
              activeDate={selectedDate}
              day={selectedDay}
              feelsMax={feelsMax}
              feelsMin={feelsMin}
              lat={location.latitude}
              lon={location.longitude}
              model={model}
            />
            {selectedDay && (
              <WhatToWear
                day={selectedDay}
                feelsMax={feelsMax}
                feelsMin={feelsMin}
                wakeRainSum={wakeRainSum}
                wakeRainProb={wakeRainProb}
                hourly={forecast.hourly}
                date={selectedDate}
              />
            )}
            <HourlyForecast
              hourly={forecast.hourly}
              activeDate={selectedDate}
              onSelectDay={setSelectedDate}
            />
            {selectedDay && (
              <DayDetails
                day={selectedDay}
                air={air[selectedDate] ?? null}
                date={selectedDate}
              />
            )}
          </div>
        </main>
      ) : null}

      {radarOpen && (
        <RadarMap
          location={location}
          radar={radar}
          radarStatus={radarStatus}
          favorites={favorites}
          onSelect={setLocation}
          modal
          onClose={() => setRadarOpen(false)}
        />
      )}

      <div className="settings-bar">
        <label className="settings-model">
          <span className="settings-model-label">{tr("Zdroj dat (model)")}</span>
          <select
            className="settings-model-select"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            {WEATHER_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {tr(m.label)}
              </option>
            ))}
          </select>
        </label>
        <div className="lang-switch" role="group" aria-label={tr("jazyk")}>
          <button
            type="button"
            className={`lang-btn ${lang === "cs" ? "active" : ""}`}
            onClick={() => setLang("cs")}
            aria-pressed={lang === "cs"}
            title="Čeština"
          >
            <FlagCZ />
          </button>
          <button
            type="button"
            className={`lang-btn ${lang === "en" ? "active" : ""}`}
            onClick={() => setLang("en")}
            aria-pressed={lang === "en"}
            title="English"
          >
            <FlagEN />
          </button>
        </div>
      </div>

      <footer className="footer">
        <p className="footer-note">
          {tr(
            "„Vzniklo z frustrace, že chybí počasí s intuitivním UX, dobrými daty, historií bez paywallu a reklam. Tak jsem ho udělal.“",
          )}
          <br />—{" "}
          <span className="footer-name">Jan Václavík</span>
          <br />
          <br />
          <a href="mailto:jvaclavik@gmail.com">{tr("Dejte mi vědět")}</a>
          {tr(", jak se vám líbí.")}
        </p>

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

function RainLoader() {
  return (
    <svg
      className="rain-loader"
      width="104"
      height="104"
      viewBox="0 0 64 64"
      aria-hidden="true"
    >
      <path
        className="rain-loader-cloud"
        d="M20 42a11 11 0 0 1 1-22 14 14 0 0 1 26 4 9 9 0 0 1-2 18H20z"
        fill="#dfe7f5"
      />
      <g
        className="rain-loader-drops"
        stroke="#5bb6ff"
        strokeWidth="3"
        strokeLinecap="round"
      >
        <line className="d1" x1="24" y1="45" x2="24" y2="52" />
        <line className="d2" x1="33" y1="45" x2="33" y2="52" />
        <line className="d3" x1="42" y1="45" x2="42" y2="52" />
      </g>
    </svg>
  );
}

function RefreshGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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

