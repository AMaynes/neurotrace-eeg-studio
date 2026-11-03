"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";

/** Keep pointer updates local to the title, outside the recording workspace. */
export function SessionTabTitle({ title }: { title: string }) {
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const visible = pointer !== null;

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!pointer || !tooltip) return;
    const { width, height } = tooltip.getBoundingClientRect();
    const left = Math.max(8, Math.min(pointer.x + 12, window.innerWidth - width - 8));
    const top = pointer.y + 16 + height <= window.innerHeight - 8
      ? pointer.y + 16 : Math.max(8, pointer.y - height - 12);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }, [pointer, title]);

  useEffect(() => {
    if (!visible) return;
    const dismiss = () => setPointer(null);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [visible]);

  const followPointer = (event: PointerEvent<HTMLSpanElement>) => {
    if (event.pointerType !== "touch") setPointer({ x: event.clientX, y: event.clientY });
  };

  return <>
    <span
      className="session-tab-title"
      // Suppress the parent button's native tooltip while showing the full name.
      title=""
      aria-describedby={visible ? tooltipId : undefined}
      onPointerEnter={followPointer}
      onPointerMove={followPointer}
      onPointerLeave={() => setPointer(null)}
      onPointerDown={() => setPointer(null)}
    >{title}</span>
    {pointer && createPortal(<div
      ref={tooltipRef}
      id={tooltipId}
      role="tooltip"
      className="session-title-tooltip"
      style={{ left: pointer.x + 12, top: pointer.y + 16 }}
    >{title}</div>, document.body)}
  </>;
}
