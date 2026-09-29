// Keeping a menu opened at the pointer inside the window.
import { useLayoutEffect } from 'react';

type Size = { width: number; height: number };

/** Where a menu opened at (x, y) fits inside the view: moved up and left
 *  just enough, never past `margin` from the top-left. */
export function fitMenu(x: number, y: number, size: Size, view: Size, margin = 8): { x: number; y: number } {
  return {
    x: Math.max(margin, Math.min(x, view.width - size.width - margin)),
    y: Math.max(margin, Math.min(y, view.height - size.height - margin)),
  };
}

/** Moves `menu` inside the window once it is drawn and its real size is
 *  known. The session list guessed a size instead (150 px tall), and its
 *  menu -- about 260 px, more with "Move to Folder" open -- ran off the
 *  bottom of the window for sessions low in a full tree (owner report).
 *  `extraDeps`: anything that changes the menu's size while it is open. */
export function useFittedMenu<M extends { x: number; y: number }>(
  ref: { current: HTMLElement | null },
  menu: M | null,
  setMenu: (menu: M) => void,
  extraDeps: unknown[] = [],
) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!menu || !el) return;
    // The layout size, not getBoundingClientRect: the menu opens with a
    // zoom-in (scale 0.95), and measured mid-animation it came out 5 %
    // short, so its last item ended up at the window's very edge.
    const fitted = fitMenu(menu.x, menu.y, { width: el.offsetWidth, height: el.offsetHeight }, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    if (fitted.x !== menu.x || fitted.y !== menu.y) setMenu({ ...menu, ...fitted });
    // Re-fit when the menu moves, or when something changes its size.
  }, [menu, ...extraDeps]);
}
