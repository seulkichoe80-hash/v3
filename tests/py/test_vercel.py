import json, os, sys, unittest
from datetime import datetime, timezone
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from server.kma import KmaClient, mock_fetch
from server.web import handle_api

CONFIG = json.load(open(os.path.join(ROOT, 'config.json'), encoding='utf-8'))
KEY = 'SECRET-KMA-KEY-123'
now = lambda: datetime(2026, 11, 8, 5, 30, tzinfo=timezone.utc)

def call(method, path, headers=None, body=b'', code='', log_path=None):
    c = KmaClient(KEY, CONFIG, fetch=mock_fetch, now=now)
    return handle_api(method, path, headers or {}, body, client=c, config=CONFIG, kakao_js_key='KAKAO', access_code=code, log_path=log_path)

class T(unittest.TestCase):
    def test_client_config_flags_code_and_hides_key(self):
        st, h, b = call('GET', '/api/client-config', code='1234')
        self.assertEqual(st, 200); d = json.loads(b)
        self.assertTrue(d['needsCode']); self.assertNotIn(KEY, b.decode())
        self.assertFalse(json.loads(call('GET', '/api/client-config')[2])['needsCode'])

    def test_access_code(self):
        st, h, _ = call('GET', '/api/asos', code='1234'); self.assertEqual(st, 401); self.assertIn('no-store', h['Cache-Control'])
        st, _, _ = call('GET', '/api/asos', {'X-Access-Code': '9999'}, code='1234'); self.assertEqual(st, 401)
        st, h, b = call('GET', '/api/asos', {'X-Access-Code': '1234'}, code='1234'); self.assertEqual(st, 200)
        self.assertGreater(len(json.loads(b)['items']), 0)
        self.assertEqual(call('GET', '/api/asos')[0], 200)          # 코드 미설정 → 개방

    def test_shared_cache_header(self):
        _, h, _ = call('GET', '/api/metar'); self.assertIn('s-maxage=', h['Cache-Control'])
        _, h, _ = call('GET', '/api/client-config'); self.assertIn('no-store', h['Cache-Control'])

    def test_unknown_api_404(self):
        self.assertEqual(call('GET', '/api/../../etc/passwd')[0], 404)

    def test_log_without_disk(self):
        st, _, b = call('POST', '/api/log', {'Content-Type': 'application/json'}, b'{"from":"a","to":"b","overall":"GREEN","distanceKm":1}')
        self.assertEqual(st, 200); self.assertFalse(json.loads(b)['stored'])

    def test_vercel_entry_importable(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('vindex', os.path.join(ROOT, 'api', 'index.py'))
        m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
        self.assertTrue(hasattr(m, 'handler'))

if __name__ == '__main__': unittest.main()

class Raw(unittest.TestCase):
    def test_raw_masks_key_and_limits(self):
        st, h, b = call('GET', '/api/raw/warn')
        self.assertEqual(st, 200); s = b.decode()
        self.assertNotIn(KEY, s); self.assertIn('REG_UP', s); self.assertLessEqual(len(json.loads(s)['body']), 4000)
    def test_raw_requires_code(self):
        self.assertEqual(call('GET', '/api/raw/warn', code='1234')[0], 401)
    def test_raw_unknown(self):
        self.assertEqual(call('GET', '/api/raw/zzz')[0], 404)
