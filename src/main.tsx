import React from 'react';
import ReactDOM from 'react-dom/client';
// Fonts ship inside the app. They were fetched from Google Fonts, which
// an offline or firewalled desktop never reaches, and JetBrains Mono -- first
// in the mono stack -- was never requested at all.
// opsz.css: Inter with its optical-size axis, drawn for 12-13px text.
import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/jetbrains-mono';
import { App } from './App';
import { initUiZoom } from './services/uiZoom';
import { initUiTheme } from './themes/uiThemes';
import { registerBundledFonts, loadTerminalFont } from './themes/fonts';
import './index.css';

// Theme variables before the first paint; bundled faces before anything
// asks for them.
initUiTheme();
registerBundledFonts();

// xterm measures its cell size once, when a terminal opens. Rendering before
// the bundled mono face has loaded measures the fallback font instead and
// the grid is off by a fraction of a cell. The files are local, so this
// waits a few milliseconds; the timeout covers a font that never resolves.
const fontsReady = Promise.race([
  Promise.all([
    document.fonts.load('13px "JetBrains Mono Variable"'),
    (() => {
      try {
        const saved = localStorage.getItem('plinky_terminal_font');
        return saved ? loadTerminalFont(saved) : Promise.resolve();
      } catch { return Promise.resolve(); }
    })(),
    document.fonts.load('13px "Inter Variable"'),
  ]),
  new Promise((resolve) => setTimeout(resolve, 1500)),
]).catch(() => undefined);

initUiZoom();

fontsReady.then(() => {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
