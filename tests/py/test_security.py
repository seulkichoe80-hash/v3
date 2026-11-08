import json, os, sys, threading, unittest, urllib.request
from unittest import mock
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from server.kma import KmaClient, mock_fetch
from server.store import MemoryStore, UpstashStore
from server import web
from server.web import handle_api, make_server, SECURITY_HEADERS, RL_MAX_FAILS

CONFIG = json.load(open(os.path.join(ROOT, 'config.json'), encoding='utf-8'))

def req(method, path, headers=None, body=b'', code='1234', ip='1.1.1.1', store=None):
    c = KmaClient('K', CONFIG, fetch=mock_fetch)
    return handle_api(method, path, headers or {}, body, client=c, config=CONFIG, kakao_js_key='', access_code=code,
                      log_path=None, notam_store=store, client_ip=ip)

class Headers(unittest.TestCase):
    def test_required_headers(self):
        h = {k.lower(): v for k, v in SECURITY_HEADERS.items()}
        self.assertEqual(h['x-content-type-options'], 'nosniff')
        self.assertIn('strict-origin', h['referrer-policy'])
        self.assertIn('geolocation=()', h['permissions-policy'])
        csp = h.get('content-security-policy') or h.get('content-security-policy-report-only')
        for part in ("default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", 'https://dapi.kakao.com', 'https://t1.kakaocdn.net'):
            self.assertIn(part, csp)
        self.assertNotIn("'unsafe-inline'", csp.split('script-src')[1].split(';')[0])   # 스크립트에는 inline 금지

    def test_vercel_json_matches_server_constant(self):
        v = json.load(open(os.path.join(ROOT, 'vercel.json'), encoding='utf-8'))
        rule = next(r for r in v['headers'] if r['source'] == '/(.*)')
        self.assertEqual({x['key']: x['value'] for x in rule['headers']}, dict(SECURITY_HEADERS))

    def test_local_server_sends_headers(self):
        srv = make_server(0, KmaClient('K', CONFIG, fetch=mock_fetch), CONFIG, '', None, os.path.join(ROOT, 'web'))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            for p in ('/', '/web/app.js', '/api/client-config'):
                r = urllib.request.urlopen(f'http://127.0.0.1:{srv.server_address[1]}{p}')
                for k, v in SECURITY_HEADERS.items(): self.assertEqual(r.headers.get(k), v, (p, k))
        finally: srv.shutdown(); srv.server_close()

class RateLimit(unittest.TestCase):
    def test_lockout_after_failures_even_with_right_code(self):
        s = MemoryStore()
        for i in range(RL_MAX_FAILS): self.assertEqual(req('GET', '/api/asos', {'X-Access-Code': 'bad'}, store=s)[0], 401)
        st, h, b = req('GET', '/api/asos', {'X-Access-Code': '1234'}, store=s)
        self.assertEqual(st, 429); self.assertIn('Retry-After', h); self.assertIn('error', json.loads(b))
        self.assertEqual(req('GET', '/api/asos', {'X-Access-Code': '1234'}, ip='2.2.2.2', store=s)[0], 200)   # 다른 IP는 무관

    def test_few_failures_ok_and_success_not_counted(self):
        s = MemoryStore()
        for i in range(RL_MAX_FAILS - 1): req('GET', '/api/asos', {'X-Access-Code': 'bad'}, store=s)
        for i in range(30): self.assertEqual(req('GET', '/api/asos', {'X-Access-Code': '1234'}, store=s)[0], 200)

    def test_window_expires(self):
        s = MemoryStore()
        with mock.patch('server.store.time.time', return_value=1000.0):
            for i in range(RL_MAX_FAILS): req('GET', '/api/asos', {'X-Access-Code': 'bad'}, store=s)
            self.assertEqual(req('GET', '/api/asos', {'X-Access-Code': '1234'}, store=s)[0], 429)
        with mock.patch('server.store.time.time', return_value=1000.0 + 601):
            self.assertEqual(req('GET', '/api/asos', {'X-Access-Code': '1234'}, store=s)[0], 200)

    def test_works_without_store_and_no_code_no_limit(self):
        for i in range(RL_MAX_FAILS): req('GET', '/api/asos', {'X-Access-Code': 'bad'}, ip='9.9.9.9')
        self.assertEqual(req('GET', '/api/asos', {'X-Access-Code': '1234'}, ip='9.9.9.9')[0], 429)
        for i in range(30): self.assertEqual(req('GET', '/api/asos', code='', ip='8.8.8.8')[0], 200)

    def test_store_failure_fails_open(self):
        class Boom(MemoryStore):
            def rl_count(self, k): raise OSError('down')
            def rl_hit(self, k, t): raise OSError('down')
        self.assertEqual(req('GET', '/api/asos', {'X-Access-Code': '1234'}, store=Boom())[0], 200)
        self.assertEqual(req('GET', '/api/asos', {'X-Access-Code': 'bad'}, store=Boom())[0], 401)

class FakeRedis:
    def __init__(self): self.kv, self.ttl = {}, {}
    def __call__(self, url, body, headers, timeout=5):
        cmd = json.loads(body); op = cmd[0].upper()
        if op == 'GET': return json.dumps({'result': self.kv.get(cmd[1])})
        if op == 'INCR': self.kv[cmd[1]] = str(int(self.kv.get(cmd[1], '0')) + 1); return json.dumps({'result': int(self.kv[cmd[1]])})
        if op == 'EXPIRE': self.ttl[cmd[1]] = cmd[2]; return json.dumps({'result': 1})
        raise AssertionError(cmd)

class UpstashRL(unittest.TestCase):
    def test_incr_expire(self):
        r = FakeRedis(); s = UpstashStore('https://x', 'T', post=r)
        self.assertEqual(s.rl_count('k'), 0)
        self.assertEqual(s.rl_hit('k', 600), 1); self.assertEqual(s.rl_hit('k', 600), 2)
        self.assertEqual(r.ttl['k'], 600); self.assertEqual(s.rl_count('k'), 2)

class Origin(unittest.TestCase):
    def test_cross_site_write_blocked(self):
        body = b'{"text":"x"}'
        s = MemoryStore()
        st = req('PUT', '/api/notams/1', {'Host': 'app.example', 'Origin': 'https://evil.example', 'X-Access-Code': '1234'}, body, store=s)[0]
        self.assertEqual(st, 403)
        self.assertEqual(req('PUT', '/api/notams/1', {'Host': 'app.example', 'Origin': 'https://app.example', 'X-Access-Code': '1234'}, body, store=s)[0], 200)
        self.assertEqual(req('PUT', '/api/notams/1', {'Host': 'app.example', 'X-Access-Code': '1234'}, body, store=s)[0], 200)   # Origin 없음(서버 호출 등)
        self.assertEqual(req('GET', '/api/asos', {'Host': 'app.example', 'Origin': 'https://evil.example', 'X-Access-Code': '1234'})[0], 200)  # 읽기는 영향 없음
        self.assertEqual(req('PUT', '/api/notams/1', {'Host': 'app.example', 'Origin': 'https://evil.example'}, body, code='', store=s)[0], 403)  # 코드 없는 배포에서도 차단
        self.assertEqual(req('PUT', '/api/notams/1', {'Host': 'internal', 'X-Forwarded-Host': 'app.example', 'Origin': 'https://app.example', 'X-Access-Code': '1234'}, body, store=s)[0], 200)

if __name__ == '__main__': unittest.main()
