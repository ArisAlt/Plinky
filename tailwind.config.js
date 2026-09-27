/** @type {import('tailwindcss').Config} */

// Every colour reads a CSS variable ("r g b"), set by src/themes/uiThemes.ts,
// so an interface theme is a change of variables and every existing class
// (text-slate-400, bg-sky-700/20, ...) follows it. The default theme,
// "Plinky", sets them to Tailwind's own values: the look is unchanged.
const v = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const scale = (name) => Object.fromEntries(SHADES.map((s) => [s, v(`${name}-${s}`)]));
const PLINKY = ['950', '900', '850', '800', '700', '600', '500', '400', '300', '200', '100', '50', 'muted'];

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // plinky-muted is secondary text: the darkest grey that clears 4.5:1
        // on every surface a label sits on, selected rows included.
        plinky: Object.fromEntries(PLINKY.map((k) => [k, v(`plinky-${k}`)])),
        slate: scale('slate'),
        sky: scale('sky'),
        emerald: scale('emerald'),
        amber: scale('amber'),
        rose: scale('rose'),
        cyan: scale('cyan'),
        // The strongest text. Near-white on dark themes, the text colour on
        // light ones, where white headings would vanish.
        white: v('white'),
        // Text on a filled button, picked per theme for contrast (a light
        // accent like Nord's needs dark text).
        'on-accent': v('on-accent'),
        'on-danger': v('on-danger'),
        'on-warn': v('on-warn'),
      },
      // Linux renders small unhinted text soft. The scale starts one step
      // up from the stock one: 12px meta, 13px body, 14px names.
      fontSize: {
        meta: ['12px', { lineHeight: '16px' }],
        xs: ['13px', { lineHeight: '18px' }],
      },
      // Tailwind 4 names the components were written with. In this Tailwind 3
      // project they generated no CSS at all, so 7 modal backdrops had no blur
      // and 6 cards no shadow.
      backdropBlur: { xs: '2px' },
      boxShadow: { xs: '0 1px 2px 0 rgb(0 0 0 / 0.05)' },
      fontFamily: {
        mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
        sans: ['"Inter Variable"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
