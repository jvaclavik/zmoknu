import type { ClothKind } from "../lib/outfit";

// Piktogramy oblečení. Používá je karta „Co si vzít na sebe", tester i meteogram
// oblečení – proto samostatný modul (a `size` pro menší varianty v grafu).
export function ClothIcon({
  kind,
  size = 40,
}: {
  kind: ClothKind;
  size?: number;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 48 48",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinejoin: "round" as const,
    strokeLinecap: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "tshirt":
      return (
        <svg {...common}>
          <path d="M18 8l-10 6 4 7 5-3v18h22V18l5 3 4-7-10-6c-2 4-18 4-20 0z" />
        </svg>
      );
    case "longsleeve":
      return (
        <svg {...common}>
          <path d="M18 8L8 13l-3 15 5 1 3-10v22h22V19l3 10 5-1-3-15-10-5c-2 4-18 4-20 0z" />
        </svg>
      );
    case "shirt":
      return (
        <svg {...common}>
          <path d="M18 8L8 13l-3 15 5 1 3-10v22h22V19l3 10 5-1-3-15-10-5" />
          <path d="M18 8l6 6 6-6" />
          <path d="M24 14v26" />
          <path d="M24 22v0.1M24 29v0.1M24 36v0.1" />
        </svg>
      );
    case "shorts":
      return (
        <svg {...common}>
          <path d="M11 11h26v6l-3 13h-8l-2-10-2 10h-8l-3-13z" />
          <path d="M24 17v4" />
        </svg>
      );
    case "pants":
      return (
        <svg {...common}>
          <path d="M16 8h16v7l-2 26h-6l-1-24-1 24h-6l-2-26z" />
          <path d="M24 15v5" />
        </svg>
      );
    case "sweater":
      return (
        <svg {...common}>
          <path d="M16 13l-8 5 4 8 4-2v16h16V24l4 2 4-8-8-5c-1 3-15 3-16 0z" />
          <path d="M19 14c-2-7 12-7 10 0" />
          <path d="M22 16v5M26 16v5" />
          <path d="M18 31h12" />
        </svg>
      );
    case "warmsweater":
      return (
        <svg {...common}>
          <path d="M17 10l-9 5 3 9 5-2v18h16V22l5 2 3-9-9-5z" />
          <path d="M17 10c1 3 13 3 14 0" />
          <path d="M19 25l5 3 5-3M19 31l5 3 5-3" />
        </svg>
      );
    case "jacket":
      return (
        <svg {...common}>
          <path d="M18 8l-10 6 4 7 5-3v18h22V18l5 3 4-7-10-6c-2 4-18 4-20 0z" />
          <path d="M24 10v32" />
        </svg>
      );
    case "coat":
      return (
        <svg {...common}>
          <path d="M19 8l-9 6 3 6 4-2v24h22V18l4 2 3-6-9-6c-1 4-17 4-18 0z" />
          <path d="M24 12v30M28 20h8M28 28h8" />
        </svg>
      );
    case "downvest":
      return (
        <svg {...common}>
          <path d="M18 9c1 3 11 3 12 0l4 4v29H14V13z" />
          <path d="M24 11v31" />
          <path d="M15 19h6M27 19h6M15 26h6M27 26h6M15 33h6M27 33h6" />
        </svg>
      );
    case "downjacket":
      return (
        <svg {...common}>
          <path d="M17 9c2 3 12 3 14 0l9 5-3 8-4-2v22H15V20l-4 2-3-8z" />
          <path d="M24 10v34" />
          <path d="M16 18h6M26 18h6M16 25h6M26 25h6M16 32h6M26 32h6" />
        </svg>
      );
    case "beanie":
      return (
        <svg {...common}>
          <path d="M9 30c0-15 30-15 30 0z" />
          <path d="M7 30h34v5H7z" />
        </svg>
      );
    case "gloves":
      return (
        <svg {...common}>
          <path d="M16 22v-4c0-2 3-2 3 0v3c0-3 3-3 3 0v1c0-2 3-2 3 0v2c0-2 3-2 3 0v8c0 6-4 9-9 9s-9-3-9-9c0-3 2-4 3-4z" />
          <path d="M16 36h12" />
        </svg>
      );
    case "scarf":
      return (
        <svg {...common}>
          <path d="M14 12c6 6 14 6 20 0l3 5c-7 6-19 6-26 0z" />
          <path d="M21 22v16h6V22" />
        </svg>
      );
    case "umbrella":
      return (
        <svg {...common}>
          <path d="M6 24c1-12 35-12 36 0z" />
          <path d="M24 24v14c0 3-4 3-5 1" />
        </svg>
      );
    case "raincoat":
      return (
        <svg {...common}>
          <path d="M18 14c0-5 12-5 12 0" />
          <path d="M18 14l-9 6 4 7 5-3v18h12V24l5 3 4-7-9-6c-2 4-10 4-12 0z" />
        </svg>
      );
    case "cap":
      return (
        <svg {...common}>
          <path d="M12 27c0-11 20-13 25-3" />
          <path d="M12 27h21" />
          <path d="M33 27c5-1 11 0 11 4H33z" />
        </svg>
      );
    case "sunglasses":
      return (
        <svg {...common}>
          <path d="M7 19h13v5c0 5-13 5-13 0zM28 19h13v5c0 5-13 5-13 0zM20 21h8" />
          <path d="M7 19l-2-4M41 19l2-4" />
        </svg>
      );
    case "sunscreen":
      return (
        <svg {...common}>
          <path d="M20 10h8v5h-8zM17 15h14v25H17z" />
          <path d="M21 22h6M21 28h6" />
        </svg>
      );
    case "boots":
      return (
        <svg {...common}>
          <path d="M18 8h7v20h6c4 0 6 3 6 7v3H18z" />
          <path d="M18 32h19" />
        </svg>
      );
    case "sandals":
      return (
        <svg {...common}>
          <path d="M12 30c0-5 4-8 12-8s12 3 12 8-5 6-12 6-12-1-12-6z" />
          <path d="M24 22l-5 8M24 22l5 8M24 22v-4" />
        </svg>
      );
    case "sneakers":
      return (
        <svg {...common}>
          <path d="M7 32l3-11 6 4 11 3c4 1 8 2 8 5v3H7z" />
          <path d="M7 36h28" />
          <path d="M16 25l3 4M21 27l3 4M26 29l3 3" />
        </svg>
      );
    case "winterboots":
      return (
        <svg {...common}>
          <path d="M17 12h8v16h6c4 0 6 3 6 7v3H17z" />
          <path d="M15 8h12v4H15z" />
          <path d="M17 34h20" />
        </svg>
      );
    case "none":
      return (
        <svg {...common}>
          <circle cx="24" cy="24" r="15" />
          <path d="M17 24l5 5 9-11" />
        </svg>
      );
  }
}
