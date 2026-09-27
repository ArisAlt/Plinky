import { useEffect, useState } from 'react';
import { isTauriEnvironment } from './tauriBridge';

// Interface size. The UI is set in 11-16px type for density; on a 4K panel
// or for tired eyes that is too small, and the terminal's own font size
// setting never reached the chrome around it. Scaling the whole webview keeps
// every ratio of the type scale intact instead of adding a second scale.

const STORAGE_KEY = 'plinky_ui_zoom';
const CHANGE_EVENT = 'plinky:ui-zoom';
export const UI_ZOOM_MIN = 0.8;
export const UI_ZOOM_MAX = 1.5;
const STEP = 0.1;

// Float steps drift (0.1 * 3 = 0.30000000000000004); keep two decimals.
const clamp = (z: number) => Math.round(Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, z)) * 100) / 100;

let current = 1;

function readStored(): number {
  try {
    const v = parseFloat(localStorage.getItem(STORAGE_KEY) ?? '');
    return Number.isFinite(v) ? clamp(v) : 1;
  } catch {
    return 1;
  }
}

async function apply(z: number) {
  if (isTauriEnvironment()) {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    await getCurrentWebview().setZoom(z);
  } else {
    // Browser dev mode has no webview handle.
    (document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom = String(z);
  }
}

export function getUiZoom(): number {
  return current;
}

export function setUiZoom(z: number) {
  current = clamp(z);
  try {
    localStorage.setItem(STORAGE_KEY, String(current));
  } catch {
    // Storage can be unavailable; the zoom still applies for this run.
  }
  apply(current).catch((e) => console.warn('UI zoom failed:', e));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: current }));
}

export const zoomIn = () => setUiZoom(current + STEP);
export const zoomOut = () => setUiZoom(current - STEP);
export const zoomReset = () => setUiZoom(1);

/** Ctrl+Shift+= / Ctrl+Shift+- / Ctrl+Shift+0. Shift keeps plain Ctrl+-
 *  and Ctrl+0 for the shell, where readline and tmux users bind them. The
 *  listener captures, so a focused terminal cannot swallow it. */
export function handleZoomKey(e: KeyboardEvent): boolean {
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return false;
  if (e.code === 'Equal' || e.code === 'NumpadAdd') zoomIn();
  else if (e.code === 'Minus' || e.code === 'NumpadSubtract') zoomOut();
  else if (e.code === 'Digit0' || e.code === 'Numpad0') zoomReset();
  else return false;
  e.preventDefault();
  e.stopPropagation();
  return true;
}

let initialised = false;

export function initUiZoom() {
  if (initialised) return;
  initialised = true;
  current = readStored();
  if (current !== 1) apply(current).catch((e) => console.warn('UI zoom failed:', e));
  window.addEventListener('keydown', handleZoomKey, true);
}

export function useUiZoom(): number {
  const [z, setZ] = useState(current);
  useEffect(() => {
    const on = (e: Event) => setZ((e as CustomEvent<number>).detail);
    window.addEventListener(CHANGE_EVENT, on);
    return () => window.removeEventListener(CHANGE_EVENT, on);
  }, []);
  return z;
}
