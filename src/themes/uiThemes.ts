import { useEffect, useState } from 'react';

// Interface themes. Every colour class in the UI (plinky-*, slate-*, sky-*,
// emerald-*, amber-*, rose-*, cyan-*, white) reads a CSS variable, set here,
// so a theme swaps the variables and every existing class follows it.
//
// "Plinky" is the look the app always had: Tailwind's own slate/sky/emerald/
// amber/rose/cyan values, byte for byte. The others are the palettes from
// ABtools' AbtoolsGui.py (same names, same keys), expanded into full shade
// scales by mixing each colour toward the theme's text or background.

export type Shade = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950;
export const SHADES: Shade[] = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
export const SCALES = ['slate', 'sky', 'emerald', 'amber', 'rose', 'cyan'] as const;
export const PLINKY_SHADES = ['950', '900', '850', '800', '700', '600', '500', '400', '300', '200', '100', '50', 'muted'] as const;
export const SINGLES = ['white', 'on-accent', 'on-danger', 'on-warn'] as const;

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
  name: 'Plinky',
  light: false,
  swatch: ['#090d16', '#0f172a', '#0ea5e9', '#e2e8f0'],
  vars: varsOf(PLINKY_NEUTRALS, TW, { white: '#ffffff', 'on-accent': '#ffffff', 'on-danger': '#ffffff', 'on-warn': '#ffffff' }),
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
  return ensure(c, on, 4.5, on === '#ffffff' ? '#000000' : '#ffffff');
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
    id, name, light,
    swatch: [p.bg, p.surface, p.accent, p.fg],
    vars: varsOf(neutrals, scales, {
      // "white" is the strongest text; near-white on dark themes, the text
      // colour on light ones (headings were white-on-white otherwise).
      white: light ? p.fg : mix(p.fg, '#ffffff', 0.5),
      'on-accent': readableOn(sky[700]),
      'on-danger': readableOn(scales.rose[700]),
      'on-warn': readableOn(scales.amber[700]),
    }),
  };
}

// ── ABtools' palettes (AbtoolsGui.py THEMES), verbatim ───────────────────────
const ABTOOLS: Record<string, Palette> = {
  'Neutral Slate': {
    bg: '#0c0e12', surface: '#151821', field: '#1c202c', border: '#2c3242',
    fg: '#e6eaf2', muted: '#8892a4',
    accent: '#3b82f6', accent_hover: '#2563eb', accent_active: '#1d4ed8',
    neutral: '#202533', neutral_hover: '#2b3245',
    danger: '#f87171', danger_hover: '#dc2626', disabled: '#161922',
    log_green: '#4ade80', log_red: '#f87171', log_yellow: '#fbbf24',
    log_blue: '#60a5fa', log_cyan: '#22d3ee', log_magenta: '#c084fc',
  },
  'Tokyo Night': {
    bg: '#16161e', surface: '#1f2335', field: '#24283b', border: '#363b54',
    fg: '#c0caf5', muted: '#7aa2f7',
    accent: '#7aa2f7', accent_hover: '#668ee0', accent_active: '#547bc8',
    neutral: '#292e42', neutral_hover: '#3b4261',
    danger: '#f7768e', danger_hover: '#e05a73', disabled: '#1c1f2e',
    log_green: '#9ece6a', log_red: '#f7768e', log_yellow: '#e0af68',
    log_blue: '#7aa2f7', log_cyan: '#7dcfff', log_magenta: '#bb9af7',
  },
  'Catppuccin Mocha': {
    bg: '#181825', surface: '#1e1e2e', field: '#252538', border: '#36374f',
    fg: '#cdd6f4', muted: '#a6adc8',
    accent: '#89b4fa', accent_hover: '#74a3f0', accent_active: '#5f92e6',
    neutral: '#313244', neutral_hover: '#45475a',
    danger: '#f38ba8', danger_hover: '#e07396', disabled: '#222233',
    log_green: '#a6e3a1', log_red: '#f38ba8', log_yellow: '#f9e2af',
    log_blue: '#89b4fa', log_cyan: '#94e2d5', log_magenta: '#cba6f7',
  },
  Nord: {
    bg: '#242933', surface: '#2e3440', field: '#3b4252', border: '#434c5e',
    fg: '#eceff4', muted: '#98a4b8',
    accent: '#88c0d0', accent_hover: '#77b2c2', accent_active: '#5e81ac',
    neutral: '#3b4252', neutral_hover: '#4c566a',
    danger: '#bf616a', danger_hover: '#a54e57', disabled: '#2c333f',
    log_green: '#a3be8c', log_red: '#d4939a', log_yellow: '#ebcb8b',
    log_blue: '#81a1c1', log_cyan: '#88c0d0', log_magenta: '#b48ead',
  },
  'Gruvbox Dark': {
    bg: '#1d2021', surface: '#282828', field: '#32302f', border: '#4a4440',
    fg: '#ebdbb2', muted: '#a89984',
    accent: '#fabd2f', accent_hover: '#e6a800', accent_active: '#d79921',
    neutral: '#3c3836', neutral_hover: '#504945',
    danger: '#fb4934', danger_hover: '#cc241d', disabled: '#252525',
    log_green: '#b8bb26', log_red: '#fb4934', log_yellow: '#fabd2f',
    log_blue: '#83a598', log_cyan: '#8ec07c', log_magenta: '#d3869b',
  },
  'Bchips Violet': {
    bg: '#121324', surface: '#1a1c36', field: '#232548', border: '#353765',
    fg: '#e2e8f0', muted: '#939bb5',
    accent: '#8b5cf6', accent_hover: '#7c3aed', accent_active: '#6d28d9',
    neutral: '#26284d', neutral_hover: '#36396b',
    danger: '#ef4444', danger_hover: '#dc2626', disabled: '#1e203b',
    log_green: '#22c55e', log_red: '#ef4444', log_yellow: '#f59e0b',
    log_blue: '#60a5fa', log_cyan: '#22d3ee', log_magenta: '#a78bfa',
  },
  Dracula: {
    bg: '#21222c', surface: '#282a36', field: '#343746', border: '#44475a',
    fg: '#f8f8f2', muted: '#a0a6bd',
    accent: '#bd93f9', accent_hover: '#aa7df2', accent_active: '#915de6',
    neutral: '#343746', neutral_hover: '#44475a',
    danger: '#ff5555', danger_hover: '#e04444', disabled: '#1e1f29',
    log_green: '#50fa7b', log_red: '#ff5555', log_yellow: '#f1fa8c',
    log_blue: '#8be9fd', log_cyan: '#8be9fd', log_magenta: '#ff79c6',
  },
  'GitHub Light': {
    bg: '#f6f8fa', surface: '#ffffff', field: '#f0f2f5', border: '#d0d7de',
    fg: '#1f2328', muted: '#656d76',
    accent: '#0969da', accent_hover: '#0858b7', accent_active: '#064593',
    neutral: '#eaeef2', neutral_hover: '#dfe5eb',
    danger: '#cf222e', danger_hover: '#a40e26', disabled: '#f3f4f6',
    log_green: '#1a7f37', log_red: '#cf222e', log_yellow: '#9a6700',
    log_blue: '#0969da', log_cyan: '#0550ae', log_magenta: '#8250df',
  },
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export const UI_THEMES: UiTheme[] = [
  PLINKY,
  ...Object.entries(ABTOOLS).map(([name, p]) => expandPalette(slug(name), name, p)),
];
export const DEFAULT_UI_THEME = 'plinky';

// ── applying and remembering ─────────────────────────────────────────────────
const KEY = 'plinky_ui_theme';
const EVENT = 'plinky:ui-theme';
let current = DEFAULT_UI_THEME;

export const getUiTheme = () => current;
export const findUiTheme = (id: string) => UI_THEMES.find(t => t.id === id) ?? PLINKY;

export function applyUiTheme(id: string, persist = true) {
  const t = findUiTheme(id);
  current = t.id;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
  root.style.colorScheme = t.light ? 'light' : 'dark';
  root.dataset.uiTheme = t.id;
  if (persist) {
    try { localStorage.setItem(KEY, t.id); } catch { /* not remembered */ }
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: t.id }));
}

export function initUiTheme() {
  let saved: string | null = null;
  try { saved = localStorage.getItem(KEY); } catch { /* storage unavailable */ }
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
