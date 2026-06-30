import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Forecast, GeoLocation, RadarData } from "./types";
import { fetchForecast, reverseGeocode } from "./lib/openMeteo";
import { fetchRadar } from "./lib/rainviewer";
import { fetchAirQuality, type AirByDate } from "./lib/airQuality";
import { describeWeather } from "./lib/weatherCodes";
import { dayHeader, isoDate, todayISO } from "./lib/format";
import { TIER_COLOR, tempTier } from "./lib/tiers";
import SearchBar from "./components/SearchBar";
import { sameLocation } from "./components/FavoritesBar";
import DaySelector from "./components/DaySelector";
import WhatToWear from "./components/WhatToWear";
import BestWindow from "./components/BestWindow";
import DayDetails from "./components/DayDetails";
import Meteogram from "./components/Meteogram";
import HourlyForecast from "./components/HourlyForecast";
import RadarMap from "./components/RadarMap";

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
        name: p.get("name") ?? "Sdílené místo",
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchForecast(location.latitude, location.longitude, pastDays)
      .then((f) => {
        if (!cancelled) setForecast(f);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Chyba načítání");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [location, pastDays]);

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
    [forecast, selectedDate, loadMoreHistory],
  );

  // Na mobilu přepínej dny swipem do stran. Během vodorovného tažení zamkneme
  // svislý scroll (preventDefault) a z kraje vysuneme šipku jako „zpět" v Chrome.
  useEffect(() => {
    if (!forecast) return;
    const THRESHOLD = 90; // px do sepnutí přepnutí
    const EDGE = 32; // gesto musí začít u kraje obrazovky
    let startX = 0;
    let startY = 0;
    let track = false; // sledujeme gesto (dosud nerozhodnuté)
    let horizontal = false; // rozhodnuto = vodorovné tažení
    let allowedDir: 1 | -1 = 1; // směr povolený podle kraje startu
    let dir: 1 | -1 = 1;

    // Prvky s vlastním vodorovným gestem – swipe tam neřešíme.
    const BLOCK = [
      ".meteogram-plot",
      ".wear-grid",
      ".radar-card",
      ".dayselect",
      ".tb-daypanel",
      ".search-panel",
    ].join(",");

    const reset = () => {
      track = false;
      horizontal = false;
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
      // Gesto přepnutí dne smí začít jen u kraje: levý kraj = předchozí den
      // (tah doprava), pravý kraj = další den (tah doleva).
      const w = window.innerWidth;
      if (startX <= EDGE) allowedDir = -1;
      else if (startX >= w - EDGE) allowedDir = 1;
      else return;
      track = true;
      horizontal = false;
    };

    const onMove = (e: TouchEvent) => {
      if (!track) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;

      // Gesto od kraje hned „zabav" prohlížeči (jinak iOS Safari spustí swipe
      // zpět/vpřed dřív, než stihneme rozhodnout). Klepnutí bez pohybu ani scroll
      // uprostřed obrazovky se netýká – onMove tam vůbec neběží.
      if (e.cancelable) e.preventDefault();

      if (!horizontal) {
        // Dokud nemáme jasno, počkáme na výraznější pohyb.
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        const goingHoriz = Math.abs(dx) > Math.abs(dy) * 1.2;
        const wantDir: 1 | -1 = dx < 0 ? 1 : -1;
        const allowed = wantDir === 1 ? canNextRef.current : canPrevRef.current;
        // Směr musí odpovídat kraji startu i dostupnosti dat; jinak gesto pustíme
        // (svislý scroll se obnoví při dalším pohybu).
        if (!goingHoriz || wantDir !== allowedDir || !allowed) {
          track = false;
          return;
        }
        horizontal = true;
        dir = wantDir;
      }

      const progress = Math.min(1, Math.abs(dx) / THRESHOLD);
      swipeReadyRef.current = progress >= 1;
      setSwipe({ dir, progress, ready: progress >= 1 });
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
        : [...prev, location],
    );
  }, [location]);

  const removeFavorite = useCallback((loc: GeoLocation) => {
    setFavorites((prev) => prev.filter((f) => !sameLocation(f, loc)));
  }, []);

  // Aktualizace barevného motivu pozadí podle aktuálního počasí.
  useEffect(() => {
    const code = forecast?.current.weatherCode ?? 0;
    const isDay = forecast?.current.isDay ?? true;
    document.body.dataset.sky = skyTheme(code, isDay);
  }, [forecast]);

  const handleLocate = useCallback(() => {
    if (!navigator.geolocation) {
      setError("Geolokace není v tomto prohlížeči dostupná.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        const name = await reverseGeocode(latitude, longitude);
        setLocation({ name, latitude, longitude });
        setLocating(false);
      },
      () => {
        setError("Polohu se nepodařilo zjistit.");
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }, []);

  const selectedDay =
    forecast?.daily.find((d) => d.time === selectedDate) ?? forecast?.daily[0];

  const today = todayISO();

  // Rozbalovací výběr dnů přímo v hlavičce (toggle přes tb-day).
  const [dayPanelOpen, setDayPanelOpen] = useState(false);
  const [radarOpen, setRadarOpen] = useState(false);

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
        <div className="brand">
          <BrandGlyph />
          <span>Zmoknu<em>?</em></span>
        </div>
        <div className="topbar-ctx">
          {forecast && (
            <button
              type="button"
              className="tb-radar"
              onClick={() => setRadarOpen(true)}
              title="Radar srážek"
              aria-label="Otevřít radar"
            >
              <RadarGlyph />
            </button>
          )}
          <SearchBar
            current={location}
            onSelect={setLocation}
            onLocate={handleLocate}
            locating={locating}
            favorites={favorites}
            isCurrentFav={isCurrentFav}
            onToggleCurrent={toggleFavorite}
            onRemove={removeFavorite}
          />
          {forecast && selectedDate && selectedDate !== today && (
            <div className="tb-dayswitch tb-daygroup">
              <span className="tb-caption">Přepnout na:</span>
              <button
                type="button"
                className="tb-today"
                onClick={() => setSelectedDate(today)}
                title="Přejít na dnešek"
              >
                Dnes
              </button>
            </div>
          )}
          {forecast && (
            <div className="tb-daywrap tb-daygroup">
              <span className="tb-caption">Předpověď pro:</span>
              <div className="tb-daynav">
                <button
                  type="button"
                  className="tb-dayarrow"
                  onClick={() => changeDay(-1)}
                  disabled={!canPrev}
                  aria-label="Předchozí den"
                >
                  <TbChevron dir="left" />
                </button>
                <button
                  type="button"
                  className={`tb-day ${dayPanelOpen ? "open" : ""}`}
                  style={
                    selectedDay
                      ? ({
                          "--tier": TIER_COLOR[tempTier(selectedDay.tempMax)],
                        } as CSSProperties)
                      : undefined
                  }
                  onClick={() => setDayPanelOpen((o) => !o)}
                  aria-expanded={dayPanelOpen}
                >
                  <span className="tb-day-label">
                    {dayHeader(selectedDate || today)}
                  </span>
                </button>
                <button
                  type="button"
                  className="tb-dayarrow"
                  onClick={() => changeDay(1)}
                  disabled={!canNext}
                  aria-label="Další den"
                >
                  <TbChevron dir="right" />
                </button>
              </div>
            </div>
          )}
        </div>
        {forecast && dayPanelOpen && (
          <div className="tb-daypanel tb-daygroup">
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

      {error && <div className="banner error">{error}</div>}

      {loading && !forecast ? (
        <div className="loading-screen">
          <RainLoader />
          <p>Načítám počasí…</p>
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
            />
            {selectedDay && (
              <WhatToWear
                day={selectedDay}
                dayLabel={dayHeader(selectedDay.time)}
                feelsMax={feelsMax}
                feelsMin={feelsMin}
                wakeRainSum={wakeRainSum}
                wakeRainProb={wakeRainProb}
              />
            )}
            <HourlyForecast
              hourly={forecast.hourly}
              activeDate={selectedDate}
              onSelectDay={setSelectedDate}
            />
            <BestWindow hourly={forecast.hourly} date={selectedDate} />
            {selectedDay && (
              <DayDetails day={selectedDay} air={air[selectedDate] ?? null} />
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

      <footer className="footer">
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
      </footer>
    </div>
  );
}

function skyTheme(code: number, isDay: boolean): string {
  if (!isDay) return "night";
  const icon = describeWeather(code).icon;
  if (icon === "clear" || icon === "partly") return "clear";
  if (icon === "rain" || icon === "drizzle" || icon === "thunder") return "rain";
  if (icon === "snow" || icon === "sleet") return "snow";
  return "cloud";
}

function TbChevron({ dir }: { dir: "left" | "right" | "down" }) {
  const d =
    dir === "left" ? "M15 5l-7 7 7 7" : dir === "down" ? "M5 9l7 7 7-7" : "M9 5l7 7-7 7";
  return (
    <svg
      width={dir === "down" ? 13 : 16}
      height={dir === "down" ? 13 : 16}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RadarGlyph() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <path d="M12 12L19 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function SwipeArrow({ dir }: { dir: 1 | -1 }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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

function BrandGlyph() {
  return (
    <svg width="26" height="26" viewBox="0 0 64 64" aria-hidden="true">
      <path
        d="M20 42a11 11 0 0 1 1-22 14 14 0 0 1 26 4 9 9 0 0 1-2 18H20z"
        fill="#dfe7f5"
      />
      <line x1="24" y1="48" x2="21" y2="58" stroke="#5bb6ff" strokeWidth="3" strokeLinecap="round" />
      <line x1="34" y1="48" x2="31" y2="58" stroke="#5bb6ff" strokeWidth="3" strokeLinecap="round" />
      <line x1="44" y1="48" x2="41" y2="58" stroke="#5bb6ff" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
