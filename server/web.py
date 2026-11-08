"""HTTP 처리. handle_api()는 로컬 서버(run.py)와 Vercel 함수(api/index.py)가 함께 쓴다."""
import csv, hmac, json, os
from datetime import datetime
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from . import parsers as P

KINDS = ('metar', 'taf', 'asos', 'aws', 'warn', 'lightning', 'sigwx')
TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
         '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml'}
SHARED_CACHE_SEC = {'sigwx': 600, 'metar': 180, 'taf': 300, 'asos': 180, 'aws': 60, 'warn': 120, 'lightning': 60}
JSON_T = 'application/json; charset=utf-8'

# 'unsafe-eval'은 카카오맵 SDK가 내부에서 문자열 실행을 써서 필요(2026-11-08 실사이트 확인). 'unsafe-inline'은 스크립트에 허용하지 않는다.
# 보안 헤더(vercel.json의 headers와 같아야 하며 시험으로 확인한다). CSP는 감시 모드(Report-Only)로 실사이트 위반 0건을 확인한 뒤 강제 모드로 전환했다(2026-11-08).
CSP_HEADER_NAME = 'Content-Security-Policy'
CSP = ("default-src 'self'; "
       "script-src 'self' 'unsafe-eval' https://dapi.kakao.com https://t1.kakaocdn.net https://t1.daumcdn.net; "
       "style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob: https:; "
       "connect-src 'self' https://dapi.kakao.com; "
       "font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'")
SECURITY_HEADERS = {
    CSP_HEADER_NAME: CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=(), usb=()',
}

# 접속코드 오입력 제한: 같은 IP에서 RL_WINDOW초 안에 RL_MAX_FAILS번 틀리면 그 시간 동안 잠금(맞는 코드도 거부)
RL_MAX_FAILS = 10
RL_WINDOW = 600
_FALLBACK_RL = None


def _json(status, obj, cache='no-store', extra=None):
    h = {'Content-Type': JSON_T, 'Cache-Control': cache, **SECURITY_HEADERS, **(extra or {})}
    return status, h, json.dumps(obj, ensure_ascii=False).encode('utf-8')


def _hdr(headers, name):
    for k, v in (headers or {}).items():
        if k.lower() == name.lower():
            return v
    return None


def _same_origin(headers):
    from urllib.parse import urlparse
    origin = _hdr(headers, 'Origin')
    if not origin:
        return True      # 서버끼리 호출·직접 접속 등 Origin이 없는 요청
    host = _hdr(headers, 'X-Forwarded-Host') or _hdr(headers, 'Host') or ''
    return urlparse(origin).netloc == host.split(',')[0].strip()


def handle_api(method, path, headers, body, *, client, config, kakao_js_key, access_code='', log_path=None, notam_store=None, client_ip=''):
    """→ (status, headers, body bytes). access_code가 비어 있으면 접속코드 없이 개방."""
    from urllib.parse import parse_qs
    path, _, qs = path.partition('?')
    path_q = parse_qs(qs)
    if method == 'GET' and path == '/api/client-config':
        return _json(200, {'kakaoJsKey': kakao_js_key, 'config': config, 'needsCode': bool(access_code),
                           'serverLog': bool(log_path), 'notamShared': notam_store is not None,
                           'version': (os.environ.get('VERCEL_GIT_COMMIT_SHA') or 'local')[:7]})
    if method not in ('GET', 'HEAD') and not _same_origin(headers):
        return _json(403, {'error': '허용되지 않은 출처의 요청입니다'})
    if access_code:
        global _FALLBACK_RL
        if _FALLBACK_RL is None:
            from .store import MemoryStore
            _FALLBACK_RL = MemoryStore()
        rl = notam_store if hasattr(notam_store, 'rl_hit') else _FALLBACK_RL
        rkey = 'heliwx:rl:' + (client_ip or 'unknown')
        try:
            locked = rl.rl_count(rkey) >= RL_MAX_FAILS
        except Exception:
            locked = False                      # 저장소 장애 시에는 잠금 확인을 건너뜀(정상 사용자 차단 방지)
        if locked:
            return _json(429, {'error': f'접속코드 오입력 횟수를 초과했습니다. {RL_WINDOW // 60}분 뒤에 다시 시도하세요'}, extra={'Retry-After': str(RL_WINDOW)})
        given = _hdr(headers, 'X-Access-Code') or _hdr(headers, 'X-Access-Token') or ''
        if not given and path.startswith('/api/raw/'):   # 점검 주소는 브라우저에서 ?code= 로도 열 수 있게
            given = path_q.get('code', [''])[0]
        if not hmac.compare_digest(given.encode('utf-8'), access_code.encode('utf-8')):
            body = {'error': '접속코드가 필요합니다'}
            try:
                body['attemptsLeft'] = max(0, RL_MAX_FAILS - int(rl.rl_hit(rkey, RL_WINDOW)))
            except Exception:
                pass
            return _json(401, body)
    if path == '/api/notams' or path.startswith('/api/notams/'):
        return _notams(method, path, body, notam_store)
    if path == '/api/places' or path.startswith('/api/places/'):
        return _places(method, path, body, notam_store)
    if method == 'GET' and path.startswith('/api/raw/'):
        from .kma import ENDPOINTS
        kind = path[len('/api/raw/'):]
        if kind in ENDPOINTS:
            try:
                limit = max(100, min(200000, int(path_q.get('limit', ['4000'])[0])))
            except ValueError:
                limit = 4000
            return _json(200, client.raw(kind, limit=limit, icao=path_q.get('icao', ['RKSS'])[0][:4], help=path_q.get('help', ['0'])[0] == '1',
                                          summary=path_q.get('summary', ['0'])[0] == '1'))
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


def _places(method, path, body, store):
    if method == 'GET' and path == '/api/places':
        if store is None:
            return _json(200, {'shared': False, 'places': []})
        try:
            return _json(200, {'shared': True, 'places': store.places_list()})
        except Exception as e:
            return _json(502, {'error': f'공유 저장소 오류: {type(e).__name__}'})
    if store is None:
        return _json(503, {'error': '공유 저장소가 연결되지 않았습니다'})
    try:
        if method == 'POST' and path == '/api/places':
            try:
                d = json.loads(body[:5000] or b'{}')
            except ValueError:
                return _json(400, {'error': 'JSON 형식 오류'})
            return _json(200, {'ok': True, 'place': store.places_save(d)})
        if method == 'DELETE' and path.startswith('/api/places/'):
            store.places_delete(path.rsplit('/', 1)[1])
            return _json(200, {'ok': True})
        return _json(405, {'error': 'method'})
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
            for k, v in {**SECURITY_HEADERS, **headers}.items():
                self.send_header(k, v)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _api(self, method):
            n = int(self.headers.get('Content-Length', 0) or 0)
            body = self.rfile.read(min(n, 30000)) if n else b''
            self._send(*handle_api(method, self.path, dict(self.headers), body, client=client, config=config,
                                   kakao_js_key=kakao_js_key, access_code=access_code, log_path=log_path, notam_store=notam_store,
                                   client_ip=self.client_address[0]))

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
