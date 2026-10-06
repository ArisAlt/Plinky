// How many lines a terminal keeps above the screen (Settings > Terminal).
//
// Plinky set none, so xterm's 1,000 always applied: "Copy All to
// Clipboard" of a long show tech-support came out cut off at the top, with
// no way to keep more. 1,000 stays the default (owner's choice); each line
// kept costs memory in every open tab. PuTTY keeps 2,000.
import { useEffect, useState } from 'react';

export const SCROLLBACK_CHOICES = [1000, 2000, 5000, 10000, 20000, 50000, 100000] as const;
export const DEFAULT_SCROLLBACK = 1000;

const KEY = 'plinky_scrollback';
const EVENT = 'plinky:scrollback';

const isChoice = (n: number) => (SCROLLBACK_CHOICES as readonly number[]).includes(n);

export function getScrollback(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return isChoice(n) ? n : DEFAULT_SCROLLBACK;
  } catch {
    return DEFAULT_SCROLLBACK;
  }
}

export function setScrollback(lines: number) {
  const n = isChoice(lines) ? lines : DEFAULT_SCROLLBACK;
  try { localStorage.setItem(KEY, String(n)); } catch { /* not remembered */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: n }));
}

/** The chosen length; every terminal follows a change at once. */
export function useScrollback(): number {
  const [lines, setLines] = useState(getScrollback);
  useEffect(() => {
    const on = (e: Event) => setLines((e as CustomEvent<number>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return lines;
}
