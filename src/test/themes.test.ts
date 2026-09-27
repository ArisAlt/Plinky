import { describe, it, expect, beforeEach } from 'vitest';
import { UI_THEMES, applyUiTheme, initUiTheme, contrast, findUiTheme } from '../themes/uiThemes';
import { TERMINAL_THEMES, setTerminalTheme, getTerminalThemeId } from '../themes/terminalThemes';
import { TERMINAL_FONTS, primaryFamily } from '../themes/fonts';

const hexOf = (triplet: string) => '#' + triplet.split(' ').map(n => (+n).toString(16).padStart(2, '0')).join('');
const col = (id: string, name: string) => hexOf(findUiTheme(id).vars[`--c-${name}`]);

describe('interface themes', () => {
  beforeEach(() => localStorage.clear());

  it('the Plinky theme is the look the app always had', () => {
    // Tailwind's own values, which every class used before themes existed.
    expect(col('plinky', 'slate-400')).toBe('#94a3b8');
    expect(col('plinky', 'sky-700')).toBe('#0369a1');
    expect(col('plinky', 'plinky-950')).toBe('#090d16');
    expect(col('plinky', 'plinky-muted')).toBe('#8e9bb0');
    expect(col('plinky', 'white')).toBe('#ffffff');
  });

  it('includes the ABtools palettes by name', () => {
    expect(UI_THEMES.map(t => t.name)).toEqual([
      'Plinky', 'Neutral Slate', 'Tokyo Night', 'Catppuccin Mocha', 'Nord',
      'Gruvbox Dark', 'Bchips Violet', 'Dracula', 'GitHub Light',
    ]);
  });

  // The pairs the UI actually draws: body text, secondary text, labels on
  // selected rows, and text on filled buttons.
  const PAIRS: [string, string][] = [
    ['slate-100', 'plinky-950'], ['slate-300', 'plinky-900'], ['slate-400', 'plinky-900'],
    ['plinky-muted', 'plinky-900'], ['plinky-muted', 'plinky-950'], ['white', 'plinky-900'],
    ['sky-300', 'plinky-900'], ['sky-400', 'plinky-900'],
    ['on-accent', 'sky-700'], ['on-danger', 'rose-700'], ['amber-950', 'amber-500'],
    ['emerald-400', 'plinky-900'], ['amber-400', 'plinky-900'], ['rose-400', 'plinky-900'],
  ];
  for (const t of UI_THEMES) {
    it(`${t.name}: every text pair reaches WCAG AA`, () => {
      const low = PAIRS
        .map(([fg, bg]) => [fg, bg, contrast(col(t.id, fg), col(t.id, bg))] as const)
        .filter(([, , r]) => r < 4.5)
        .map(([fg, bg, r]) => `${fg} on ${bg} ${r.toFixed(2)}`);
      expect(low).toEqual([]);
    });
  }

  it('applies by setting variables, marks light themes, and is remembered', () => {
    applyUiTheme('github-light');
    expect(document.documentElement.style.getPropertyValue('--c-plinky-950')).toBe('246 248 250');
    expect(document.documentElement.style.colorScheme).toBe('light');
    applyUiTheme('plinky', false);
    initUiTheme();
    expect(document.documentElement.dataset.uiTheme).toBe('github-light');
  });

  it('an unknown saved theme falls back to Plinky', () => {
    localStorage.setItem('plinky_ui_theme', 'no-such-theme');
    initUiTheme();
    expect(document.documentElement.dataset.uiTheme).toBe('plinky');
  });
});

describe('terminal themes', () => {
  const KEYS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
    'background', 'foreground', 'cursor'] as const;

  it('every scheme defines all 16 colours plus background, text and cursor', () => {
    for (const t of TERMINAL_THEMES) {
      for (const k of KEYS) expect(t.theme[k], `${t.name}.${k}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(new Set(TERMINAL_THEMES.map(t => t.id)).size).toBe(TERMINAL_THEMES.length);
  });

  it('text is readable on every scheme background', () => {
    // Schemes keep their published values. Solarized Light's own text colour
    // is 4.13:1 on its background, lower contrast by design, so the bar
    // here is 4:1 and only that scheme sits under 4.5.
    const under = TERMINAL_THEMES.filter(t => contrast(t.theme.foreground!, t.theme.background!) < 4.5).map(t => t.name);
    expect(under).toEqual(['Solarized Light']);
    for (const t of TERMINAL_THEMES) {
      expect(contrast(t.theme.foreground!, t.theme.background!), t.name).toBeGreaterThanOrEqual(4);
    }
  });

  it('Plinky keeps the colours terminals always had, and a choice is remembered', () => {
    expect(TERMINAL_THEMES[0].theme.background).toBe('#090d16');
    setTerminalTheme('dracula');
    expect(localStorage.getItem('plinky_terminal_theme')).toBe('dracula');
    expect(getTerminalThemeId()).toBe('dracula');
  });
});

describe('terminal fonts', () => {
  it('lists the bundled faces first, each loadable by its first family', () => {
    const bundled = TERMINAL_FONTS.filter(f => f.bundled).map(f => f.label);
    expect(bundled).toEqual(expect.arrayContaining(['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Source Code Pro', 'IBM Plex Mono']));
    expect(primaryFamily(TERMINAL_FONTS[2].value)).toBe('Fira Code Variable');
  });
});
