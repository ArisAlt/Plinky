"""S1 bench server: serves the bench page and xterm bundles, collects results.

Binds 127.0.0.1 only. POST /result writes the JSON body to results.json.
"""
import http.server
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
NODE_MODULES = os.path.normpath(os.path.join(HERE, '..', '..', '..', 'node_modules'))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765

FILES = {
    '/': (os.path.join(HERE, 'index.html'), 'text/html'),
    '/bench.js': (os.path.join(HERE, 'bench.js'), 'text/javascript'),
    '/xterm.js': (os.path.join(NODE_MODULES, '@xterm/xterm/lib/xterm.js'), 'text/javascript'),
    '/xterm.css': (os.path.join(NODE_MODULES, '@xterm/xterm/css/xterm.css'), 'text/css'),
    '/addon-webgl.js': (os.path.join(NODE_MODULES, '@xterm/addon-webgl/lib/addon-webgl.js'), 'text/javascript'),
    '/addon-fit.js': (os.path.join(NODE_MODULES, '@xterm/addon-fit/lib/addon-fit.js'), 'text/javascript'),
    '/worker.js': (os.path.join(HERE, 'worker.js'), 'text/javascript'),
}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split('?')[0]
        if path not in FILES:
            self.send_error(404)
            return
        fname, ctype = FILES[path]
        with open(fname, 'rb') as f:
            body = f.read()
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)
        name = 'results.json' if self.path == '/result' else 'progress.log'
        mode = 'wb' if name == 'results.json' else 'ab'
        with open(os.path.join(HERE, name), mode) as f:
            f.write(body + (b'\n' if name == 'progress.log' else b''))
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
