import { useEffect, useState } from 'react';

// Interface themes. Every colour class in the UI (plinky-*, slate-*, sky-*,
// emerald-*, amber-*, rose-*, cyan-*, white) reads a CSS variable, set here,
// so a theme swaps the variables and every existing class follows it.
//
// "Thyrion" is the look the app always had: Tailwind's own slate/sky/emerald/
// amber/rose/cyan values, byte for byte. The others are palettes (ABtools'
// AbtoolsGui.py keys), expanded into full shade scales by mixing each colour
// toward the theme's text or background.
//
// Five, chosen by the owner from fifteen (2026-10): seven dark palettes were
// near-copies of one another, dark blue-grey with another accent.

export type Shade = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950;
export const SHADES: Shade[] = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
export const SCALES = ['slate', 'sky', 'emerald', 'amber', 'rose', 'cyan'] as const;
export const PLINKY_SHADES = ['950', '900', '850', '800', '700', '600', '500', '400', '300', '200', '100', '50', 'muted'] as const;
export const SINGLES = ['white', 'on-accent', 'on-danger', 'on-warn'] as const;
/** Broadcast channels A-D. Their own hues: B, C and D were emerald, amber
 *  and rose, the colours that also meant connected, warning and failed. */
export const CHANNELS = ['ch-a', 'ch-b', 'ch-c', 'ch-d'] as const;

type Scale = Record<Shade, string>;

/** The keys ABtools' themes use. */
export interface Palette {
  bg: string; surface: string; field: string; border: string;
  fg: string; muted: string;
  accent: string; accent_hover: string; accent_active: string;
  neutral: string; neutral_hover: string;
  danger: string; danger_hover: string; disabled: string;
  log_green: string; log_red: string; log_yellow: string;
  log_blue: string; log_cyan: string; log_magenta: string;
}

export interface UiTheme {
  id: string;
  name: string;
  light: boolean;
  /** Four colours for the picker's swatch: background, surface, accent, text. */
  swatch: [string, string, string, string];
  vars: Record<string, string>; // --c-* -> "r g b"
  /** The source palette, for the "Match interface" terminal scheme. */
  palette?: Palette;
}

// ── colour maths ─────────────────────────────────────────────────────────────
const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
const hex = (c: number[]) => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
/** `a` moved `t` of the way toward `b`. */
export const mix = (a: string, b: string, t: number) => {
  const x = rgb(a), y = rgb(b);
  return hex(x.map((v, i) => v + (y[i] - v) * t));
};
const lin = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
export const luminance = (c: string) => { const [r, g, b] = rgb(c); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
export const contrast = (a: string, b: string) => {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** White or near-black, whichever reads better on `bg` (ABtools' _readable_on). */
export const readableOn = (bg: string) => (contrast('#ffffff', bg) >= contrast('#101216', bg) ? '#ffffff' : '#101216');
const triplet = (c: string) => rgb(c).join(' ');

/** `c`, pushed toward `toward` in small steps until it reaches `min`:1
 *  against `against`. Palettes are designed by eye; a few of their colours
 *  land a hair under AA as text (Gruvbox's red on its surface, 4.29). */
export function ensure(c: string, against: string, min: number, toward: string): string {
  let out = c;
  for (let t = 0.05; contrast(out, against) < min && t <= 1; t += 0.05) out = mix(c, toward, t);
  return out;
}


// ── the current look, exactly ────────────────────────────────────────────────
const TW: Record<(typeof SCALES)[number], Scale> = {
  slate: { 50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1', 400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155', 800: '#1e293b', 900: '#0f172a', 950: '#020617' },
  sky: { 50: '#f0f9ff', 100: '#e0f2fe', 200: '#bae6fd', 300: '#7dd3fc', 400: '#38bdf8', 500: '#0ea5e9', 600: '#0284c7', 700: '#0369a1', 800: '#075985', 900: '#0c4a6e', 950: '#082f49' },
  emerald: { 50: '#ecfdf5', 100: '#d1fae5', 200: '#a7f3d0', 300: '#6ee7b7', 400: '#34d399', 500: '#10b981', 600: '#059669', 700: '#047857', 800: '#065f46', 900: '#064e3b', 950: '#022c22' },
  amber: { 50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d', 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706', 700: '#b45309', 800: '#92400e', 900: '#78350f', 950: '#451a03' },
  rose: { 50: '#fff1f2', 100: '#ffe4e6', 200: '#fecdd3', 300: '#fda4af', 400: '#fb7185', 500: '#f43f5e', 600: '#e11d48', 700: '#be123c', 800: '#9f1239', 900: '#881337', 950: '#4c0519' },
  cyan: { 50: '#ecfeff', 100: '#cffafe', 200: '#a5f3fc', 300: '#67e8f9', 400: '#22d3ee', 500: '#06b6d4', 600: '#0891b2', 700: '#0e7490', 800: '#155e75', 900: '#164e63', 950: '#083344' },
};
const PLINKY_NEUTRALS: Record<(typeof PLINKY_SHADES)[number], string> = {
  950: '#090d16', 900: '#0f172a', 850: '#131e36', 800: '#1e293b', 700: '#334155', 600: '#475569',
  500: '#64748b', 400: '#94a3b8', 300: '#cbd5e1', 200: '#e2e8f0', 100: '#f1f5f9', 50: '#f8fafc', muted: '#8e9bb0',
};

function varsOf(
  neutrals: Record<string, string>, scales: Record<string, Scale>, singles: Record<string, string>,
): Record<string, string> {
  const v: Record<string, string> = {};
  for (const [k, c] of Object.entries(neutrals)) v[`--c-plinky-${k}`] = triplet(c);
  for (const [name, s] of Object.entries(scales)) for (const sh of SHADES) v[`--c-${name}-${sh}`] = triplet(s[sh]);
  for (const [k, c] of Object.entries(singles)) v[`--c-${k}`] = triplet(c);
  return v;
}

const PLINKY: UiTheme = {
  id: 'plinky',
  name: 'Thyrion',
  light: false,
  swatch: ['#090d16', '#0f172a', '#0ea5e9', '#e2e8f0'],
  vars: varsOf(PLINKY_NEUTRALS, TW, {
    white: '#ffffff', 'on-accent': '#ffffff', 'on-danger': '#ffffff', 'on-warn': '#ffffff',
    // Tailwind cyan-400, violet-400, orange-400, pink-400.
    'ch-a': '#22d3ee', 'ch-b': '#a78bfa', 'ch-c': '#fb923c', 'ch-d': '#f472b6',
  }),
};

// ── a palette, expanded ──────────────────────────────────────────────────────
/** A state colour (success, warning, danger, channel A) as a scale: 400-500
 *  is the colour, lighter shades lean to the text colour (readable on the
 *  theme's background), darker ones sink into the background (tints). */
function stateScale(c: string, p: Palette, base500 = c): Scale {
  const text = (x: string) => ensure(x, p.surface, 4.5, p.fg);
  const s: Scale = {
    50: mix(c, p.fg, 0.85), 100: mix(c, p.fg, 0.7), 200: text(mix(c, p.fg, 0.5)), 300: text(mix(c, p.fg, 0.28)),
    400: text(c), 500: base500, 600: mix(base500, p.bg, 0.15), 700: mix(base500, p.bg, 0.3),
    800: mix(base500, p.bg, 0.5), 900: mix(base500, p.bg, 0.65), 950: mix(base500, p.bg, 0.82),
  };
  // 950 is also the text on a filled 500 (the amber buttons).
  s[950] = ensure(s[950], s[500], 4.5, readableOn(s[500]));
  return s;
}

/** A filled button's colour, moved away from its text colour until the two
 *  reach AA (Dracula's #915de6 under white was 4.39). */
function fill(c: string): string {
  const on = readableOn(c);
  // 4.7, not 4.5: a filled button rendered at 4.45 on screen in GitHub Light.
  return ensure(c, on, 4.7, on === '#ffffff' ? '#000000' : '#ffffff');
}

export function expandPalette(id: string, name: string, p: Palette): UiTheme {
  const light = luminance(p.bg) > 0.5;
  const neutrals = {
    950: p.bg, 900: p.surface, 850: p.field, 800: p.neutral, 700: p.border,
    600: mix(p.border, p.muted, 0.4), 500: mix(p.border, p.muted, 0.75), 400: p.muted,
    300: mix(p.muted, p.fg, 0.6), 200: mix(p.muted, p.fg, 0.85), 100: p.fg, 50: p.fg, muted: p.muted,
  };
  const slate: Scale = {
    50: p.fg, 100: p.fg, 200: mix(p.fg, p.muted, 0.18), 300: mix(p.fg, p.muted, 0.38),
    400: mix(p.fg, p.muted, 0.7), 500: p.muted, 600: mix(p.muted, p.border, 0.55),
    700: p.border, 800: p.neutral, 900: p.surface, 950: p.bg,
  };
  const sky: Scale = {
    50: mix(p.accent, p.fg, 0.88), 100: mix(p.accent, p.fg, 0.75), 200: mix(p.accent, p.fg, 0.55),
    300: ensure(mix(p.accent, p.fg, 0.35), p.surface, 4.5, p.fg), 400: ensure(mix(p.accent, p.fg, 0.15), p.surface, 4.5, p.fg), 500: p.accent,
    600: p.accent_hover, 700: fill(p.accent_active),
    800: mix(p.accent_active, p.bg, 0.35), 900: mix(p.accent_active, p.bg, 0.55), 950: mix(p.accent_active, p.bg, 0.75),
  };
  const scales = {
    slate, sky,
    emerald: stateScale(p.log_green, p),
    amber: stateScale(p.log_yellow, p),
    rose: stateScale(p.log_red, p, p.danger),
    cyan: stateScale(p.log_cyan, p),
  };
  scales.rose[700] = fill(scales.rose[700]);
  scales.amber[700] = fill(scales.amber[700]);
  scales.emerald[700] = fill(scales.emerald[700]);
  return {
    id, name, light, palette: p,
    swatch: [p.bg, p.surface, p.accent, p.fg],
    vars: varsOf(neutrals, scales, {
      // "white" is the strongest text; near-white on dark themes, the text
      // colour on light ones (headings were white-on-white otherwise).
      white: light ? p.fg : mix(p.fg, '#ffffff', 0.5),
      'on-accent': readableOn(sky[700]),
      'on-danger': readableOn(scales.rose[700]),
      'on-warn': readableOn(scales.amber[700]),
      'ch-a': ensure(p.log_cyan, p.surface, 4.5, p.fg),
      'ch-b': ensure(p.log_magenta, p.surface, 4.5, p.fg),
      'ch-c': ensure(mix(p.log_yellow, p.log_red, 0.5), p.surface, 4.5, p.fg),
      'ch-d': ensure(mix(p.log_magenta, p.log_red, 0.55), p.surface, 4.5, p.fg),
    }),
  };
}

// ── Classic desktop ──────────────────────────────────────────────────────────
// The light Windows chrome: grey toolbars, a white session list, the system
// blue for selection.
const CLASSIC: Record<string, Palette> = {
  'Classic Light': {
    bg: '#f0f0f0', surface: '#ffffff', field: '#ffffff', border: '#c8c8c8',
    fg: '#1a1a1a', muted: '#5f5f5f',
    accent: '#0078d7', accent_hover: '#006cc1', accent_active: '#005a9e',
    neutral: '#e5e5e5', neutral_hover: '#d9d9d9',
    danger: '#c42b1c', danger_hover: '#a4262c', disabled: '#f3f3f3',
    log_green: '#107c10', log_red: '#c42b1c', log_yellow: '#8a5d00',
    log_blue: '#0078d7', log_cyan: '#006b75', log_magenta: '#881798',
  },
  // PuTTY's own look: the silver-grey Windows panels of its configuration
  // window, white fields, navy title-bar blue.
  'Classic Grey': {
    bg: '#d4d0c8', surface: '#ece9e3', field: '#ffffff', border: '#9d9a93',
    fg: '#000000', muted: '#4b4a47',
    accent: '#0a246a', accent_hover: '#0c2c80', accent_active: '#0a246a',
    neutral: '#e0ddd6', neutral_hover: '#d6d2ca',
    danger: '#b00000', danger_hover: '#8c0000', disabled: '#dedbd4',
    log_green: '#006400', log_red: '#b00000', log_yellow: '#7a5500',
    log_blue: '#0a246a', log_cyan: '#00616b', log_magenta: '#7a1f7a',
  },
};

// ── Darker ───────────────────────────────────────────────────────────────────
// For dim rooms and long sessions: darker than the default.
const DARKER: Record<string, Palette> = {
  // Near-black blue-grey, the default's colours a step down.
  Midnight: {
    bg: '#05070b', surface: '#0b0f16', field: '#10151e', border: '#1f2733',
    fg: '#e3e8ef', muted: '#8691a2',
    accent: '#3b8eea', accent_hover: '#2f7bd4', accent_active: '#1f62b3',
    neutral: '#141a24', neutral_hover: '#1c2431',
    danger: '#f47174', danger_hover: '#d64045', disabled: '#0e131b',
    log_green: '#4cc38a', log_red: '#f47174', log_yellow: '#e8b44c',
    log_blue: '#5aa2f0', log_cyan: '#3fc5d8', log_magenta: '#b38cf2',
  },
  // True black and neutral greys: OLED screens, and the darkest room.
  Graphite: {
    bg: '#000000', surface: '#0a0a0a', field: '#111111', border: '#262626',
    fg: '#e4e4e4', muted: '#8c8c8c',
    accent: '#5e9cf5', accent_hover: '#4a88e0', accent_active: '#2f6bc4',
    neutral: '#161616', neutral_hover: '#202020',
    danger: '#f26d6d', danger_hover: '#d24444', disabled: '#0d0d0d',
    log_green: '#5ccb7e', log_red: '#f26d6d', log_yellow: '#e2b54a',
    log_blue: '#6aa5f5', log_cyan: '#4cc4cc', log_magenta: '#bf8cf0',
  },
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export const UI_THEMES: UiTheme[] = [
  PLINKY,
  ...Object.entries(DARKER).map(([name, p]) => expandPalette(slug(name), name, p)),
  ...Object.entries(CLASSIC).map(([name, p]) => expandPalette(slug(name), name, p)),
];
export const DEFAULT_UI_THEME = 'plinky';

// ── applying and remembering ─────────────────────────────────────────────────
const KEY = 'plinky_ui_theme';
// Themes renamed or removed since they shipped: a choice saved under the old
// id loads the nearest one kept. "securecrt" was v0.1.9-v0.1.11's name for
// Classic Light; the dark blue-greys removed in v0.2.6 were closest to
// Thyrion's own, GitHub Light to Classic Light.
const RENAMED: Record<string, string> = {
  securecrt: 'classic-light',
  'github-light': 'classic-light',
  'neutral-slate': 'plinky', 'tokyo-night': 'plinky', 'catppuccin-mocha': 'plinky', nord: 'plinky',
  'gruvbox-dark': 'plinky', 'bchips-violet': 'plinky', dracula: 'plinky',
};
const EVENT = 'plinky:ui-theme';
let current = DEFAULT_UI_THEME;

export const getUiTheme = () => current;
export const findUiTheme = (id: string) => UI_THEMES.find(t => t.id === id) ?? PLINKY;

export function applyUiTheme(id: string, persist = true) {
  const t = findUiTheme(id);
  current = t.id;
  const root = document.documentElement;
  // New colours in one repaint, not hundreds of 150 ms transitions at once
  // (see html.theme-switching in index.css): transitions off, colours set,
  // one forced style pass so they land while off, transitions back on.
  root.classList.add('theme-switching');
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
  root.style.colorScheme = t.light ? 'light' : 'dark';
  root.dataset.uiTheme = t.id;
  void document.body?.offsetHeight;
  root.classList.remove('theme-switching');
  if (persist) {
    try { localStorage.setItem(KEY, t.id); } catch { /* not remembered */ }
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: t.id }));
}

export function initUiTheme() {
  let saved: string | null = null;
  try { saved = localStorage.getItem(KEY); } catch { /* storage unavailable */ }
  if (saved) saved = RENAMED[saved] ?? saved;
  applyUiTheme(saved && UI_THEMES.some(t => t.id === saved) ? saved : DEFAULT_UI_THEME, false);
}

export function useUiTheme(): string {
  const [id, setId] = useState(current);
  useEffect(() => {
    const on = (e: Event) => setId((e as CustomEvent<string>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return id;
}
