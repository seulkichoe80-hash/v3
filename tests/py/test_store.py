import json, os, sys, tempfile, unittest
from datetime import datetime, timezone
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from server.store import MemoryStore, FileStore, UpstashStore, store_from_env, MAX_SLOTS, MAX_TEXT
from server.kma import KmaClient, mock_fetch
from server.web import handle_api

CONFIG = json.load(open(os.path.join(ROOT, 'config.json'), encoding='utf-8'))

class Contract:
    def make(self): raise NotImplementedError
    def test_save_list_delete(self):
        s = self.make()
        self.assertEqual(s.list(), {})
        s.save(1, 'D2840/26 NOTAMN ...'); s.save(3, 'D1/26 NOTAMN')
        d = s.list(); self.assertEqual(sorted(d), [1, 3]); self.assertEqual(d[1]['text'], 'D2840/26 NOTAMN ...'); self.assertTrue(d[1]['savedAt'].endswith('Z'))
        s.delete(1); self.assertEqual(sorted(s.list()), [3])
    def test_limits(self):
        s = self.make()
        for bad in (0, MAX_SLOTS + 1, -1):
            with self.assertRaises(ValueError): s.save(bad, 'x')
        with self.assertRaises(ValueError): s.save(1, 'x' * (MAX_TEXT + 1))

class TMem(Contract, unittest.TestCase):
    def make(self): return MemoryStore()

class TFile(Contract, unittest.TestCase):
    def make(self): return FileStore(os.path.join(tempfile.mkdtemp(), 'sub', 'notams.json'))
    def test_persists(self):
        p = os.path.join(tempfile.mkdtemp(), 'n.json'); FileStore(p).save(2, 'abc')
        self.assertEqual(FileStore(p).list()[2]['text'], 'abc')

class FakeRedis:
    """Upstash REST 흉내: POST url, body=JSON 명령 배열, Bearer 토큰 확인."""
    def __init__(self): self.h = {}; self.calls = []
    def __call__(self, url, body, headers, timeout=5):
        assert headers['Authorization'] == 'Bearer TKN'
        cmd = json.loads(body); self.calls.append(cmd)
        op, key = cmd[0].upper(), cmd[1]
        if op == 'HSET': self.h[cmd[2]] = cmd[3]; return json.dumps({'result': 1})
        if op == 'HGETALL':
            flat = []
            for k, v in self.h.items(): flat += [k, v]
            return json.dumps({'result': flat})
        if op == 'HDEL': self.h.pop(cmd[2], None); return json.dumps({'result': 1})
        raise AssertionError(cmd)

class TUpstash(Contract, unittest.TestCase):
    def make(self): return UpstashStore('https://x.upstash.io', 'TKN', post=FakeRedis())

class TEnv(unittest.TestCase):
    def test_env_selection(self):
        self.assertIsInstance(store_from_env({'KV_REST_API_URL': 'https://a', 'KV_REST_API_TOKEN': 't'}), UpstashStore)
        self.assertIsInstance(store_from_env({'UPSTASH_REDIS_REST_URL': 'https://a', 'UPSTASH_REDIS_REST_TOKEN': 't'}), UpstashStore)
        self.assertIsNone(store_from_env({}))

def call(method, path, body=b'', store=None, code=''):
    c = KmaClient('K', CONFIG, fetch=mock_fetch)
    return handle_api(method, path, {'X-Access-Code': code} if code else {}, body, client=c, config=CONFIG,
                      kakao_js_key='', access_code=code, log_path=None, notam_store=store)

class TApi(unittest.TestCase):
    def test_crud(self):
        s = MemoryStore()
        st, h, b = call('GET', '/api/notams', store=s); d = json.loads(b)
        self.assertEqual(st, 200); self.assertTrue(d['shared']); self.assertEqual(d['slots'], {}); self.assertIn('no-store', h['Cache-Control'])
        st, _, b = call('PUT', '/api/notams/2', json.dumps({'text': 'D2840/26 NOTAMN'}).encode(), store=s); self.assertEqual(st, 200)
        self.assertEqual(json.loads(call('GET', '/api/notams', store=s)[2])['slots']['2']['text'], 'D2840/26 NOTAMN')
        self.assertEqual(call('DELETE', '/api/notams/2', store=s)[0], 200)
        self.assertEqual(json.loads(call('GET', '/api/notams', store=s)[2])['slots'], {})
    def test_bad_requests(self):
        s = MemoryStore()
        self.assertEqual(call('PUT', '/api/notams/11', b'{"text":"x"}', store=s)[0], 400)
        self.assertEqual(call('PUT', '/api/notams/abc', b'{"text":"x"}', store=s)[0], 400)
        self.assertEqual(call('PUT', '/api/notams/1', b'not json', store=s)[0], 400)
    def test_not_shared(self):
        d = json.loads(call('GET', '/api/notams')[2]); self.assertFalse(d['shared'])
        self.assertEqual(call('PUT', '/api/notams/1', b'{"text":"x"}')[0], 503)
    def test_store_failure(self):
        class Boom(MemoryStore):
            def list(self): raise OSError('down')
        st, _, b = call('GET', '/api/notams', store=Boom()); self.assertEqual(st, 502); self.assertIn('error', json.loads(b))
    def test_code_required(self):
        s = MemoryStore()
        c = KmaClient('K', CONFIG, fetch=mock_fetch)
        st = handle_api('GET', '/api/notams', {}, b'', client=c, config=CONFIG, kakao_js_key='', access_code='1234', log_path=None, notam_store=s)[0]
        self.assertEqual(st, 401)

if __name__ == '__main__': unittest.main()
