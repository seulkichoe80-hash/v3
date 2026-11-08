"""HTTP 서버: 정적 화면(web/) + /api/*."""
import csv, json, os
from datetime import datetime
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from . import parsers as P

KINDS = ('metar', 'taf', 'asos', 'aws', 'warn', 'lightning')
TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
         '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml'}


def make_server(port, client, config, kakao_js_key, log_path, web_dir, host='127.0.0.1'):
    web_dir = os.path.realpath(web_dir)

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body, ctype='application/json; charset=utf-8'):
            if isinstance(body, (dict, list)):
                body = json.dumps(body, ensure_ascii=False)
            if isinstance(body, str):
                body = body.encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = self.path.split('?')[0]
            if path == '/api/client-config':
                return self._send(200, {'kakaoJsKey': kakao_js_key, 'config': config})
            if path.startswith('/api/'):
                kind = path[5:]
                if kind in KINDS:
                    return self._send(200, client.get(kind))
                return self._send(404, {'error': 'unknown api'})
            rel = 'index.html' if path in ('/', '/index.html') else path[len('/web/'):] if path.startswith('/web/') else None
            if rel is None:
                return self._send(404, 'not found', 'text/plain; charset=utf-8')
            full = os.path.realpath(os.path.join(web_dir, rel))
            if not full.startswith(web_dir + os.sep) or not os.path.isfile(full):
                return self._send(404, 'not found', 'text/plain; charset=utf-8')
            with open(full, 'rb') as f:
                return self._send(200, f.read(), TYPES.get(os.path.splitext(full)[1], 'application/octet-stream'))

        def do_POST(self):
            if self.path != '/api/log':
                return self._send(404, {'error': 'unknown api'})
            try:
                n = int(self.headers.get('Content-Length', 0))
                d = json.loads(self.rfile.read(min(n, 10000)) or b'{}')
                os.makedirs(os.path.dirname(log_path), exist_ok=True)
                new = not os.path.exists(log_path)
                with open(log_path, 'a', newline='', encoding='utf-8-sig' if new else 'utf-8') as f:
                    w = csv.writer(f)
                    if new:
                        w.writerow(['시각(KST)', '출발', '목적지', '거리km', '종합판정'])
                    w.writerow([datetime.now(P.KST).strftime('%Y-%m-%d %H:%M'), str(d.get('from', ''))[:50],
                                str(d.get('to', ''))[:50], d.get('distanceKm', ''), str(d.get('overall', ''))[:10]])
                return self._send(200, {'ok': True})
            except (ValueError, OSError) as e:
                return self._send(400, {'error': str(e)})

    return ThreadingHTTPServer((host, port), H)
