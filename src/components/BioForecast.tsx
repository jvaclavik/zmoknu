import { useState } from "react";
import type { HourlyPoint } from "../types";
import type { AirQuality } from "../lib/airQuality";
import { bioForecastForDate, type BioLoad } from "../lib/bio";
import { tr } from "../lib/i18n";
import InfoHint from "./InfoHint";

interface Props {
  hourly: HourlyPoint[];
  date: string;
  air?: AirQuality | null;
  lat?: number;
  lon?: number;
}

export default function BioForecast({ hourly, date, air, lat, lon }: Props) {
  const [open, setOpen] = useState(false);
  const bio = bioForecastForDate(hourly, date, air, lat, lon);

  return (
    <section className={`card bio-card bio-${bio.load}`}>
      <div className="bio-head">
        <button
          type="button"
          className={`bio-head-btn ${open ? "open" : ""}`}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span className="bio-head-ico" aria-hidden="true">
            <BioGlyph />
          </span>
          <span className="bio-head-text">
            <span className="bio-head-title">{tr("Biopředpověď")}</span>
            <span className="bio-head-sub">{tr(bio.label)}</span>
          </span>
          {!open && (
            <span className="bio-peek-ring" aria-hidden="true">
              {bio.points}
            </span>
          )}
          <Chevron open={open} />
        </button>
        <span className="bio-title-hint">
          <InfoHint label={tr("Co je biopředpověď")} wide>
            <p>
              {tr(
                "Počítáme index biotropie podle modelu ČHMÚ BMP IIIc – součet bodů za meteorologické jevy (teplota, tlak, vítr, vlhkost…).",
              )}
            </p>
            {bio.region != null && (
              <p>
                {tr("Pro vaši polohu zhruba oblast {n} z 7 regionů ČHMÚ.", {
                  n: bio.region,
                })}
              </p>
            )}
            <p>
              {tr(
                "Nejde o oficiální produkt ČHMÚ – oficiální předpověď zohledňuje i synoptickou situaci a regionální posouzení meteorologů.",
              )}
            </p>
            <p className="bio-info-link">
              <a
                href="https://www.chmi.cz/predpoved-pocasi/bio-predpoved/vice-informaci-o-biopredpovedi-a-modelu"
                target="_blank"
                rel="noopener noreferrer"
              >
                {tr("Model BMP IIIc na chmi.cz")}
              </a>
            </p>
          </InfoHint>
        </span>
      </div>

      {open && (
        <div className="bio-body">
          <div className="bio-hero">
            <div className="bio-hero-score">
              <div className="bio-score-ring">
                <strong>{bio.points}</strong>
              </div>
              <span className="bio-score-unit">{tr("bodů")}</span>
              <span className={`bio-load-pill lvl-${bio.tier}`}>
                {tr(bio.label)}
              </span>
            </div>
            <div className="bio-hero-side">
              <p className="bio-summary">
                {tr(
                  "Shrnuje, jak náročné bude počasí pro tělo – teplo, chlad, výkyvy tlaku a další faktory. Hodí se pro plánování venku, sportu nebo pokud jste na počasí citlivější.",
                )}
              </p>
              <div className="bio-thermal-row">
                <span className="bio-thermal-label">
                  {tr("Tepelná zátěž")}
                  {bio.thermal.kind !== "none" && (
                    <InfoHint label={tr(bio.thermal.label)}>
                      {tr(bio.thermal.note)}
                    </InfoHint>
                  )}
                </span>
                <span className={`lvl-pill lvl-${bio.thermal.tier}`}>
                  {tr(bio.thermal.label)}
                </span>
              </div>
            </div>
          </div>

          <BioScale points={bio.points} load={bio.load} />

          {bio.factors.length > 0 ? (
            <ul className="bio-factors">
              {bio.factors.map((f) => (
                <li key={f.id}>
                  <span className="bio-factor-pts">+{f.points}</span>
                  <span className="bio-factor-grp">{f.group}</span>
                  <span className="bio-factor-text">{tr(f.label)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="bio-empty">
              {tr("Bez splněných kritérií modelu BMP IIIc.")}
            </p>
          )}

          {bio.pollenNote && (
            <div className="bio-extra">
              <span className={`lvl-pill lvl-${bio.pollenNote.tier}`}>
                {tr("Pyl")}: {tr(bio.pollenNote.label)} ·{" "}
                {tr(bio.pollenNote.level)}
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function BioScale({ points, load }: { points: number; load: BioLoad }) {
  const pct = Math.min(100, (points / 8) * 100);
  return (
    <div className="bio-scale" aria-hidden="true">
      <div className="bio-scale-track">
        <span className="bio-scale-seg bio-scale-mild" />
        <span className="bio-scale-seg bio-scale-mod" />
        <span className="bio-scale-seg bio-scale-high" />
        <span
          className={`bio-scale-marker bio-${load}`}
          style={{ left: `${pct}%` }}
        />
      </div>
      <div className="bio-scale-labels">
        <span>0–2</span>
        <span>3–5</span>
        <span>6+</span>
      </div>
    </div>
  );
}

function BioGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 13.5 8 9.5l3.5 5.5L15 8l5 5.5"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 19h16"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinecap="round"
        opacity="0.45"
      />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={`bio-chev${open ? " open" : ""}`}
    >
      <path
        d="M6 9l6 6 6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
