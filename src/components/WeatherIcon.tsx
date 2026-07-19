import type { IconKind } from "../lib/weatherCodes";

interface Props {
  kind: IconKind;
  isDay?: boolean;
  size?: number;
  className?: string;
}

// Barvy jsou CSS proměnné (viz index.css), takže se v light režimu přebarví na
// kontrastnější tmavší odstíny bez nutnosti přepočtu v JS.
const SUN = "var(--wi-sun)";
const MOON = "var(--wi-moon)";
const CLOUD = "var(--wi-cloud)";
const CLOUD_DARK = "var(--wi-cloud-dark)";
const RAIN = "var(--wi-rain)";
const SNOW = "var(--wi-snow)";
const BOLT = "var(--wi-bolt)";

function Sun() {
  return (
    <g>
      {Array.from({ length: 8 }).map((_, i) => (
        <line
          key={i}
          x1="32"
          y1="6"
          x2="32"
          y2="14"
          stroke={SUN}
          strokeWidth="3"
          strokeLinecap="round"
          transform={`rotate(${i * 45} 32 32)`}
        />
      ))}
      <circle cx="32" cy="32" r="11" fill={SUN} />
    </g>
  );
}

function Moon() {
  return (
    <path
      d="M40 18a16 16 0 1 0 6 22 13 13 0 0 1-6-22z"
      fill={MOON}
    />
  );
}

function Cloud({ x = 0, y = 0, color = CLOUD }: { x?: number; y?: number; color?: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path
        d="M20 44a11 11 0 0 1 1-22 14 14 0 0 1 26 4 9 9 0 0 1-2 18H20z"
        fill={color}
      />
    </g>
  );
}

function Drops({ color = RAIN }: { color?: string }) {
  return (
    <g>
      {[22, 32, 42].map((x, i) => (
        <line
          key={x}
          x1={x}
          y1={48 + (i === 1 ? 2 : 0)}
          x2={x - 3}
          y2={58 + (i === 1 ? 2 : 0)}
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
        />
      ))}
    </g>
  );
}

function Flakes() {
  return (
    <g fill={SNOW}>
      {[22, 32, 42].map((x, i) => (
        <circle key={x} cx={x} cy={52 + (i === 1 ? 3 : 0)} r="2.4" />
      ))}
    </g>
  );
}

export default function WeatherIcon({ kind, isDay = true, size = 64, className }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      role="img"
      aria-hidden="true"
    >
      {kind === "clear" && (isDay ? <Sun /> : <Moon />)}

      {kind === "partly" && (
        <g>
          <g transform="translate(-6 -8) scale(0.8)">
            {isDay ? <Sun /> : <Moon />}
          </g>
          <Cloud x={6} y={8} />
        </g>
      )}

      {kind === "cloudy" && (
        <g>
          <Cloud x={-4} y={-2} color={CLOUD_DARK} />
          <Cloud x={6} y={6} />
        </g>
      )}

      {kind === "overcast" && (
        <g>
          <Cloud x={-6} y={-4} color={CLOUD_DARK} />
          <Cloud x={6} y={4} color={CLOUD} />
        </g>
      )}

      {kind === "fog" && (
        <g>
          <Cloud x={0} y={-6} />
          {[44, 50, 56].map((y) => (
            <line
              key={y}
              x1="14"
              y1={y}
              x2="50"
              y2={y}
              stroke={CLOUD_DARK}
              strokeWidth="3"
              strokeLinecap="round"
            />
          ))}
        </g>
      )}

      {kind === "drizzle" && (
        <g>
          <Cloud x={0} y={-6} />
          <Drops />
        </g>
      )}

      {kind === "rain" && (
        <g>
          <Cloud x={0} y={-6} color={CLOUD_DARK} />
          <Drops />
        </g>
      )}

      {kind === "sleet" && (
        <g>
          <Cloud x={0} y={-6} color={CLOUD_DARK} />
          <Drops />
          <Flakes />
        </g>
      )}

      {kind === "snow" && (
        <g>
          <Cloud x={0} y={-6} />
          <Flakes />
        </g>
      )}

      {kind === "thunder" && (
        <g>
          <Cloud x={0} y={-8} color={CLOUD_DARK} />
          <path d="M34 44l-8 12h6l-3 9 11-15h-7l4-6z" fill={BOLT} />
        </g>
      )}
    </svg>
  );
}
