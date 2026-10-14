// Saved sessions: new from the "+" above the list, from the tab bar's "+",
// and from a folder's "New session here"; changed in Session Settings
// (from the menu and the pencil); renamed; and never written over another
// session by accident. Every check reads what was saved back from PuTTY's
// own store (list_putty_sessions), not just the list on screen.
import assert from 'node:assert/strict';
import { startConsole, writePuttySession, waitUntil } from '../lib/fixtures.mjs';

export const title = 'Saved sessions: create, edit, rename';

export async function setup({ home }) {
  // Two consoles, so a changed port can be seen by which one gets the call.
  const a = await startConsole({ name: 'RA' });
  const b = await startConsole({ name: 'RB' });
  writePuttySession(home, 'Edge R6', {
    HostName: '127.0.0.1', PortNumber: a.port, Protocol: 'telnet', PlinkyFolder: 'Lab',
  });
  return { state: { a, b }, cleanup: async () => { await a.stop(); await b.stop(); } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What PuTTY's store holds for `name`, or undefined. */
async function stored(app, name) {
  const list = await app.invoke('list_putty_sessions');
  return list.find((s) => s.name === name);
}

async function storedNames(app) {
  return (await app.invoke('list_putty_sessions')).map((s) => s.name).sort();
}

/** Opens the session editor by clicking `selector`'s element (or the
 *  returned one), then waits for the dialog. */
async function openEditor(app, how) {
  await app.run(how);
  await app.waitFor(() => !!document.getElementById('new-session-modal-host-name-or-ip-address'), [], { what: 'the session editor' });
}

/** Fills the editor's fields: protocol first (it may change the port). */
async function fillEditor(app, fields) {
  await app.run((e, f) => {
    const byId = (id) => document.getElementById(id);
    if (f.protocol) {
      const sel = byId('new-session-modal-connection-protocol');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, f.protocol);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  }, fields);
  await sleep(50);
  await app.run((e, f) => {
    const set = (id, v) => { if (v !== undefined) e.fill(document.getElementById(id), String(v)); };
    set('new-session-modal-host-name-or-ip-address', f.host);
    set('new-session-modal-port', f.port);
    set('new-session-modal-session-name', f.name);
    set('new-session-modal-folder-category', f.folder);
    set('new-session-modal-tags-comma-separated', f.tags);
    return true;
  }, fields);
  await sleep(50);
}

/** The editor's own field values, as it shows them. */
async function editorValues(app) {
  return app.run(() => {
    const v = (id) => document.getElementById(id)?.value;
    return {
      protocol: v('new-session-modal-connection-protocol'),
      host: v('new-session-modal-host-name-or-ip-address'),
      port: v('new-session-modal-port'),
      name: v('new-session-modal-session-name'),
      folder: v('new-session-modal-folder-category'),
      tags: v('new-session-modal-tags-comma-separated'),
    };
  });
}

async function save(app) {
  await app.run((e) => {
    const b = [...document.querySelectorAll('button[type="submit"]')].find((x) => /Save (session|Changes)/.test(x.textContent));
    if (!b) throw new Error('no Save button');
    return e.click(b);
  });
}

/** Escape where a user's focus is: in the dialog, not the terminal. */
async function escapeEditor(app) {
  await app.run((e) => e.key('Escape', document.getElementById('new-session-modal-session-name')));
  await sleep(200);
}

async function editorOpen(app) {
  return app.run(() => !!document.getElementById('new-session-modal-host-name-or-ip-address'));
}

async function waitForRow(app, name, timeoutMs = 3000) {
  await app.waitFor((e, n) => !!document.querySelector(`[data-session-row="${CSS.escape(n)}"]`), [name], { what: `"${name}" in the session list`, timeoutMs });
}

/** The folder a session's row is listed under, from the tree on screen. */
async function folderOnScreen(app, name) {
  return app.run((e, n) => {
    const row = document.querySelector(`[data-session-row="${CSS.escape(n)}"]`);
    if (!row) return null;
    // A folder's rows follow its header inside the same group.
    let group = row.parentElement;
    while (group && !group.querySelector(':scope > [data-folder-path]')) group = group.parentElement;
    return group?.querySelector(':scope > [data-folder-path]')?.dataset.folderPath ?? null;
  }, name);
}

async function menuItem(app, menuLabel, itemText) {
  await app.waitFor((e, m, t) => {
    const menu = document.querySelector(`[role="menu"][aria-label="${CSS.escape(m)}"]`);
    const b = menu && [...menu.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(t));
    if (b) window.__e2e.click(b);
    return !!b;
  }, [menuLabel, itemText], { what: `"${itemText}" in the ${menuLabel} menu` });
}

async function connectFromList(app, name) {
  await app.run((e, n) => {
    const row = document.querySelector(`[data-session-row="${CSS.escape(n)}"]`);
    row.scrollIntoView();
    return window.__e2e.dblclick(row);
  }, name);
}

export const tests = [
  ['the "+" above the session list saves a new session that opens', async ({ app, a }) => {
    await waitForRow(app, 'Edge R6', 5000);
    await openEditor(app, (e) => e.click(document.querySelector('button[aria-label="New session"]')));
    await fillEditor(app, { protocol: 'Telnet', host: '127.0.0.1', port: a.port, name: 'Branch R1' });
    await save(app);
    await waitForRow(app, 'Branch R1');
    assert.equal(await editorOpen(app), false, 'the editor closes on save');
    const s = await stored(app, 'Branch R1');
    assert.ok(s, 'saved in PuTTY\'s store');
    assert.deepEqual(
      { host: s.host_name, port: s.port_number, protocol: s.protocol.toLowerCase() },
      { host: '127.0.0.1', port: a.port, protocol: 'telnet' },
    );
    const before = a.connections;
    await connectFromList(app, 'Branch R1');
    await app.waitForTab('Branch R1', 'live', { timeoutMs: 5000 });
    await waitUntil(() => a.connections === before + 1, { what: 'Branch R1 to reach its console', timeoutMs: 5000 });
  }],

  ['the tab bar\'s "+" saves a new session too, into the folder typed', async ({ app, b }) => {
    await openEditor(app, async (e) => {
      e.click(document.querySelector('button[aria-label="Open a tab"]'));
      await new Promise((r) => setTimeout(r, 100));
      const item = [...document.querySelectorAll('button, [role="menuitem"]')].find((x) => x.textContent.trim().startsWith('New session'));
      if (!item) throw new Error('no "New session…" in the tab menu');
      return e.click(item);
    });
    await fillEditor(app, { protocol: 'Telnet', host: '127.0.0.1', port: b.port, name: 'Branch R2', folder: 'WAN' });
    await save(app);
    await waitForRow(app, 'Branch R2');
    const s = await stored(app, 'Branch R2');
    assert.equal(s?.extra?.PlinkyFolder, 'WAN', 'the folder is saved with the session');
    assert.equal(await folderOnScreen(app, 'Branch R2'), 'WAN', 'and the list shows it in that folder');
  }],

  ['a folder\'s "New session here" starts in that folder and saves there', async ({ app, a }) => {
    await app.run((e) => {
      const folder = document.querySelector('[data-folder-path="Lab"]');
      folder.scrollIntoView();
      return e.rightClick(folder);
    });
    await menuItem(app, 'Folder Lab', 'New session here');
    await app.waitFor(() => !!document.getElementById('new-session-modal-host-name-or-ip-address'), [], { what: 'the session editor' });
    assert.equal((await editorValues(app)).folder, 'Lab', 'the folder is filled in');
    await fillEditor(app, { protocol: 'Telnet', host: '127.0.0.1', port: a.port, name: 'Lab R3' });
    await save(app);
    await waitForRow(app, 'Lab R3');
    assert.equal((await stored(app, 'Lab R3'))?.extra?.PlinkyFolder, 'Lab');
    assert.equal(await folderOnScreen(app, 'Lab R3'), 'Lab');
  }],

  ['Change Session Settings shows the saved values and saves the change in place', async ({ app, a, b }) => {
    await app.run((e) => {
      const row = document.querySelector('[data-session-row="Edge R6"]');
      row.scrollIntoView();
      return e.rightClick(row);
    });
    await menuItem(app, 'Session Edge R6', 'Change Session Settings');
    await app.waitFor(() => !!document.getElementById('new-session-modal-host-name-or-ip-address'), [], { what: 'the session editor' });
    const shown = await editorValues(app);
    assert.deepEqual(
      { protocol: shown.protocol, host: shown.host, port: shown.port, name: shown.name, folder: shown.folder },
      { protocol: 'Telnet', host: '127.0.0.1', port: String(a.port), name: 'Edge R6', folder: 'Lab' },
    );
    const namesBefore = await storedNames(app);
    await fillEditor(app, { port: b.port, tags: 'core, lab' });
    await save(app);
    await waitUntil(async () => (await stored(app, 'Edge R6'))?.port_number === b.port, { what: 'the new port saved', timeoutMs: 3000 });
    const s = await stored(app, 'Edge R6');
    assert.equal(s.extra?.PlinkyTags, 'core,lab');
    assert.equal(s.extra?.PlinkyFolder, 'Lab', 'the folder is kept');
    assert.deepEqual(await storedNames(app), namesBefore, 'no session added or lost');
    // It connects where it now says.
    const before = b.connections;
    await connectFromList(app, 'Edge R6');
    await waitUntil(() => b.connections === before + 1, { what: 'Edge R6 to reach its new port', timeoutMs: 5000 });
  }],

  ['the pencil on a row opens the same settings', async ({ app, b }) => {
    await app.run((e) => {
      const btn = document.querySelector('button[aria-label="Edit Edge R6"]');
      btn.scrollIntoView();
      return e.click(btn);
    });
    await app.waitFor(() => !!document.getElementById('new-session-modal-host-name-or-ip-address'), [], { what: 'the session editor' });
    const shown = await editorValues(app);
    assert.deepEqual({ name: shown.name, port: shown.port, tags: shown.tags }, { name: 'Edge R6', port: String(b.port), tags: 'core, lab' });
    await escapeEditor(app);
    assert.equal(await editorOpen(app), false, 'Escape closes it');
  }],

  ['a new name in Session Settings saves a copy under it and keeps the original, as it says', async ({ app }) => {
    await app.run((e) => e.click(document.querySelector('button[aria-label="Edit Edge R6"]')));
    await app.waitFor(() => !!document.getElementById('new-session-modal-host-name-or-ip-address'), [], { what: 'the session editor' });
    await fillEditor(app, { name: 'Edge R6b' });
    const note = await app.run(() => document.querySelector('[role="dialog"]')?.innerText.includes('Changing the name saves a new session'));
    assert.ok(note, 'the editor says what a new name does');
    await save(app);
    await waitForRow(app, 'Edge R6b');
    const [orig, copy] = [await stored(app, 'Edge R6'), await stored(app, 'Edge R6b')];
    assert.ok(orig && copy, 'both are saved');
    assert.deepEqual(
      { host: copy.host_name, port: copy.port_number, folder: copy.extra?.PlinkyFolder, tags: copy.extra?.PlinkyTags },
      { host: orig.host_name, port: orig.port_number, folder: orig.extra?.PlinkyFolder, tags: orig.extra?.PlinkyTags },
      'the copy has the same settings',
    );
  }],

  ['a new session with a name already saved is refused, and that session kept', async ({ app, a }) => {
    // Saving wrote over it without a word: "Branch R2" got this one's host.
    const before = await stored(app, 'Branch R2');
    await openEditor(app, (e) => e.click(document.querySelector('button[aria-label="New session"]')));
    // Any case: Windows keeps sessions in the registry, where case is one key.
    await fillEditor(app, { protocol: 'Telnet', host: '192.0.2.99', port: a.port, name: 'branch r2' });
    await save(app);
    await sleep(400);
    const alert = await app.run(() => document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? '');
    assert.match(alert, /"Branch R2" is already saved/);
    assert.equal(await editorOpen(app), true, 'the editor stays open to choose another name');
    assert.equal((await stored(app, 'Branch R2')).host_name, before.host_name, 'the saved one is untouched');
    // Another name saves.
    await fillEditor(app, { name: 'Branch R4' });
    await save(app);
    await waitForRow(app, 'Branch R4');
    assert.equal((await stored(app, 'Branch R4')).host_name, '192.0.2.99');
  }],

  ['a rename onto another session\'s name is refused, and that session kept', async ({ app }) => {
    const before = await stored(app, 'Branch R1');
    await app.run((e) => e.click(document.querySelector('button[aria-label="Edit Lab R3"]')));
    await app.waitFor(() => !!document.getElementById('new-session-modal-host-name-or-ip-address'), [], { what: 'the session editor' });
    await fillEditor(app, { name: 'Branch R1', host: '192.0.2.77' });
    await save(app);
    await sleep(400);
    const alert = await app.run(() => document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? '');
    assert.match(alert, /"Branch R1" is already saved/);
    assert.equal((await stored(app, 'Branch R1')).host_name, before.host_name, 'the saved one is untouched');
    await escapeEditor(app);
    assert.equal((await stored(app, 'Lab R3')).host_name, '127.0.0.1', 'and the one being edited unchanged');
  }],

  ['saving a session under its own name is not a clash', async ({ app }) => {
    await app.run((e) => e.click(document.querySelector('button[aria-label="Edit Lab R3"]')));
    await app.waitFor(() => !!document.getElementById('new-session-modal-host-name-or-ip-address'), [], { what: 'the session editor' });
    await fillEditor(app, { tags: 'branch' });
    await save(app);
    await sleep(400);
    assert.equal(await editorOpen(app), false);
    assert.equal((await stored(app, 'Lab R3')).extra?.PlinkyTags, 'branch');
  }],

  ['a session needs a host: Save without one keeps the editor open and saves nothing', async ({ app }) => {
    const before = await storedNames(app);
    await openEditor(app, (e) => e.click(document.querySelector('button[aria-label="New session"]')));
    await fillEditor(app, { protocol: 'Telnet', name: 'No Host' });
    await save(app);
    await sleep(400);
    assert.equal(await editorOpen(app), true, 'the editor stays open');
    await escapeEditor(app);
    assert.deepEqual(await storedNames(app), before, 'nothing saved');
  }],
];
