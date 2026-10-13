// Runs JavaScript in the app's own page, through WebKitGTK's remote
// inspector. The app is started with WEBKIT_INSPECTOR_HTTP_SERVER set; the
// inspector then serves a list of pages over HTTP and each page over a
// WebSocket. Nothing to install: no WebDriver, no browser automation package.
//
// WebKit's protocol puts every command for the page inside a Target message:
// a plain Runtime.evaluate on the socket is refused with "'Runtime' domain
// was not found". And Runtime.evaluate cannot wait for a promise, so an async
// expression is evaluated first and then awaited with Runtime.awaitPromise.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Inspector {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.pageTarget = null;
    this.targetWaiters = [];
    ws.onmessage = (m) => this.onMessage(JSON.parse(String(m.data)));
    ws.onclose = () => {
      for (const { reject } of this.pending.values()) reject(new Error('the app closed the inspector connection'));
      this.pending.clear();
    };
  }

  /** Waits for the app's inspector to list a page, then connects to it. */
  static async connect(port, { timeoutMs = 30000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let path = null;
    while (!path) {
      try {
        const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
        path = html.match(/\/socket\/\d+\/\d+\/WebPage/)?.[0] ?? null;
      } catch { /* not listening yet */ }
      if (!path) {
        if (Date.now() > deadline) throw new Error(`no page on the inspector at port ${port} after ${timeoutMs} ms`);
        await sleep(200);
      }
    }
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('could not open the inspector socket'));
    });
    const inspector = new Inspector(ws);
    await inspector.page(timeoutMs);
    return inspector;
  }

  onMessage(msg) {
    if (msg.method === 'Target.targetCreated' && msg.params.targetInfo.type === 'page') {
      // A reload creates a new page target; commands go to the newest.
      this.pageTarget = msg.params.targetInfo.targetId;
      for (const w of this.targetWaiters.splice(0)) w(this.pageTarget);
      return;
    }
    if (msg.method === 'Target.targetDestroyed' && msg.params.targetId === this.pageTarget) {
      this.pageTarget = null;
      return;
    }
    if (msg.method === 'Target.dispatchMessageFromTarget') {
      const inner = JSON.parse(msg.params.message);
      const waiter = inner.id !== undefined && this.pending.get(inner.id);
      if (waiter) {
        this.pending.delete(inner.id);
        if (inner.error) waiter.reject(new Error(inner.error.message));
        else waiter.resolve(inner.result);
      }
    }
  }

  page(timeoutMs = 30000) {
    if (this.pageTarget) return Promise.resolve(this.pageTarget);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the inspector never announced the page')), timeoutMs);
      this.targetWaiters.push((t) => { clearTimeout(timer); resolve(t); });
    });
  }

  async send(method, params = {}) {
    const targetId = await this.page();
    const id = this.nextId++;
    const reply = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.ws.send(JSON.stringify({
      id: this.nextId++,
      method: 'Target.sendMessageToTarget',
      params: { targetId, message: JSON.stringify({ id, method, params }) },
    }));
    return reply;
  }

  /** Evaluates an expression in the page. A promise is awaited; the value
   *  comes back through JSON, so return plain data. */
  async evaluate(expression, { timeoutMs = 15000 } = {}) {
    const wrapped = `(async () => { const v = await (${expression}); return JSON.stringify(v === undefined ? null : v); })()`;
    const run = async () => {
      const first = await this.send('Runtime.evaluate', {
        expression: wrapped,
        returnByValue: false,
        emulateUserGesture: true,
      });
      if (first.wasThrown) throw new Error(first.result.description ?? 'page threw');
      const settled = await this.send('Runtime.awaitPromise', {
        promiseObjectId: first.result.objectId,
        returnByValue: true,
      });
      if (settled.wasThrown) throw new Error(settled.result.description ?? settled.result.value ?? 'page threw');
      return JSON.parse(settled.result.value);
    };
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the page did not answer within ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      return await Promise.race([run(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  close() {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

/**
 * The same, for WebView2 on Windows: Chromium's DevTools protocol. The app
 * is started with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS carrying
 * --remote-debugging-port; the page is listed at /json/list and spoken to
 * directly (no Target wrapping), and Runtime.evaluate can await a promise.
 */
export class CdpInspector {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      const waiter = msg.id !== undefined && this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    };
    ws.onclose = () => {
      for (const { reject } of this.pending.values()) reject(new Error('the app closed the DevTools connection'));
      this.pending.clear();
    };
  }

  static async connect(port, { timeoutMs = 30000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let url = null;
    while (!url) {
      try {
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        // The app's own page, not a DevTools or service-worker target.
        url = pages.find((p) => p.type === 'page' && !p.url.startsWith('devtools:'))?.webSocketDebuggerUrl ?? null;
      } catch { /* not listening yet */ }
      if (!url) {
        if (Date.now() > deadline) throw new Error(`no page on DevTools port ${port} after ${timeoutMs} ms`);
        await sleep(200);
      }
    }
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('could not open the DevTools socket'));
    });
    return new CdpInspector(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const reply = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.ws.send(JSON.stringify({ id, method, params }));
    return reply;
  }

  async evaluate(expression, { timeoutMs = 15000 } = {}) {
    const wrapped = `(async () => { const v = await (${expression}); return JSON.stringify(v === undefined ? null : v); })()`;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the page did not answer within ${timeoutMs} ms`)), timeoutMs);
    });
    const run = async () => {
      const r = await this.send('Runtime.evaluate', {
        expression: wrapped, awaitPromise: true, returnByValue: true, userGesture: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'page threw');
      }
      return JSON.parse(r.result.value);
    };
    try {
      return await Promise.race([run(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  close() {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}
