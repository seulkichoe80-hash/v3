"""HTTP 처리. handle_api()는 로컬 서버(run.py)와 Vercel 함수(api/index.py)가 함께 쓴다."""
import csv, hmac, json, os
from datetime import datetime
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from . import parsers as P

KINDS = ('metar', 'taf', 'asos', 'aws', 'warn', 'lightning')
TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
         '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml'}
SHARED_CACHE_SEC = {'metar': 180, 'taf': 300, 'asos': 180, 'aws': 60, 'warn': 120, 'lightning': 60}
JSON_T = 'application/json; charset=utf-8'


def _json(status, obj, cache='no-store'):
    return status, {'Content-Type': JSON_T, 'Cache-Control': cache}, json.dumps(obj, ensure_ascii=False).encode('utf-8')


def _hdr(headers, name):
    for k, v in (headers or {}).items():
        if k.lower() == name.lower():
            return v
    return None


def handle_api(method, path, headers, body, *, client, config, kakao_js_key, access_code='', log_path=None, notam_store=None):
    """→ (status, headers, body bytes). access_code가 비어 있으면 접속코드 없이 개방."""
    from urllib.parse import parse_qs
    path, _, qs = path.partition('?')
    path_q = parse_qs(qs)
    if method == 'GET' and path == '/api/client-config':
        return _json(200, {'kakaoJsKey': kakao_js_key, 'config': config, 'needsCode': bool(access_code),
                           'serverLog': bool(log_path)})
    if access_code:
        given = _hdr(headers, 'X-Access-Code') or ''
        if not hmac.compare_digest(given.encode('utf-8'), access_code.encode('utf-8')):
            return _json(401, {'error': '접속코드가 필요합니다'})
    if path == '/api/notams' or path.startswith('/api/notams/'):
        return _notams(method, path, body, notam_store)
    if method == 'GET' and path.startswith('/api/raw/'):
        from .kma import ENDPOINTS
        kind = path[len('/api/raw/'):]
        if kind in ENDPOINTS:
            try:
                limit = max(100, min(200000, int(path_q.get('limit', ['4000'])[0])))
            except ValueError:
                limit = 4000
            return _json(200, client.raw(kind, limit=limit, icao=path_q.get('icao', ['RKSS'])[0][:4]))
        return _json(404, {'error': 'unknown api'})
    if method == 'GET' and path.startswith('/api/'):
        kind = path[5:]
        if kind in KINDS:
            r = client.get(kind)
            cache = 'no-store' if r.get('error') else f'public, max-age=0, s-maxage={SHARED_CACHE_SEC[kind]}'
            return _json(200, r, cache)
        return _json(404, {'error': 'unknown api'})
    if method == 'POST' and path == '/api/log':
        if not log_path:
            return _json(200, {'ok': True, 'stored': False})
        try:
            d = json.loads(body[:10000] or b'{}')
            os.makedirs(os.path.dirname(log_path), exist_ok=True)
            new = not os.path.exists(log_path)
            with open(log_path, 'a', newline='', encoding='utf-8-sig' if new else 'utf-8') as f:
                w = csv.writer(f)
                if new:
                    w.writerow(['시각(KST)', '출발', '목적지', '거리km', '종합판정'])
                w.writerow([datetime.now(P.KST).strftime('%Y-%m-%d %H:%M'), str(d.get('from', ''))[:50],
                            str(d.get('to', ''))[:50], d.get('distanceKm', ''), str(d.get('overall', ''))[:10]])
            return _json(200, {'ok': True, 'stored': True})
        except (ValueError, OSError) as e:
            return _json(400, {'error': str(e)})
    return _json(404, {'error': 'unknown api'})


def _notams(method, path, body, store):
    if method == 'GET' and path == '/api/notams':
        if store is None:
            return _json(200, {'shared': False, 'slots': {}})
        try:
            return _json(200, {'shared': True, 'slots': {str(k): v for k, v in store.list().items()}})
        except Exception as e:
            return _json(502, {'error': f'공유 저장소 오류: {type(e).__name__}'})
    if store is None:
        return _json(503, {'error': '공유 저장소가 연결되지 않았습니다'})
    try:
        slot = int(path.rsplit('/', 1)[1])
    except ValueError:
        return _json(400, {'error': '칸 번호 오류'})
    try:
        if method == 'PUT':
            d = json.loads(body[:30000] or b'{}')
            text = d.get('text') if isinstance(d, dict) else None
            if not isinstance(text, str):
                return _json(400, {'error': 'text 필요'})
            store.save(slot, text)
        elif method == 'DELETE':
            store.delete(slot)
        else:
            return _json(405, {'error': 'method'})
        return _json(200, {'ok': True})
    except ValueError as e:
        return _json(400, {'error': str(e)})
    except Exception as e:
        return _json(502, {'error': f'공유 저장소 오류: {type(e).__name__}'})


def make_server(port, client, config, kakao_js_key, log_path, web_dir, host='127.0.0.1', access_code='', notam_store=None):
    web_dir = os.path.realpath(web_dir)

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, status, headers, body):
            self.send_response(status)
            for k, v in headers.items():
                self.send_header(k, v)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _api(self, method):
            n = int(self.headers.get('Content-Length', 0) or 0)
            body = self.rfile.read(min(n, 30000)) if n else b''
            self._send(*handle_api(method, self.path, dict(self.headers), body, client=client, config=config,
                                   kakao_js_key=kakao_js_key, access_code=access_code, log_path=log_path, notam_store=notam_store))

        def do_GET(self):
            path = self.path.split('?')[0]
            if path.startswith('/api/'):
                return self._api('GET')
            rel = 'index.html' if path in ('/', '/index.html') else path[len('/web/'):] if path.startswith('/web/') else None
            full = os.path.realpath(os.path.join(web_dir, rel)) if rel else ''
            if not rel or not full.startswith(web_dir + os.sep) or not os.path.isfile(full):
                return self._send(404, {'Content-Type': 'text/plain; charset=utf-8'}, b'not found')
            with open(full, 'rb') as f:
                self._send(200, {'Content-Type': TYPES.get(os.path.splitext(full)[1], 'application/octet-stream'),
                                 'Cache-Control': 'no-store'}, f.read())

        def do_POST(self):
            self._api('POST')

        def do_PUT(self):
            self._api('PUT')

        def do_DELETE(self):
            self._api('DELETE')

    return ThreadingHTTPServer((host, port), H)
