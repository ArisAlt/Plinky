// Helpers that run inside the app's page. installHelpers is sent to the page
// as source text, so it must not use anything from this module's scope.
//
// Keys and clicks are DOM events dispatched from script. xterm.js and React
// both act on them (neither checks isTrusted), so the app's own handlers run:
// the shortcut handler, xterm's key mapping, the paste path. What they cannot
// reach is the webview's native handling underneath, such as a middle-click
// paste of the X selection.

export function installHelpers() {
  if (window.__e2e) return true;

  const visible = (el) => !!el && el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== 'hidden';

  // The xterm of the tab on screen. Every open tab keeps its terminal in the
  // page; the others are hidden.
  const activeXterm = () => [...document.querySelectorAll('.xterm')].find(visible) ?? null;

  const KEYS = {
    Enter: [13, 'Enter'], Backspace: [8, 'Backspace'], Tab: [9, 'Tab'], Escape: [27, 'Escape'],
    Space: [32, 'Space', ' '], Up: [38, 'ArrowUp'], Down: [40, 'ArrowDown'], Left: [37, 'ArrowLeft'],
    Right: [39, 'ArrowRight'], Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'],
    PageDown: [34, 'PageDown'], Insert: [45, 'Insert'], Delete: [46, 'Delete'],
  };
  for (let i = 1; i <= 12; i++) KEYS[`F${i}`] = [111 + i, `F${i}`];

  // "Ctrl+Shift+V" -> a keydown the way the webview builds one.
  const parseKey = (spec) => {
    const parts = spec.split('+');
    const name = parts.pop();
    const mods = new Set(parts.map((p) => p.toLowerCase()));
    let keyCode, code, key;
    if (KEYS[name]) {
      [keyCode, code, key] = KEYS[name];
      key = key ?? code;
      if (name.startsWith('F') && name.length <= 3) key = name;
    } else if (name.length === 1) {
      const upper = name.toUpperCase();
      if (/[A-Z]/.test(upper)) { keyCode = upper.charCodeAt(0); code = `Key${upper}`; }
      else if (/[0-9]/.test(name)) { keyCode = name.charCodeAt(0); code = `Digit${name}`; }
      else if (name === '=') { keyCode = 187; code = 'Equal'; }
      else if (name === '-') { keyCode = 189; code = 'Minus'; }
      else { keyCode = 0; code = ''; }
      // What a US layout gives with Shift: Ctrl+Shift+6 arrives as key "^".
      const shifted = { 1: '!', 2: '@', 3: '#', 4: '$', 5: '%', 6: '^', 7: '&', 8: '*', 9: '(', 0: ')' };
      key = mods.has('shift') ? (shifted[name] ?? name.toUpperCase()) : name.toLowerCase();
    } else {
      throw new Error(`unknown key ${name}`);
    }
    return {
      key, code, keyCode,
      ctrlKey: mods.has('ctrl'), shiftKey: mods.has('shift'), altKey: mods.has('alt'), metaKey: mods.has('meta'),
    };
  };

  const keyEvent = (type, init, extra = {}) => {
    const ev = new KeyboardEvent(type, { bubbles: true, cancelable: true, composed: true, ...init });
    // keyCode, which and charCode are read-only and the init dictionary does
    // not set them everywhere; xterm maps keys by keyCode.
    const legacy = { keyCode: init.keyCode ?? 0, which: init.keyCode ?? 0, charCode: 0, ...extra };
    for (const [k, v] of Object.entries(legacy)) Object.defineProperty(ev, k, { get: () => v });
    return ev;
  };

  const center = (el) => {
    const r = el.getBoundingClientRect();
    return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  };

  const mouse = (el, type, init = {}) => el.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, composed: true, view: window, ...center(el), ...init,
  }));

  const e2e = {
    visible,

    /** Text of the terminal on screen, one string per row, trailing
     *  spaces removed. Rows scrolled off the top are not included. */
    screen() {
      const term = activeXterm();
      if (!term) return null;
      return [...term.querySelectorAll('.xterm-rows > div')]
        .map((row) => row.textContent.replace(/\u00a0/g, ' ').replace(/\s+$/, ''));
    },

    /** Columns and rows the terminal on screen shows. */
    termSize() {
      const term = activeXterm();
      const rows = term?.querySelectorAll('.xterm-rows > div');
      const span = term?.querySelector('.xterm-char-measure-element');
      const screenEl = term?.querySelector('.xterm-screen');
      if (!rows || !span || !screenEl) return null;
      const cell = span.getBoundingClientRect().width / (span.textContent.length || 1);
      return { rows: rows.length, cols: Math.floor(screenEl.getBoundingClientRect().width / cell) };
    },

    focusTerminal() {
      const ta = activeXterm()?.querySelector('.xterm-helper-textarea');
      if (!ta) throw new Error('no terminal on screen');
      ta.focus();
      return true;
    },

    /** Presses a key on whatever has focus, or on the terminal on screen. */
    key(spec, target) {
      const init = parseKey(spec);
      const el = target ?? (document.activeElement && document.activeElement !== document.body
        ? document.activeElement
        : activeXterm()?.querySelector('.xterm-helper-textarea') ?? document.body);
      if (!el) throw new Error(`nothing to press ${spec} on`);
      const down = keyEvent('keydown', init);
      const handled = !el.dispatchEvent(down);
      // A script's key press has no default action: Enter or Space on a
      // focused button does not press it, as a real key would.
      if (!handled && (init.key === 'Enter' || init.key === ' ') && !init.ctrlKey && !init.altKey &&
          (el instanceof HTMLButtonElement || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'menuitem')) {
        el.click();
      }
      el.dispatchEvent(keyEvent('keyup', init));
      return { handled, target: el.className || el.tagName };
    },

    /** Types text into the terminal on screen one character at a time, the
     *  way a keyboard does: a keydown xterm leaves alone, then a keypress. */
    type(text) {
      const ta = activeXterm()?.querySelector('.xterm-helper-textarea');
      if (!ta) throw new Error('no terminal on screen');
      ta.focus();
      for (const ch of text) {
        const cp = ch.codePointAt(0);
        const init = { key: ch, code: '', keyCode: 0 };
        ta.dispatchEvent(keyEvent('keydown', init));
        ta.dispatchEvent(keyEvent('keypress', init, { keyCode: cp, which: cp, charCode: cp }));
        ta.dispatchEvent(keyEvent('keyup', init));
      }
      return true;
    },

    /** Types into a text box or input the way React sees typing. */
    fill(el, value) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },

    click(el) {
      mouse(el, 'pointerdown'); mouse(el, 'mousedown');
      mouse(el, 'pointerup'); mouse(el, 'mouseup'); mouse(el, 'click');
      return true;
    },
    dblclick(el) {
      e2e.click(el);
      mouse(el, 'mousedown', { detail: 2 }); mouse(el, 'mouseup', { detail: 2 });
      mouse(el, 'click', { detail: 2 }); mouse(el, 'dblclick', { detail: 2 });
      return true;
    },
    rightClick(el, at) {
      const pos = at ?? center(el);
      mouse(el, 'mousedown', { button: 2, buttons: 2, ...pos });
      mouse(el, 'mouseup', { button: 2, ...pos });
      mouse(el, 'contextmenu', { button: 2, ...pos });
      return true;
    },

    /** Drags across terminal cells, 0-based and inclusive, as a mouse
     *  selection would. xterm rounds a selection's ends to the nearest cell
     *  border, so the drag starts just inside the first cell's left edge and
     *  ends just past the last cell's right edge. */
    selectCells(fromCol, fromRow, toCol, toRow) {
      const term = activeXterm();
      const screenEl = term.querySelector('.xterm-screen');
      const box = screenEl.getBoundingClientRect();
      const rows = term.querySelectorAll('.xterm-rows > div').length;
      const size = e2e.termSize();
      const cw = box.width / size.cols, ch = box.height / rows;
      const at = (x, r) => ({ clientX: box.left + x * cw, clientY: box.top + (r + 0.5) * ch });
      const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
      screenEl.dispatchEvent(new MouseEvent('mousedown', { ...opts, buttons: 1, detail: 1, ...at(fromCol + 0.1, fromRow) }));
      document.dispatchEvent(new MouseEvent('mousemove', { ...opts, buttons: 1, ...at(toCol + 1.1, toRow) }));
      document.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0, ...at(toCol + 1.1, toRow) }));
      return true;
    },

    /** Elements whose own text is `text` (exact, trimmed), visible ones first. */
    byText(text, selector = '*') {
      return [...document.querySelectorAll(selector)]
        .filter((el) => el.textContent.trim() === text)
        .sort((a, b) => Number(visible(b)) - Number(visible(a)));
    },

    /** The tab headers, left to right. */
    tabs() {
      return [...document.querySelectorAll('[data-tab-status]')].map((el) => ({
        title: el.querySelector('span[title="Double-click to rename"]')?.textContent ?? '',
        status: el.dataset.tabStatus,
        active: el.dataset.tabActive === 'true',
      }));
    },
    tabEl(title) {
      return [...document.querySelectorAll('[data-tab-status]')]
        .find((el) => el.querySelector('span[title="Double-click to rename"]')?.textContent === title) ?? null;
    },

    dialogs() {
      return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
        .filter(visible)
        .map((d) => d.innerText.replace(/\s+/g, ' ').trim());
    },

    /** After a failed test: close whatever it left open (a dialog, a menu),
     *  so the next test starts from the terminal. */
    dismissAll() {
      for (const d of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
        const cancel = [...d.querySelectorAll('button')].find((b) => /^(cancel|close)$/i.test(b.textContent.trim()));
        if (cancel) cancel.click();
      }
      // Escape closes menus, but in the terminal it would go to the device.
      const el = document.activeElement;
      if (el && !el.classList.contains('xterm-helper-textarea')) {
        el.dispatchEvent(keyEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27 }));
      }
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      return true;
    },

    invoke(cmd, args) {
      return window.__TAURI_INTERNALS__.invoke(cmd, args);
    },
  };

  window.__e2e = e2e;
  return true;
}
