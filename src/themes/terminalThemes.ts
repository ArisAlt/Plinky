import { useEffect, useState } from 'react';
import type { ITheme } from '@xterm/xterm';
import { findUiTheme, getUiTheme, mix, type Palette } from './uiThemes';

// Terminal colour schemes, separate from the interface theme. The list is the
// defaults of the terminals Plinky's users come from (PuTTY, Windows
// Terminal's Campbell, Ubuntu's GNOME Terminal) plus the community schemes
// with the most terminal ports (Dracula, Catppuccin, Tokyo Night, Nord,
// Gruvbox, Solarized, One Dark, Monokai, GitHub, Tomorrow). Colours are
// each scheme's published terminal values.

export interface TerminalTheme {
  id: string;
  name: string;
  light?: boolean;
  theme: ITheme;
}

type Ansi16 = [string, string, string, string, string, string, string, string,
  string, string, string, string, string, string, string, string];

const ansi = (c: Ansi16): ITheme => ({
  black: c[0], red: c[1], green: c[2], yellow: c[3], blue: c[4], magenta: c[5], cyan: c[6], white: c[7],
  brightBlack: c[8], brightRed: c[9], brightGreen: c[10], brightYellow: c[11],
  brightBlue: c[12], brightMagenta: c[13], brightCyan: c[14], brightWhite: c[15],
});

const scheme = (
  id: string, name: string,
  base: { background: string; foreground: string; cursor: string; selection: string },
  colours: Ansi16, light = false,
): TerminalTheme => ({
  id, name, light,
  theme: {
    background: base.background,
    foreground: base.foreground,
    cursor: base.cursor,
    cursorAccent: base.background,
    selectionBackground: base.selection,
    ...ansi(colours),
  },
});

export const TERMINAL_THEMES: TerminalTheme[] = [
  // The colours Plinky has always used.
  scheme('plinky', 'Plinky',
    { background: '#090d16', foreground: '#e2e8f0', cursor: '#38bdf8', selection: 'rgba(56, 189, 248, 0.35)' },
    ['#0f172a', '#f43f5e', '#10b981', '#f59e0b', '#38bdf8', '#c084fc', '#06b6d4', '#f8fafc',
      '#475569', '#fb7185', '#34d399', '#fbbf24', '#60a5fa', '#e879f9', '#22d3ee', '#ffffff']),
  scheme('putty', 'PuTTY',
    { background: '#000000', foreground: '#bbbbbb', cursor: '#00ff00', selection: 'rgba(255, 255, 255, 0.3)' },
    ['#000000', '#bb0000', '#00bb00', '#bbbb00', '#0000bb', '#bb00bb', '#00bbbb', '#bbbbbb',
      '#555555', '#ff5555', '#55ff55', '#ffff55', '#5555ff', '#ff55ff', '#55ffff', '#ffffff']),
  // Black text on white, with the classic Windows 16-colour ANSI palette.
  scheme('classic-light', 'Classic Light',
    { background: '#ffffff', foreground: '#000000', cursor: '#000000', selection: 'rgba(0, 120, 215, 0.3)' },
    ['#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0',
      '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff'], true),
  scheme('campbell', 'Campbell (Windows Terminal)',
    { background: '#0c0c0c', foreground: '#cccccc', cursor: '#ffffff', selection: 'rgba(255, 255, 255, 0.25)' },
    ['#0c0c0c', '#c50f1f', '#13a10e', '#c19c00', '#0037da', '#881798', '#3a96dd', '#cccccc',
      '#767676', '#e74856', '#16c60c', '#f9f1a5', '#3b78ff', '#b4009e', '#61d6d6', '#f2f2f2']),
  scheme('ubuntu', 'Ubuntu',
    { background: '#300a24', foreground: '#eeeeec', cursor: '#bbbbbb', selection: 'rgba(255, 255, 255, 0.25)' },
    ['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
      '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec']),
  scheme('dracula', 'Dracula',
    { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selection: '#44475a' },
    ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2',
      '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff']),
  scheme('catppuccin-mocha', 'Catppuccin Mocha',
    { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selection: 'rgba(88, 91, 112, 0.6)' },
    ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de',
      '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8']),
  scheme('tokyo-night', 'Tokyo Night',
    { background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', selection: '#283457' },
    ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6',
      '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5']),
  scheme('nord', 'Nord',
    { background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', selection: '#434c5e' },
    ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0',
      '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4']),
  scheme('gruvbox-dark', 'Gruvbox Dark',
    { background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', selection: '#504945' },
    ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984',
      '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2']),
  scheme('solarized-dark', 'Solarized Dark',
    { background: '#002b36', foreground: '#839496', cursor: '#93a1a1', selection: '#073642' },
    ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']),
  scheme('solarized-light', 'Solarized Light',
    { background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', selection: '#eee8d5' },
    ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'], true),
  scheme('one-dark', 'One Dark',
    { background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', selection: '#3e4451' },
    ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf',
      '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff']),
  scheme('monokai', 'Monokai',
    { background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', selection: '#49483e' },
    ['#272822', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2',
      '#75715e', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f9f8f5']),
  scheme('github-dark', 'GitHub Dark',
    { background: '#0d1117', foreground: '#e6edf3', cursor: '#2f81f7', selection: 'rgba(56, 139, 253, 0.4)' },
    ['#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4',
      '#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#ffffff']),
  scheme('github-light', 'GitHub Light',
    { background: '#ffffff', foreground: '#1f2328', cursor: '#0969da', selection: 'rgba(84, 174, 255, 0.4)' },
    ['#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781',
      '#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f'], true),
  scheme('tomorrow-night', 'Tomorrow Night',
    { background: '#1d1f21', foreground: '#c5c8c6', cursor: '#c5c8c6', selection: '#373b41' },
    ['#1d1f21', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#c5c8c6',
      '#969896', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#ffffff']),
];

// "Match interface": the terminal follows the interface theme. It is the
// default, so choosing GitHub Light no longer leaves a black terminal slab
// in a white window. Under the Plinky interface it is exactly the Plinky
// scheme, so nothing changes for anyone who never touched a theme.
export const MATCH_INTERFACE = 'match';

const hexA = (c: string, a: number) => {
  const h = c.replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${a})`;
};

/** A terminal scheme from an interface palette. */
export function schemeFromPalette(id: string, name: string, p: Palette, light: boolean): TerminalTheme {
  // Bright colours step toward the text: lighter on dark themes, darker on
  // light ones, so they stay readable on the background either way.
  const bright = (c: string) => mix(c, light ? p.fg : '#ffffff', 0.25);
  return scheme(id, name,
    { background: p.bg, foreground: p.fg, cursor: p.accent, selection: hexA(p.accent, 0.3) },
    [p.surface, p.log_red, p.log_green, p.log_yellow, p.log_blue, p.log_magenta, p.log_cyan, mix(p.fg, p.muted, 0.35),
      p.muted, bright(p.log_red), bright(p.log_green), bright(p.log_yellow), bright(p.log_blue), bright(p.log_magenta), bright(p.log_cyan), p.fg],
    light);
}

function matchInterface(): TerminalTheme {
  const ui = findUiTheme(getUiTheme());
  const base = ui.palette
    ? schemeFromPalette(MATCH_INTERFACE, 'Match interface', ui.palette, ui.light)
    : { ...TERMINAL_THEMES[0], id: MATCH_INTERFACE, name: 'Match interface' };
  return base;
}

export const DEFAULT_TERMINAL_THEME = MATCH_INTERFACE;
export const findTerminalTheme = (id: string): TerminalTheme =>
  id === MATCH_INTERFACE ? matchInterface() : (TERMINAL_THEMES.find(t => t.id === id) ?? matchInterface());
const isKnown = (id: string) => id === MATCH_INTERFACE || TERMINAL_THEMES.some(t => t.id === id);

const KEY = 'plinky_terminal_theme';
// Schemes renamed since they shipped: a choice saved under the old id still
// loads. "securecrt" was v0.1.9-v0.1.11's name for Classic Light.
const RENAMED: Record<string, string> = { securecrt: 'classic-light' };
const EVENT = 'plinky:terminal-theme';

function readSaved(): string {
  try {
    const saved = localStorage.getItem(KEY);
    const v = saved ? (RENAMED[saved] ?? saved) : saved;
    return v && isKnown(v) ? v : DEFAULT_TERMINAL_THEME;
  } catch {
    return DEFAULT_TERMINAL_THEME;
  }
}

let current: string | null = null;
export const getTerminalThemeId = () => (current ??= readSaved());

export function setTerminalTheme(id: string) {
  current = isKnown(id) ? id : DEFAULT_TERMINAL_THEME;
  try { localStorage.setItem(KEY, current); } catch { /* not remembered */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: current }));
}

/** The chosen scheme; every terminal pane re-renders with it on change. */
export function useTerminalTheme(): TerminalTheme {
  const [id, setId] = useState(getTerminalThemeId);
  // "Match interface" changes with the interface theme too.
  const [, setUiTick] = useState(0);
  useEffect(() => {
    const on = (e: Event) => setId((e as CustomEvent<string>).detail);
    const onUi = () => setUiTick(n => n + 1);
    window.addEventListener(EVENT, on);
    window.addEventListener('plinky:ui-theme', onUi);
    return () => {
      window.removeEventListener(EVENT, on);
      window.removeEventListener('plinky:ui-theme', onUi);
    };
  }, []);
  return findTerminalTheme(id);
}
