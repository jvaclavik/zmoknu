interface Props {
  size?: number;
  className?: string;
}

// Navigační šipka (GPS / meteoblue) – špička vpravo nahoře, zářez v ocasu.
export default function LocationArrowGlyph({ size = 18, className }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M3.5 11.5 20.5 3.5 12.5 20.5 10.5 12.5Z"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
