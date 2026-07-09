import { useEffect } from "react";

// Spolehlivé zamčení scrollu pozadí i na iOS Safari.
// Samotné `overflow: hidden` na <body> iOS ignoruje (scroll se „přelije“ na
// pozadí a rozbije sticky hlavičku), proto <body> zafixujeme přes position:fixed
// s posunem o aktuální scrollY a po odemčení pozici obnovíme.
// Počítadlo drží zámek, dokud je otevřený aspoň jeden modál (kdyby se vrstvily).

let lockCount = 0;
let savedScrollY = 0;
let saved: {
  position: string;
  top: string;
  left: string;
  right: string;
  width: string;
  overflow: string;
} | null = null;

function lockScroll() {
  lockCount += 1;
  if (lockCount > 1) return;
  savedScrollY = window.scrollY || window.pageYOffset || 0;
  const s = document.body.style;
  saved = {
    position: s.position,
    top: s.top,
    left: s.left,
    right: s.right,
    width: s.width,
    overflow: s.overflow,
  };
  s.position = "fixed";
  s.top = `-${savedScrollY}px`;
  s.left = "0";
  s.right = "0";
  s.width = "100%";
  // overflow necháváme hidden – jiná místa podle něj poznají „zamčený“ stav.
  s.overflow = "hidden";
}

function unlockScroll() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount > 0) return;
  const s = document.body.style;
  if (saved) {
    s.position = saved.position;
    s.top = saved.top;
    s.left = saved.left;
    s.right = saved.right;
    s.width = saved.width;
    s.overflow = saved.overflow;
    saved = null;
  }
  window.scrollTo(0, savedScrollY);
}

export function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    lockScroll();
    return () => unlockScroll();
  }, [active]);
}
