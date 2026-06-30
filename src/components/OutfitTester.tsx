import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { DailyPoint } from "../types";
import { describeWeather } from "../lib/weatherCodes";
import { tr } from "../lib/i18n";
import { TIER_COLOR, TIER_LABEL } from "../lib/tiers";
import {
  ACTIVITY_OFFSET,
  ActivityPicker,
  buildOutfit,
  ClothIcon,
  type Activity,
  type ClothKind,
  type OutfitFlags,
} from "./WhatToWear";

export interface OutfitTesterValues {
  feelsMax: number;
  feelsMin: number;
  precip: number;
  rainProb: number;
  wind: number;
  uv: number;
  code: number;
  activity: Activity;
}

interface Props {
  onClose: () => void;
  initial?: Partial<OutfitTesterValues>;
}

const CONDITIONS: { code: number; label: string }[] = [
  { code: 0, label: "Jasno" },
  { code: 3, label: "Zataženo" },
  { code: 45, label: "Mlha" },
  { code: 53, label: "Mrholení" },
  { code: 63, label: "Déšť" },
  { code: 65, label: "Vydatný déšť" },
  { code: 73, label: "Sněžení" },
  { code: 95, label: "Bouřka" },
];

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="dbg-slider">
      <span className="dbg-slider-head">
        <span>{tr(label)}</span>
        <strong>
          {value}
          {unit}
        </strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export default function OutfitTester({ onClose, initial }: Props) {
  const [feelsMax, setFeelsMax] = useState(initial?.feelsMax ?? 18);
  const [feelsMin, setFeelsMin] = useState(initial?.feelsMin ?? 9);
  const [precip, setPrecip] = useState(initial?.precip ?? 0);
  const [rainProb, setRainProb] = useState(initial?.rainProb ?? 20);
  const [wind, setWind] = useState(initial?.wind ?? 4);
  const [uv, setUv] = useState(initial?.uv ?? 4);
  const [code, setCode] = useState(initial?.code ?? 0);
  const [activity, setActivity] = useState<Activity>(
    initial?.activity ?? "walk",
  );

  useEffect(() => {
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const outfit = useMemo(() => {
    const day: DailyPoint = {
      time: new Date().toISOString().slice(0, 10),
      weatherCode: code,
      tempMax: feelsMax,
      tempMin: feelsMin,
      precipitationSum: precip,
      precipitationProbabilityMax: rainProb,
      windSpeedMax: wind,
      windGustsMax: wind * 1.5,
      sunrise: "",
      sunset: "",
      uvIndexMax: uv,
    };
    return buildOutfit(day, feelsMax, feelsMin, precip, rainProb, activity);
  }, [feelsMax, feelsMin, precip, rainProb, wind, uv, code, activity]);

  // Kusy, které aktuálně z pravidel „vypadly“ – zvýrazníme je v přehledu.
  const activeKinds = useMemo(
    () => new Set(outfit.items.map((i) => i.kind)),
    [outfit],
  );

  // Prahy základní vrstvy se posouvají podle aktivity (pohyb hřeje), proto je
  // popisy počítáme dynamicky z aktuálního posunu.
  const ruleGroups = useMemo(
    () => buildRuleGroups(ACTIVITY_OFFSET[activity]),
    [activity],
  );

  return createPortal(
    <div
      className="dbg-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Jak počítám doporučení oblečení"
    >
      <div className="dbg-backdrop" onClick={onClose} />
      <div className="dbg-sheet">
        <div className="dbg-head">
          <h2>{tr("Jak to počítám")}</h2>
          <button className="dbg-close" onClick={onClose} aria-label={tr("Zavřít")}>
            <CloseX />
          </button>
        </div>

        <div className="dbg-body">
          <div className="dbg-controls">
            <div className="dbg-activity">
              <span className="dbg-slider-head">
                <span>{tr("Aktivita")}</span>
              </span>
              <ActivityPicker value={activity} onChange={setActivity} />
              <p className="dbg-activity-note">
                {tr(
                  "Aktivita posouvá pocitovou teplotu: pohyb hřeje, klid ochlazuje.",
                )}
              </p>
            </div>
            <Slider
              label="Pocitová teplota (max)"
              value={feelsMax}
              min={-20}
              max={40}
              unit="°"
              onChange={setFeelsMax}
            />
            <Slider
              label="Pocitová teplota (min)"
              value={feelsMin}
              min={-25}
              max={35}
              unit="°"
              onChange={setFeelsMin}
            />
            <Slider
              label="Srážky za den"
              value={precip}
              min={0}
              max={30}
              step={0.5}
              unit=" mm"
              onChange={setPrecip}
            />
            <Slider
              label="Pravděpodobnost srážek"
              value={rainProb}
              min={0}
              max={100}
              step={5}
              unit=" %"
              onChange={setRainProb}
            />
            <Slider
              label="Vítr (max)"
              value={wind}
              min={0}
              max={30}
              unit=" m/s"
              onChange={setWind}
            />
            <Slider
              label="UV index"
              value={uv}
              min={0}
              max={11}
              unit=""
              onChange={setUv}
            />
            <label className="dbg-slider">
              <span className="dbg-slider-head">
                <span>{tr("Podmínky")}</span>
              </span>
              <select
                className="dbg-select"
                value={code}
                onChange={(e) => setCode(Number(e.target.value))}
              >
                {CONDITIONS.map((c) => (
                  <option key={c.code} value={c.code}>
                    {tr(c.label)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="dbg-preview">
            <div className="dbg-preview-head">
              <span
                className="dbg-tone"
                style={{ background: TIER_COLOR[outfit.accent] }}
              >
                {tr(TIER_LABEL[outfit.accent])}
              </span>
              <span className="dbg-cond">{tr(describeWeather(code).label)}</span>
            </div>
            <p className="dbg-summary">{tr(outfit.summary)}</p>
            <div className="dbg-grid">
              {outfit.items.map((it) => (
                <div className="dbg-item" key={it.kind + it.label}>
                  <ClothIcon kind={it.kind} />
                  <span className="dbg-item-label">{tr(it.label)}</span>
                  {it.note && (
                    <span className="dbg-item-note">{tr(it.note)}</span>
                  )}
                </div>
              ))}
            </div>

            <div className="dbg-flags">
              <span className="dbg-flags-title">{tr("Vyhodnocené podmínky")}</span>
              <div className="dbg-flags-list">
                {FLAG_DEFS.map((f) => (
                  <span
                    key={f.key}
                    className={`dbg-flag ${outfit.flags[f.key] ? "on" : ""}`}
                    title={tr(f.hint)}
                  >
                    {tr(f.label)}
                  </span>
                ))}
              </div>
              <p className="dbg-flags-note">
                {tr(
                  "Oblečení se skládá podle pocitové teploty, na kterou pak navazují srážky, vítr, sníh a UV. Aktivní podmínky (zeleně) přidávají další kusy.",
                )}
              </p>
            </div>
          </div>

          <div className="dbg-rules">
            {ruleGroups.map((g) => (
              <div className="dbg-rulegroup" key={g.title}>
                <span className="dbg-flags-title">{tr(g.title)}</span>
                <ul className="dbg-rulelist">
                  {g.rules.map((r) => (
                    <li
                      key={r.kind + r.label}
                      className={`dbg-rule ${
                        activeKinds.has(r.kind) ? "on" : ""
                      }`}
                    >
                      <span className="dbg-rule-ico">
                        <ClothIcon kind={r.kind} />
                      </span>
                      <span className="dbg-rule-name">{tr(r.label)}</span>
                      <span className="dbg-rule-cond">{r.rule}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <p className="dbg-flags-note">
              {tr(
                "Zeleně zvýrazněné kusy plynou z právě nastavených hodnot. Prahy jsou vztažené k pocitové teplotě (max/min), ne k reálné.",
              )}
            </p>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface RuleGroup {
  title: string;
  rules: { kind: ClothKind; label: string; rule: string }[];
}

// Prahy základní vrstvy se počítají z pocitové teploty upravené o aktivitu
// (pohyb hřeje → prahy klesají, klid → rostou). Ostatní pravidla (srážky, vítr,
// UV) na aktivitě nezávisí.
function buildRuleGroups(offset: number): RuleGroup[] {
  const adj = (t: number) => Math.round(t - offset);
  return [
    {
      title: "Základní vrstva podle pocitové teploty (max)",
      rules: [
        {
          kind: "shorts",
          label: "Kraťasy",
          rule: tr("teplo a víc – max ≥ {t} °C", { t: adj(22) }),
        },
        {
          kind: "pants",
          label: "Dlouhé kalhoty",
          rule: tr("akorát a chladněji – max < {t} °C", { t: adj(22) }),
        },
        { kind: "tshirt", label: "Triko", rule: tr("max ≥ {t} °C", { t: adj(19) }) },
        {
          kind: "longsleeve",
          label: "Triko (dlouhý rukáv)",
          rule: tr("{a}–{b} °C – přechodná vrstva", { a: adj(12), b: adj(18) }),
        },
        {
          kind: "sweater",
          label: "Mikina",
          rule: tr("chladno ({a}–{b} °C) nebo chladnější ráno/večer", {
            a: adj(9),
            b: adj(15),
          }),
        },
        {
          kind: "warmsweater",
          label: "Teplý svetr",
          rule: tr("zima a níž – max < {t} °C", { t: adj(9) }),
        },
        {
          kind: "beanie",
          label: "Čepice",
          rule: tr("max < {t} °C nebo sníh", { t: adj(9) }),
        },
        {
          kind: "scarf",
          label: "Šála",
          rule: tr("mráz – max < {t} °C", { t: adj(2) }),
        },
        {
          kind: "gloves",
          label: "Rukavice",
          rule: tr("mráz – max < {t} °C", { t: adj(2) }),
        },
      ],
    },
    {
      title: "Peřové vrstvy podle aktivity",
      rules: [
        {
          kind: "downvest",
          label: "Peřová vesta",
          rule: tr("chladno a pohyb – zahřeje jádro, ruce nechá dýchat"),
        },
        {
          kind: "downjacket",
          label: "Peřová bunda",
          rule: tr("zima nebo klid (sezení) – plné zateplení s rukávy"),
        },
      ],
    },
    {
      title: "Doplňky podle podmínek",
      rules: [
        {
          kind: "umbrella",
          label: "Deštník",
          rule: tr("déšť přes den – úhrn ≥ 1,5 mm, nebo ≥ 55 % a ≥ 0,5 mm"),
        },
        {
          kind: "raincoat",
          label: "Nepromokavá bunda",
          rule: tr("déšť spolu s větrem nebo zimou"),
        },
        { kind: "jacket", label: "Větrovka", rule: tr("vítr ≥ 9 m/s") },
        {
          kind: "boots",
          label: "Pevné boty",
          rule: tr("sníh (sněžení, nebo max ≤ 1 °C se srážkami)"),
        },
        { kind: "cap", label: "Kšiltovka", rule: tr("UV ≥ 6 a neprší") },
        { kind: "sunglasses", label: "Sluneční brýle", rule: tr("UV ≥ 6 a neprší") },
        { kind: "sunscreen", label: "Opalovací krém", rule: tr("UV ≥ 6 a neprší") },
      ],
    },
  ];
}

const FLAG_DEFS: {
  key: keyof OutfitFlags;
  label: string;
  hint: string;
}[] = [
  { key: "rainLikely", label: "Déšť pravděpodobný", hint: "→ deštník / pláštěnka" },
  { key: "extremeRain", label: "Vydatný déšť", hint: "→ určitě deštník + pláštěnka" },
  { key: "snowLikely", label: "Sníh", hint: "→ pevné boty a čepice" },
  { key: "windy", label: "Vítr", hint: "→ větrovka / pláštěnka s kapucí" },
  { key: "cold", label: "Chladno", hint: "denní maximum pod 9 °C" },
  { key: "sunny", label: "Slunečno", hint: "→ kšiltovka, brýle, krém" },
];

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
