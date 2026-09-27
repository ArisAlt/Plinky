/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        plinky: {
          950: '#090d16',
          // Secondary text. slate-500 measured 3.75:1 on plinky-900 and 2.74:1
          // on a selected row; this is the darkest grey that clears 4.5:1 on
          // every surface a label sits on, selected rows included.
          muted: '#8e9bb0',
          900: '#0f172a',
          850: '#131e36',
          800: '#1e293b',
          700: '#334155',
          600: '#475569',
          500: '#64748b',
          400: '#94a3b8',
          300: '#cbd5e1',
          200: '#e2e8f0',
          100: '#f1f5f9',
          50: '#f8fafc',
        },
        // Broadcast sync channel colors (WindTerm style)
        channel: {
          A: '#06b6d4', // Cyan
          B: '#10b981', // Emerald
          C: '#f59e0b', // Amber
          D: '#f43f5e', // Rose
        },
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
