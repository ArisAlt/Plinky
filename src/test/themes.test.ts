import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UI_THEMES, applyUiTheme, initUiTheme, contrast, findUiTheme, getUiTheme } from '../themes/uiThemes';
import { TERMINAL_THEMES, setTerminalTheme, getTerminalThemeId, findTerminalTheme, MATCH_INTERFACE, DEFAULT_TERMINAL_THEME } from '../themes/terminalThemes';
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

  it('includes the ABtools palettes by name, then Classic Light', () => {
    expect(UI_THEMES.map(t => t.name)).toEqual([
      'Plinky', 'Neutral Slate', 'Tokyo Night', 'Catppuccin Mocha', 'Nord',
      'Gruvbox Dark', 'Bchips Violet', 'Dracula', 'GitHub Light', 'Classic Light',
    ]);
  });

  it('has a Classic Light terminal: black on white, light', () => {
    const t = findTerminalTheme('classic-light');
    expect(t.id).toBe('classic-light');
    expect(t.light).toBe(true);
    expect(t.theme.background).toBe('#ffffff');
    expect(t.theme.foreground).toBe('#000000');
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

describe('a theme renamed after it shipped', () => {
  beforeEach(() => localStorage.clear());

  it('still loads when saved under its old name, as Classic Light', async () => {
    // v0.1.9-v0.1.11 saved it under the id "securecrt". Without the
    // mapping, someone who had picked it silently fell back to the default.
    localStorage.setItem('plinky_ui_theme', 'securecrt');
    localStorage.setItem('plinky_terminal_theme', 'securecrt');
    vi.resetModules(); // fresh modules: the terminal choice is read once, then cached
    const ui = await import('../themes/uiThemes');
    const term = await import('../themes/terminalThemes');
    ui.initUiTheme();
    expect(ui.getUiTheme()).toBe('classic-light');
    expect(term.getTerminalThemeId()).toBe('classic-light');
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

describe('match interface', () => {
  it('is the default, and under the Plinky interface it is the Plinky scheme exactly', () => {
    expect(DEFAULT_TERMINAL_THEME).toBe(MATCH_INTERFACE);
    applyUiTheme('plinky', false);
    const { background, foreground, red, brightBlue } = findTerminalTheme(MATCH_INTERFACE).theme;
    expect({ background, foreground, red, brightBlue }).toEqual({
      background: TERMINAL_THEMES[0].theme.background, foreground: TERMINAL_THEMES[0].theme.foreground,
      red: TERMINAL_THEMES[0].theme.red, brightBlue: TERMINAL_THEMES[0].theme.brightBlue,
    });
  });

  it('under GitHub Light the terminal is light too', () => {
    // A design review's run: a black terminal slab inside a white window.
    applyUiTheme('github-light', false);
    const t = findTerminalTheme(MATCH_INTERFACE);
    expect(t.theme.background).toBe('#f6f8fa');
    expect(t.light).toBe(true);
  });

  for (const ui of UI_THEMES) {
    it(`${ui.name}: its matched terminal text is readable`, () => {
      applyUiTheme(ui.id, false);
      const { theme } = findTerminalTheme(MATCH_INTERFACE);
      expect(contrast(theme.foreground!, theme.background!)).toBeGreaterThanOrEqual(4.5);
    });
  }
});


describe('switching the interface theme', () => {
  it('applies the colours with transitions off, then turns them back on', () => {
    // Hundreds of 150 ms colour transitions ran at once on every switch and
    // made it lag on Windows; the colours now land in one style pass.
    const root = document.documentElement;
    const seen: boolean[] = [];
    const set = root.style.setProperty.bind(root.style);
    const spy = vi.spyOn(root.style, 'setProperty').mockImplementation((k, v, p) => {
      seen.push(root.classList.contains('theme-switching'));
      set(k, v, p);
    });
    const other = UI_THEMES.find(t => t.id !== getUiTheme())!;
    applyUiTheme(other.id, false);
    spy.mockRestore();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
    expect(root.classList.contains('theme-switching')).toBe(false);
  });
});
