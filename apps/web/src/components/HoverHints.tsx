import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

function hintFor(element: HTMLElement) {
  const explicit = element.dataset.tip || element.getAttribute("title");
  if (explicit) return explicit;
  // Visible labels already explain ordinary controls. Only icon-only controls need a label tooltip.
  const visible = (element.textContent || "").trim();
  const label = element.getAttribute("aria-label");
  return label && (!visible || /^[×✕⋯•]+$/.test(visible)) ? label : null;
}

/** Explicit explanations and accessible labels for icon-only controls. */
export function HoverHints() {
  const id = useId();
  const [hint, setHint] = useState<{ element: HTMLElement; text: string } | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const bubble = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active: HTMLElement | null = null;
    let originalTitle: string | null = null;
    let originalDescription: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const selector = 'button, a, summary, [role="button"], [role="tab"], input[type="submit"], input[type="button"], [data-tip]';
    function hide() {
      clearTimeout(timer);
      if (active) {
        if (originalTitle !== null) active.setAttribute("title", originalTitle);
        if (originalDescription === null) active.removeAttribute("aria-describedby");
        else active.setAttribute("aria-describedby", originalDescription);
      }
      active = null;
      setHint(null);
    }
    function show(event: Event) {
      if (event instanceof PointerEvent && event.pointerType === "touch") return;
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null;
      if (!element || element === active) return;
      hide();
      const text = hintFor(element);
      if (!text) return;
      active = element;
      originalTitle = element.getAttribute("title");
      originalDescription = element.getAttribute("aria-describedby");
      // Avoid a second, native tooltip on top of the styled hint.
      element.removeAttribute("title");
      timer = setTimeout(() => {
        if (!element.isConnected) return hide();
        element.setAttribute("aria-describedby", [originalDescription, id].filter(Boolean).join(" "));
        setHint({ element, text });
      }, event.type === "focusin" ? 0 : 550);
    }
    function leave(event: Event) {
      const related = (event as MouseEvent).relatedTarget;
      if (!(related instanceof Node) || !active?.contains(related)) hide();
    }
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") hide();
    }
    function reposition() {
      if (active && !active.isConnected) return hide();
      setHint((current) => current ? { ...current } : null);
    }
    document.addEventListener("pointerover", show, true);
    document.addEventListener("pointerout", leave, true);
    document.addEventListener("focusin", show, true);
    document.addEventListener("focusout", leave, true);
    document.addEventListener("click", hide, true);
    document.addEventListener("keydown", keydown);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      hide();
      document.removeEventListener("pointerover", show, true);
      document.removeEventListener("pointerout", leave, true);
      document.removeEventListener("focusin", show, true);
      document.removeEventListener("focusout", leave, true);
      document.removeEventListener("click", hide, true);
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [id]);

  useLayoutEffect(() => {
    if (!hint || !bubble.current) return;
    const anchor = hint.element.getBoundingClientRect();
    const bounds = bubble.current.getBoundingClientRect();
    const above = anchor.top - bounds.height - 8;
    setPosition({
      left: Math.max(8, Math.min(anchor.left + (anchor.width - bounds.width) / 2, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(above >= 8 ? above : anchor.bottom + 8, window.innerHeight - bounds.height - 8)),
    });
  }, [hint]);

  return hint ? createPortal(
    <div ref={bubble} id={id} role="tooltip" className="hover-hint" style={position}>{hint.text}</div>,
    document.body,
  ) : null;
}
