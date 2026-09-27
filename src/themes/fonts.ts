// Terminal fonts. The most used programming fonts ship inside the app (Latin
// only, about 300 KB together) so they work offline and on a machine that
// has none of them. Nerd Font builds and platform fonts are listed too; they
// work when installed and fall back to the bundled JetBrains Mono otherwise.
import firaCode from '@fontsource-variable/fira-code/files/fira-code-latin-wght-normal.woff2?url';
import cascadia from '@fontsource-variable/cascadia-code/files/cascadia-code-latin-wght-normal.woff2?url';
import sourceCodePro from '@fontsource-variable/source-code-pro/files/source-code-pro-latin-wght-normal.woff2?url';
import robotoMono from '@fontsource-variable/roboto-mono/files/roboto-mono-latin-wght-normal.woff2?url';
import plex400 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2?url';
import plex700 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-700-normal.woff2?url';
import ubuntu400 from '@fontsource/ubuntu-mono/files/ubuntu-mono-latin-400-normal.woff2?url';
import ubuntu700 from '@fontsource/ubuntu-mono/files/ubuntu-mono-latin-700-normal.woff2?url';

/** Icons from Nerd Fonts (Powerlevel10k, Starship) come from these when
 *  installed; the bundled faces don't carry them. */
const GLYPH_FALLBACK = '"Symbols Nerd Font Mono", "MesloLGS NF", "JetBrains Mono Variable", monospace';

const BUNDLED: { family: string; src: string; weight: string }[] = [
  { family: 'Fira Code Variable', src: firaCode, weight: '300 700' },
  { family: 'Cascadia Code Variable', src: cascadia, weight: '200 700' },
  { family: 'Source Code Pro Variable', src: sourceCodePro, weight: '200 900' },
  { family: 'Roboto Mono Variable', src: robotoMono, weight: '100 700' },
  { family: 'IBM Plex Mono', src: plex400, weight: '400' },
  { family: 'IBM Plex Mono', src: plex700, weight: '700' },
  { family: 'Ubuntu Mono', src: ubuntu400, weight: '400' },
  { family: 'Ubuntu Mono', src: ubuntu700, weight: '700' },
];

let registered = false;
/** Adds the bundled faces. Nothing downloads until a face is used. */
export function registerBundledFonts() {
  if (registered || typeof FontFace === 'undefined' || !document.fonts) return;
  registered = true;
  for (const f of BUNDLED) {
    try {
      document.fonts.add(new FontFace(f.family, `url(${f.src}) format('woff2')`, { weight: f.weight, display: 'swap' }));
    } catch {
      // A face that can't be built leaves the fallback in its place.
    }
  }
}

export interface TerminalFont {
  label: string;
  /** CSS font-family stack, as stored in settings. */
  value: string;
  bundled: boolean;
  note?: string;
}

export const DEFAULT_TERMINAL_FONT =
  '"MesloLGS Nerd Font", "MesloLGS NF", "FantasqueSansM Nerd Font", "JetBrainsMono Nerd Font", "JetBrains Mono Variable", "JetBrains Mono", "DejaVu Sans Mono", monospace';

export const TERMINAL_FONTS: TerminalFont[] = [
  { label: 'Automatic (Nerd Font if installed, else JetBrains Mono)', value: DEFAULT_TERMINAL_FONT, bundled: true },
  { label: 'JetBrains Mono', value: `"JetBrains Mono Variable", "JetBrains Mono", ${GLYPH_FALLBACK}`, bundled: true },
  { label: 'Fira Code', value: `"Fira Code Variable", "Fira Code", ${GLYPH_FALLBACK}`, bundled: true },
  { label: 'Cascadia Code', value: `"Cascadia Code Variable", "Cascadia Code", ${GLYPH_FALLBACK}`, bundled: true, note: 'Windows Terminal default' },
  { label: 'Source Code Pro', value: `"Source Code Pro Variable", "Source Code Pro", ${GLYPH_FALLBACK}`, bundled: true },
  { label: 'IBM Plex Mono', value: `"IBM Plex Mono", ${GLYPH_FALLBACK}`, bundled: true },
  { label: 'Roboto Mono', value: `"Roboto Mono Variable", "Roboto Mono", ${GLYPH_FALLBACK}`, bundled: true },
  { label: 'Ubuntu Mono', value: `"Ubuntu Mono", ${GLYPH_FALLBACK}`, bundled: true, note: 'narrow; try 15px or more' },
  { label: 'MesloLGS Nerd Font', value: '"MesloLGS Nerd Font", "MesloLGS NF", monospace', bundled: false, note: 'for Powerlevel10k / Starship' },
  { label: 'Hack', value: `"Hack Nerd Font", "Hack", ${GLYPH_FALLBACK}`, bundled: false },
  { label: 'Iosevka', value: `"Iosevka Nerd Font", "Iosevka", ${GLYPH_FALLBACK}`, bundled: false },
  { label: 'Consolas', value: `Consolas, ${GLYPH_FALLBACK}`, bundled: false, note: 'Windows' },
  { label: 'DejaVu Sans Mono', value: `"DejaVu Sans Mono", ${GLYPH_FALLBACK}`, bundled: false, note: 'Linux' },
  { label: 'System monospace', value: 'monospace', bundled: false },
];

/** The first family in a stack, for loading it ahead of use. */
export const primaryFamily = (stack: string) => (stack.split(',')[0] || '').trim().replace(/^["']|["']$/g, '');

/** Waits (briefly) for a face, so xterm measures the real glyphs, not the
 *  fallback's: it measures its cell once, when the font option changes. */
export async function loadTerminalFont(stack: string, size = 14): Promise<void> {
  if (!document.fonts) return;
  try {
    await Promise.race([
      document.fonts.load(`${size}px "${primaryFamily(stack)}"`),
      new Promise(r => setTimeout(r, 1500)),
    ]);
  } catch {
    // Not installed, or unloadable: the stack's fallbacks take over.
  }
}
