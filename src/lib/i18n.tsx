import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { useStoredState } from "./useStoredState";

export type Lang = "cs" | "en";

// Modulový jazyk – čtou ho i čisté funkce (format.ts apod.), které nejsou
// React komponenty. Provider ho nastaví při renderu (viz LangProvider), takže
// při změně jazyka se překreslí celý strom a čisté funkce vrátí správný text.
let currentLang: Lang = "cs";

export function getLang(): Lang {
  return currentLang;
}

export function detectLang(): Lang {
  if (typeof navigator === "undefined") return "cs";
  const l = (navigator.language || "").toLowerCase();
  return l.startsWith("cs") || l.startsWith("sk") ? "cs" : "en";
}

// Anglický slovník. Klíč = česká předloha (kanonický text v kódu). Když text
// v EN chybí, vrátí se česká předloha (bezpečný fallback).
const EN: Record<string, string> = {
  // App
  "Chyba načítání": "Loading error",
  "Geolokace není v tomto prohlížeči dostupná.":
    "Geolocation isn’t available in this browser.",
  "Polohu se nepodařilo zjistit.": "Couldn’t determine your location.",
  "předpověď pro": "forecast for",
  místo: "place",
  na: "for",
  dnes: "today",
  "Vybrat místo": "Choose place",
  "Přejít na dnešek": "Go to today",
  Dnes: "Today",
  "Radar srážek": "Precipitation radar",
  "Otevřít radar": "Open radar",
  "Načítám počasí…": "Loading weather…",
  "Zdroj dat (model)": "Data source (model)",
  "Předpověď z Open-Meteo. Modely lze porovnat v meteogramu (ikona oka → multimód). ČHMÚ ALADIN pokrývá jen ČR a krátké okno – když nemá data, přepni na jiný model.":
    "Forecast by Open-Meteo. Models can be compared in the meteogram (eye icon → multi). ČHMÚ ALADIN covers only Czechia and a short window – switch to another model when it has no data.",
  "Vzniklo z frustrace, že chybělo počasí s intuitivním UX a přehledným zobrazením dat bez paywallu a reklam.":
    "Born out of frustration that there was no weather app with intuitive UX and a clear presentation of data without a paywall or ads.",
  "Dejte mi vědět": "Let me know",
  ", jak se vám líbí.": " how you like it.",
  "Odkaz zkopírován": "Link copied",
  "Sdílet odkaz": "Share link",
  Aktualizováno: "Updated",
  "Nainstalovat aplikaci": "Install app",
  "Nainstalovat do telefonu": "Install on your phone",
  "V Safari klepni na": "In Safari tap",
  Sdílet: "Share",
  Zvol: "Choose",
  "Přidat na plochu": "Add to Home Screen",
  "Potvrď „Přidat“ – appka bude na ploše jako ikona.":
    "Confirm “Add” – the app appears on your Home Screen as an icon.",
  "Otevři menu prohlížeče": "Open the browser menu",
  "Potvrď – appka se přidá mezi aplikace.":
    "Confirm – the app is added to your apps.",
  "právě teď": "just now",
  "před {n} min": "{n} min ago",
  "Data: Open-Meteo (CC BY 4.0)": "Data: Open-Meteo (CC BY 4.0)",
  "Počasí – {name}": "Weather – {name}",
  "Sdílené místo": "Shared place",
  jazyk: "language",

  // tiers
  horko: "hot",
  teplo: "warm",
  akorát: "just right",
  chladno: "cool",
  zima: "cold",
  mráz: "freezing",

  // weather codes
  Jasno: "Clear",
  "Skoro jasno": "Mostly clear",
  Polojasno: "Partly cloudy",
  Zataženo: "Overcast",
  Mlha: "Fog",
  "Mrznoucí mlha": "Freezing fog",
  "Slabé mrholení": "Light drizzle",
  Mrholení: "Drizzle",
  "Silné mrholení": "Heavy drizzle",
  "Mrznoucí mrholení": "Freezing drizzle",
  "Silné mrznoucí mrholení": "Heavy freezing drizzle",
  "Slabý déšť": "Light rain",
  Déšť: "Rain",
  "Vydatný déšť": "Heavy rain",
  "Mrznoucí déšť": "Freezing rain",
  "Silný mrznoucí déšť": "Heavy freezing rain",
  "Slabé sněžení": "Light snow",
  Sněžení: "Snow",
  "Vydatné sněžení": "Heavy snow",
  "Sněhová zrna": "Snow grains",
  "Slabé přeháňky": "Light showers",
  Přeháňky: "Showers",
  "Silné přeháňky": "Heavy showers",
  "Sněhové přeháňky": "Snow showers",
  "Silné sněhové přeháňky": "Heavy snow showers",
  Bouřka: "Thunderstorm",
  "Bouřka s kroupami": "Thunderstorm with hail",
  "Silná bouřka s kroupami": "Severe thunderstorm with hail",
  Neznámé: "Unknown",

  // meteogram data labels
  Teplota: "Temperature",
  "Pocitová teplota": "Feels-like",
  Srážky: "Precipitation",
  Vítr: "Wind",
  Oblačnost: "Cloud cover",
  Vlhkost: "Humidity",
  "Rosný bod": "Dew point",
  Tlak: "Pressure",
  "Zobrazení dat": "Data display",
  "Počet dní": "Number of days",
  "Počet zobrazených dní": "Number of displayed days",
  "Rozlišit den a noc": "Show day and night",
  "Délka dne během roku": "Daylight length over the year",
  "Kolik hodin je za den světlo (od východu do západu Slunce) v průběhu roku. Svislá čára je vybraný den, čísla dole jsou měsíce.":
    "How many hours of daylight (sunrise to sunset) there are through the year. The vertical line is the selected day, the numbers below are months.",
  "prodlužuje se o {n} min/den": "getting longer by {n} min/day",
  "zkracuje se o {n} min/den": "getting shorter by {n} min/day",
  "nejdelší den v roce": "longest day of the year",
  "nejkratší den v roce": "shortest day of the year",
  "Historický normál (30 let)": "Historical normal (30 yr)",
  Normál: "Normal",
  "Průměrná teplota pro daný den z let 1995–2024 (ERA5). Zobrazí se u grafu teploty.":
    "Average temperature for the given day from 1995–2024 (ERA5). Shown on the temperature chart.",
  "Průměrná teplota pro daný den z let 1995–2024 (ERA5).":
    "Average temperature for the given day from 1995–2024 (ERA5).",
  Průměr: "Average",
  "Průměr 1995–2024": "Average 1995–2024",
  "Aktuální průměr": "Current average",
  Odchylka: "Anomaly",
  "Průměr předpovědi pro tento den.": "Forecast average for this day.",
  "Odchylka od historického normálu.": "Anomaly from the historical normal.",
  "Připnuté hodnoty se zobrazují nad grafem. Klikni na řádek pro zobrazení v grafu.":
    "Pinned values show above the chart. Click a row to display it in the chart.",
  Odepnout: "Unpin",
  "Připnout nad graf": "Pin above chart",
  "Porovnat modely (multimód)": "Compare models (multi)",
  Vše: "All",
  Zrušit: "Clear",
  "Porovnání modelů není u oblačnosti dostupné.":
    "Model comparison isn’t available for cloud cover.",
  "Pro {label} meteogram není k dispozici – hodinová data sahají jen několik dní dopředu.":
    "The meteogram isn’t available for {label} – hourly data only reaches a few days ahead.",
  vysoká: "high",
  střední: "medium",
  nízká: "low",
  "Shoda modelů": "Model agreement",
  "Výstrahy ČHMÚ": "ČHMÚ weather alerts",
  Teď: "Now",
  Now: "Now",
  "Automaticky = Open-Meteo vybírá nejvhodnější model podle lokality (v ČR obvykle ICON-D2/ICON-EU pro první dny, ECMWF pro vzdálenější).":
    "Automatic = Open-Meteo picks the most suitable model by location (in Czechia usually ICON-D2/ICON-EU for the first days, ECMWF for later ones).",
  "„Automaticky“ volí nejlepší model dle lokality (v ČR ICON, pro vzdálenější dny ECMWF).":
    "“Automatic” picks the best model by location (ICON in Czechia, ECMWF for later days).",
  "Zobrazit graf teploty": "Show temperature chart",
  "Zobrazit graf pocitové teploty": "Show feels-like chart",
  "Zobrazit graf srážek": "Show precipitation chart",
  "Zobrazit graf větru": "Show wind chart",
  "Zobrazit graf oblačnosti": "Show cloud cover chart",
  "Zobrazit graf vlhkosti": "Show humidity chart",
  "Zobrazit graf rosného bodu": "Show dew point chart",
  "Zobrazit graf tlaku": "Show pressure chart",
  pocitově: "feels like",
  teplota: "temperature",
  "srážky ({prob} %)": "precipitation ({prob} %)",
  "vítr (nárazy {g} m/s)": "wind (gusts {g} m/s)",
  oblačnost: "cloud cover",
  vlhkost: "humidity",
  "rosný bod": "dew point",
  tlak: "pressure",
  Meteogram: "Meteogram",
  "{prob}% šance": "{prob}% chance",
  "0% šance": "0% chance",

  // WhatToWear + OutfitTester
  "Co si vzít na sebe": "What to wear",
  "Jak to počítám?": "How I calculate it?",
  "Jak to počítám": "How I calculate it",
  "Podle pocitové teploty {min}–{max}°": "Based on feels-like {min}–{max}°",
  Triko: "T-shirt",
  "Triko (dlouhý rukáv)": "Long-sleeve tee",
  "spodní vrstva": "base layer",
  "{a}–{b} °C – přechodná vrstva": "{a}–{b} °C – transitional layer",
  Kraťasy: "Shorts",
  "Dlouhé kalhoty": "Long trousers",
  Mikina: "Hoodie",
  "Teplý svetr": "Warm sweater",
  "Zimní bunda": "Winter coat",
  Čepice: "Beanie",
  Šála: "Scarf",
  Rukavice: "Gloves",
  "Peřová vesta": "Down vest",
  "Peřová bunda": "Down jacket",
  "drží jádro v teple": "keeps your core warm",
  "zateplí i ruce": "warms your arms too",
  Deštník: "Umbrella",
  "Nepromokavá bunda": "Waterproof jacket",
  "Pevné boty": "Sturdy boots",
  Větrovka: "Windbreaker",
  Kšiltovka: "Cap",
  "Sluneční brýle": "Sunglasses",
  "Opalovací krém": "Sunscreen",
  "na ráno a večer": "for morning and evening",
  "pro jistotu": "just in case",
  "s kapucí": "with a hood",
  neprofoukne: "windproof",
  určitě: "definitely",
  "spíš ano": "likely",
  možná: "maybe",
  "spíš ne": "unlikely",
  "Bude horko – obleč se lehce": "It’ll be hot – dress light",
  "Příjemně teplo": "Pleasantly warm",
  "Akorát – nic extrémního": "Just right – nothing extreme",
  "Spíš chladno": "Rather cool",
  "Zima – pořádně se obleč": "Cold – dress warmly",
  "Mrzne – navlékni vrstvy": "Freezing – layer up",
  "Vezmi si deštník, může pršet": "Take an umbrella, it may rain",
  "Bude foukat – vezmi větrovku": "It’ll be windy – take a windbreaker",
  "Praží slunce – chraň se před UV": "Strong sun – protect against UV",
  "Pocitová teplota (max)": "Feels-like (max)",
  "Pocitová teplota (min)": "Feels-like (min)",
  "Srážky za den": "Precipitation per day",
  "Pravděpodobnost srážek": "Precipitation probability",
  "Vítr (max)": "Wind (max)",
  "UV index": "UV index",
  Podmínky: "Conditions",
  Aktivita: "Activity",
  Sedím: "Sitting",
  Chodím: "Walking",
  Běhám: "Running",
  "Aktivita posouvá pocitovou teplotu: pohyb hřeje, klid ochlazuje.":
    "Activity shifts the feels-like temperature: moving warms you, resting cools you.",
  "Doporučení platí na celý (bdělý) den, ne na jednu hodinu. Teplota vychází z pocitové (ne reálné): hlavní vrstvu určí denní maximum, minimum přidá vrstvu navíc na chladnější ráno a večer. Déšť se počítá z denních hodin 6–22 (noční se neřeší, kromě vydatných srážek z celodenního úhrnu), vítr a UV jsou denní maxima.":
    "The recommendation covers the whole waking day, not a single hour. Temperature is based on feels-like (not the real one): the daily high sets the main layer, while the low adds an extra layer for cooler mornings and evenings. Rain is computed from daytime hours 6–22 (night is ignored, except heavy rain based on the full-day total); wind and UV are daily maxima.",
  "Vyhodnocené podmínky": "Evaluated conditions",
  "Oblečení se skládá podle pocitové teploty, na kterou pak navazují srážky, vítr, sníh a UV. Aktivní podmínky (zeleně) přidávají další kusy.":
    "The outfit is built from the feels-like temperature, then precipitation, wind, snow and UV are layered on. Active conditions (green) add more items.",
  "Zeleně zvýrazněné kusy plynou z právě nastavených hodnot. Prahy jsou vztažené k pocitové teplotě (max/min), ne k reálné.":
    "Items highlighted in green follow from the current values. Thresholds are relative to the feels-like temperature (max/min), not the actual one.",
  "Základní vrstva podle pocitové teploty (max)":
    "Base layer by feels-like temperature (max)",
  "Doplňky podle podmínek": "Extras by conditions",
  "teplo a víc – max ≥ {t} °C": "warm and up – max ≥ {t} °C",
  "akorát a chladněji – max < {t} °C": "mild and cooler – max < {t} °C",
  "max ≥ {t} °C": "max ≥ {t} °C",
  "chladno ({a}–{b} °C) nebo chladnější ráno/večer":
    "cool ({a}–{b} °C) or cooler morning/evening",
  "zima a níž – max < {t} °C": "cold and below – max < {t} °C",
  "max < {t} °C nebo sníh": "max < {t} °C or snow",
  "mráz – max < {t} °C": "freezing – max < {t} °C",
  "Peřové vrstvy podle aktivity": "Down layers by activity",
  "chladno a pohyb – zahřeje jádro, ruce nechá dýchat":
    "cool and moving – warms the core, lets arms breathe",
  "zima nebo klid (sezení) – plné zateplení s rukávy":
    "cold or resting (sitting) – full insulation with sleeves",
  "teplo a víc – max ≥ 22 °C": "warm and up – max ≥ 22 °C",
  "akorát a chladněji – max < 22 °C": "mild and cooler – max < 22 °C",
  "max ≥ 16 °C": "max ≥ 16 °C",
  "chladno (9–15 °C), nebo min < 15 °C / akorát den do 20 °C":
    "cool (9–15 °C), or min < 15 °C / mild day up to 20 °C",
  "zima a níž – max < 9 °C": "cold and below – max < 9 °C",
  "mráz – max < 2 °C": "freezing – max < 2 °C",
  "max < 9 °C nebo sníh": "max < 9 °C or snow",
  "déšť přes den – úhrn ≥ 1,5 mm, nebo ≥ 55 % a ≥ 0,5 mm":
    "rain during the day – total ≥ 1.5 mm, or ≥ 55 % and ≥ 0.5 mm",
  "déšť spolu s větrem nebo zimou": "rain together with wind or cold",
  "vítr ≥ 9 m/s": "wind ≥ 9 m/s",
  "sníh (sněžení, nebo max ≤ 1 °C se srážkami)":
    "snow (snowfall, or max ≤ 1 °C with precipitation)",
  "UV ≥ 6 a neprší": "UV ≥ 6 and no rain",
  "Déšť pravděpodobný": "Rain likely",
  "→ deštník / pláštěnka": "→ umbrella / raincoat",
  "→ určitě deštník + pláštěnka": "→ definitely umbrella + raincoat",
  Sníh: "Snow",
  "→ pevné boty a čepice": "→ sturdy boots and beanie",
  "→ větrovka / pláštěnka s kapucí": "→ windbreaker / hooded raincoat",
  "denní maximum pod 9 °C": "daytime high below 9 °C",
  Slunečno: "Sunny",
  "→ kšiltovka, brýle, krém": "→ cap, sunglasses, sunscreen",

  // HourlyForecast
  Výhled: "Forecast",
  "Krok výhledu": "Forecast step",
  Čas: "Time",
  "Vítr (m/s)": "Wind (m/s)",
  "{prob}% šance na déšť": "{prob}% chance of rain",

  // BestWindow
  "Dnes spíš nic moc – celý den buď prší, nebo fouká. Vezmi pláštěnku.":
    "Not great today – it rains or blows all day. Take a raincoat.",
  "Nejlepší okno na ven": "Best window to go out",

  // DayDetails
  "Další detaily": "More details",
  "Slunce a Měsíc": "Sun & Moon",
  "Ovzduší a UV": "Air & UV",
  "Východ / západ": "Sunrise / sunset",
  Prach: "Dust",
  "Délka dne": "Daylight length",
  "Východ / západ slunce": "Sunrise / sunset",
  "UV index (max)": "UV index (max)",
  "Kvalita ovzduší": "Air quality",
  "Prach (PM2.5 / PM10)": "Dust (PM2.5 / PM10)",
  Pyl: "Pollen",
  nízký: "low",
  "Krém netřeba.": "No sunscreen needed.",
  "Při delším pobytu venku SPF 30.": "SPF 30 for longer time outdoors.",
  vysoký: "high",
  "Krém SPF 30+, brýle, stín v poledne.":
    "SPF 30+, sunglasses, shade at noon.",
  "velmi vysoký": "very high",
  "Vyhni se slunci 11–15 h, krém SPF 50.":
    "Avoid the sun 11–15h, SPF 50.",
  extrémní: "extreme",
  "Omez pobyt na slunci na minimum.": "Minimize time in the sun.",
  mírný: "mild",
  zvýšený: "elevated",
  "Měsíc": "Moon",
  "osvětlení {n} %": "illuminated {n} %",
  nov: "new moon",
  "dorůstající srpek": "waxing crescent",
  "první čtvrť": "first quarter",
  "dorůstající měsíc": "waxing gibbous",
  "úplněk": "full moon",
  "couvající měsíc": "waning gibbous",
  "poslední čtvrť": "last quarter",
  "couvající srpek": "waning crescent",
  "Zlatá hodinka": "Golden hour",
  "večer": "evening",
  Bouřky: "Thunderstorms",
  "Riziko bouřek": "Storm risk",
  "Bez bouřek": "No storms",
  "Bouřky možné": "Storms possible",
  "Bouřky pravděpodobné": "Storms likely",
  "Silné bouřky": "Severe storms",
  "Bouřky s krupobitím": "Storms with hail",
  "mezi {a} a {b}": "between {a} and {b}",
  "možné kroupy": "hail possible",
  "energie CAPE {n} J/kg": "CAPE energy {n} J/kg",

  // airQuality
  Olše: "Alder",
  Bříza: "Birch",
  Trávy: "Grasses",
  Ambrózie: "Ragweed",
  Výborné: "Excellent",
  Dobré: "Good",
  Zhoršené: "Moderate",
  Špatné: "Poor",
  "Velmi špatné": "Very poor",
  Extrémní: "Extreme",
  "velmi vysoká": "very high",

  // DaySelector
  Zítra: "Tomorrow",
  Včera: "Yesterday",
  "Načíst předchozí den": "Load previous day",
  "Předchozí den": "Previous day",
  "Další den": "Next day",
  "Načíst další den historie": "Load one more day of history",

  // RadarMap
  "Nastavení radaru": "Radar settings",
  Zdroj: "Source",
  "ČHMÚ · ČR": "ČHMÚ · CZ",
  "RainViewer · svět": "RainViewer · world",
  Interval: "Interval",
  Mapa: "Map",
  Světlá: "Light",
  Tmavá: "Dark",
  Vrstvy: "Layers",
  "Vrstva oblačnosti vyžaduje API klíč OpenWeatherMap.":
    "The cloud layer requires an OpenWeatherMap API key.",
  "Oblačnost = družice ČHMÚ (orientačně umístěná).":
    "Cloud cover = ČHMÚ satellite (approximate placement).",
  "Zavřít radar": "Close radar",
  "Radar není k dispozici": "Radar isn’t available",
  "Načítám radar…": "Loading radar…",
  "Načítám úhrn…": "Loading totals…",
  "Přednačítám snímky…": "Preloading frames…",
  minulost: "past",
  nyní: "now",
  předpověď: "forecast",
  teď: "now",
  "před {n} dny": "{n} days ago",
  "před {n} h": "{n} h ago",
  "za {n} h": "in {n} h",
  Předpověď: "Forecast",
  "Předpověď srážek z modelu (Open-Meteo, ICON). Není to radar – ukazuje očekávaný vývoj na příštích 24 h.":
    "Model precipitation forecast (Open-Meteo, ICON). Not radar – shows the expected development over the next 24 h.",
  "Úhrn": "Totals",
  Období: "Period",
  "Úhrn srážek z modelu Open-Meteo (mm za období).":
    "Precipitation totals from the Open-Meteo model (mm over the period).",
  "Úhrn srážek z radaru ČHMÚ (MERGE, mm za období).":
    "Precipitation totals from ČHMÚ radar (MERGE, mm over the period).",
  mm: "mm",
  "24 h": "24 h",
  "48 h": "48 h",
  "3 dny": "3 days",
  "7 dní": "7 days",
  "Poslední 2 dny": "Past 2 days",
  "Poslední 3 dny": "Past 3 days",
  "Posledních 7 dní": "Past 7 days",
  "Posledních 30 dní": "Past 30 days",
  "Příštích 7 dní": "Next 7 days",
  "predikce · {t}": "nowcast · {t}",
  Zmenšit: "Shrink",
  "Na celou obrazovku": "Fullscreen",
  "Zmenšit radar": "Shrink radar",
  "Radar na celou obrazovku": "Radar fullscreen",
  Pozastavit: "Pause",
  Přehrát: "Play",
  "Posuvník času radaru": "Radar time slider",

  // ReloadPrompt
  "Je dostupná nová verze aplikace.": "A new version of the app is available.",
  Aktualizovat: "Update",
  Později: "Later",
  "Aktualizovat aplikaci": "Update app",

  // SearchBar
  Zavřít: "Close",
  Zpět: "Back",
  "Hledat město nebo obec…": "Search city or town…",
  "Město, obec nebo GPS…": "City, town or GPS…",
  "Hledat město": "Search city",
  "GPS souřadnice": "GPS coordinates",
  "Zobrazit počasí pro tyto souřadnice":
    "Show weather for these coordinates",
  "Vybrat na mapě": "Pick on map",
  "Vybrat toto místo": "Select this place",
  Vymazat: "Clear",
  "Hledám…": "Searching…",
  Výsledky: "Results",
  "Nic nenalezeno": "Nothing found",
  "Odebrat z oblíbených": "Remove from favorites",
  "Přidat do oblíbených": "Add to favorites",
  "Zjišťuji polohu…": "Locating…",
  "Použít moji polohu": "Use my location",
  "Aktuální místo": "Current place",
  "Oblíbená místa": "Favorite places",
  "Naposledy hledané": "Recently searched",
  "Zatím žádná. Vyhledej místo a přidej ho hvězdičkou.":
    "None yet. Search for a place and add it with the star.",
  "Odebrat {name}": "Remove {name}",

  // models
  "Automaticky (nejlepší shoda)": "Automatic (best match)",
  "ČHMÚ ALADIN (Česko, 1 km)": "ČHMÚ ALADIN (Czechia, 1 km)",
  "ICON · DWD (Německo)": "ICON · DWD (Germany)",
  "ECMWF IFS (Evropa)": "ECMWF IFS (Europe)",
  "GFS · NOAA (USA)": "GFS · NOAA (USA)",
  "Météo-France (AROME/ARPEGE)": "Météo-France (AROME/ARPEGE)",
  "UK Met Office": "UK Met Office",
  "GEM (Kanada)": "GEM (Canada)",
};

// Přeloží text podle aktuálního jazyka. Podporuje {placeholder} náhrady.
export function tr(
  key: string,
  vars?: Record<string, string | number>,
): string {
  let out = currentLang === "en" ? EN[key] ?? key : key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return out;
}

interface LangCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
}

const LanguageContext = createContext<LangCtx>({
  lang: "cs",
  setLang: () => {},
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  // null = uživatel nezvolil → řídíme se systémem.
  const [stored, setStored] = useStoredState<Lang | null>("zmoknu.lang", null);
  const lang: Lang = stored ?? detectLang();

  // Nastav modulový jazyk ještě před renderem potomků, aby ho čisté funkce
  // (format.ts apod.) při tomto renderu četly správně.
  currentLang = lang;

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((l: Lang) => setStored(l), [setStored]);
  const value = useMemo(() => ({ lang, setLang }), [lang, setLang]);

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLang(): LangCtx {
  return useContext(LanguageContext);
}
