import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Props {
  label: string;
  children: ReactNode;
  wide?: boolean;
}

export default function InfoHint({ label, children, wide }: Props) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const b = btnRef.current?.getBoundingClientRect();
      if (!b) return;
      const tw = tipRef.current?.offsetWidth ?? (wide ? 300 : 240);
      const th = tipRef.current?.offsetHeight ?? 60;
      const m = 8;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = b.right - tw;
      left = Math.min(Math.max(m, left), vw - tw - m);
      const above = b.top - th - m >= m;
      const top = above
        ? b.top - th - m
        : Math.min(b.bottom + m, vh - th - m);
      setPos({ top, left });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, wide]);

  return (
    <span
      className="mg-info"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span
        ref={btnRef}
        className="mg-info-btn"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-label={label}
      >
        ?
      </span>
      {open &&
        createPortal(
          <div
            ref={tipRef}
            className={`mg-info-pop${wide ? " mg-info-pop-wide" : ""}`}
            role="tooltip"
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            style={{
              position: "fixed",
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              opacity: pos ? 1 : 0,
              visibility: "visible",
              pointerEvents: wide ? "auto" : "none",
            }}
          >
            {children}
          </div>,
          document.body,
        )}
    </span>
  );
}
