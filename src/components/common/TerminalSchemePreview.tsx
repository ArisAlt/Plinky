import React from 'react';
import { TerminalTheme } from '../../themes/terminalThemes';

/** A few lines of a terminal in a colour scheme, font and size: Global
 *  Settings and a session's Appearance tab show the same preview. */
export const TerminalSchemePreview: React.FC<{
  scheme: TerminalTheme;
  fontFamily: string;
  fontSize: number;
  testId?: string;
}> = ({ scheme, fontFamily, fontSize, testId }) => (
  <div
    data-testid={testId}
    aria-label={`Preview of ${scheme.name}`}
    className="rounded border border-plinky-700 px-3 py-2 overflow-hidden select-none"
    style={{
      background: scheme.theme.background,
      color: scheme.theme.foreground,
      fontFamily,
      fontSize: `${fontSize}px`,
      lineHeight: 1.25,
    }}
  >
    <div className="whitespace-pre">
      <span style={{ color: scheme.theme.green }}>admin@core-sw1</span>
      <span>:</span>
      <span style={{ color: scheme.theme.blue }}>~</span>
      <span>$ show ip int brief</span>
    </div>
    <div className="whitespace-pre">
      <span>Gi0/1  10.0.0.1  </span>
      <span style={{ color: scheme.theme.green }}>up</span>
      <span>    Gi0/2  </span>
      <span style={{ color: scheme.theme.red }}>down</span>
      <span style={{ color: scheme.theme.yellow }}>  warn</span>
    </div>
    <div className="flex gap-1 pt-1.5" aria-hidden>
      {(['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const).map(k => (
        <span key={k} className="flex-1 h-2.5 rounded-sm" style={{ background: scheme.theme[k] }} />
      ))}
    </div>
    <div className="flex gap-1 pt-1" aria-hidden>
      {(['brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const).map(k => (
        <span key={k} className="flex-1 h-2.5 rounded-sm" style={{ background: scheme.theme[k] }} />
      ))}
    </div>
  </div>
);
