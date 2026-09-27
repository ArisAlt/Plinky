import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

// One tooltip for the whole app, fed by the `title` attributes already on
// ~90 controls. Native title tooltips are drawn by the desktop toolkit: in
// a design review's run they came up in the light system style, ran off the
// window's right edge, and sat over the launcher's search box and the tab
// menu while those were in use. This one follows the interface theme, stays
// inside the window, and gets out of the way on the first click or key.

const DELAY_MS = 450;
/** Moving from one tooltip to the next shows it at once (a toolbar reads
 *  as one strip, not five separate waits). */
const WARM_MS = 400;
const GAP = 6;
const EDGE = 8;

interface Tip { text: string; anchor: DOMRect }

/** Moves an element's title into data-tip, so the native tooltip never
 *  shows. An element named only by its title keeps that name. */
export function adoptTitle(el: HTMLElement): string | null {
  const title = el.getAttribute('title');
  if (title !== null) {
    el.removeAttribute('title');
    if (title.trim()) el.setAttribute('data-tip', title);
    const named = el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby');
    if (title.trim() && !named) {
      if ((el.textContent ?? '').trim()) el.setAttribute('aria-description', title);
      else el.setAttribute('aria-label', title);
    }
  }
  return el.getAttribute('data-tip');
}

/** Where the tooltip goes: under the anchor, above it when there's no room
 *  below, and always inside the window. */
export function placeTip(anchor: DOMRect, w: number, h: number, vw: number, vh: number) {
  let top = anchor.bottom + GAP;
  if (top + h > vh - EDGE && anchor.top - GAP - h >= EDGE) top = anchor.top - GAP - h;
  top = Math.max(EDGE, Math.min(top, vh - h - EDGE));
  const left = Math.max(EDGE, Math.min(anchor.left + anchor.width / 2 - w / 2, vw - w - EDGE));
  return { top, left };
}

export const TooltipHost: React.FC = () => {
  const [tip, setTip] = useState<Tip | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = useRef<HTMLElement | null>(null);
  const lastHidden = useRef(0);
  const visible = useRef(false);

  useEffect(() => {
    const hide = () => {
      clearTimeout(timer.current);
      current.current = null;
      if (visible.current) lastHidden.current = Date.now();
      visible.current = false;
      setTip(null);
    };
    const show = (el: HTMLElement) => {
      const text = adoptTitle(el);
      if (!text) return;
      clearTimeout(timer.current);
      current.current = el;
      const warm = visible.current || Date.now() - lastHidden.current < WARM_MS;
      const open = () => {
        if (current.current !== el || !el.isConnected) return;
        visible.current = true;
        setPos(null);
        setTip({ text, anchor: el.getBoundingClientRect() });
      };
      if (warm) open();
      else timer.current = setTimeout(open, DELAY_MS);
    };
    const tipOf = (t: EventTarget | null) =>
      t instanceof Element ? t.closest<HTMLElement>('[title], [data-tip]') : null;

    const onOver = (e: PointerEvent) => {
      const el = tipOf(e.target);
      if (el === current.current) return;
      if (el) show(el);
      else hide();
    };
    const onOut = (e: PointerEvent) => {
      if (current.current && !current.current.contains(e.relatedTarget as Node | null)) hide();
    };
    const onFocus = (e: FocusEvent) => {
      const el = tipOf(e.target);
      // Keyboard focus only; a click's focus would re-show what it just hid.
      let keyboard = false;
      try { keyboard = !!el?.matches(':focus-visible'); } catch { /* older engines */ }
      if (el && keyboard) show(el);
    };
    // Title attributes also appear on elements while they're hidden or
    // re-rendered; adopt them as the pointer passes, but never wait on it.
    document.addEventListener('pointerover', onOver, true);
    document.addEventListener('pointerout', onOut, true);
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('focusout', hide, true);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', hide, true);
    document.addEventListener('wheel', hide, { capture: true, passive: true });
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      clearTimeout(timer.current);
      document.removeEventListener('pointerover', onOver, true);
      document.removeEventListener('pointerout', onOut, true);
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('focusout', hide, true);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', hide, true);
      document.removeEventListener('wheel', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  // Measured before paint, then placed: no frame at the wrong spot.
  useLayoutEffect(() => {
    if (!tip || !boxRef.current) return;
    const { width, height } = boxRef.current.getBoundingClientRect();
    setPos(placeTip(tip.anchor, width, height, window.innerWidth, window.innerHeight));
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={boxRef}
      role="tooltip"
      className="fixed z-[70] pointer-events-none max-w-[280px] px-2 py-1 rounded border border-plinky-700 bg-plinky-800 text-slate-100 text-meta shadow-lg whitespace-pre-line break-words"
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {tip.text}
    </div>
  );
};
