import json, os, sys, tempfile, threading, unittest, urllib.request
from datetime import datetime, timedelta, timezone
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from server.kma import KmaClient, mock_fetch
from server.web import make_server

CONFIG = json.load(open(os.path.join(ROOT, 'config.json'), encoding='utf-8'))
KEY = 'SECRET-KMA-KEY-123'

class Clock:
    def __init__(self): self.t = datetime(2026, 11, 8, 5, 30, tzinfo=timezone.utc)
    def __call__(self): return self.t

class Counting:
    def __init__(self, fail=False): self.n = 0; self.fail = fail
    def __call__(self, url, timeout=5):
        self.n += 1
        if self.fail: raise TimeoutError('timeout')
        return mock_fetch(url, timeout)

class ClientTest(unittest.TestCase):
    def test_ok_and_cache(self):
        f, clk = Counting(), Clock(); c = KmaClient(KEY, CONFIG, fetch=f, now=clk)
        r = c.get('asos'); self.assertGreater(len(r['items']), 0); self.assertIsNone(r['error']); self.assertFalse(r['stale'])
        n = f.n; c.get('asos'); self.assertEqual(f.n, n)          # 캐시
        for kind in ('metar', 'taf', 'aws', 'warn', 'lightning'):
            self.assertGreater(len(c.get(kind)['items']), 0, kind)
        aws = {x['stn']: x for x in c.get('aws')['items']}
        self.assertEqual(aws['400']['windMs10ago'], 3.5)

    def test_fail_with_cache_is_stale(self):
        f, clk = Counting(), Clock(); c = KmaClient(KEY, CONFIG, fetch=f, now=clk)
        c.get('asos'); f.fail = True; clk.t += timedelta(minutes=10)
        r = c.get('asos'); self.assertTrue(r['stale']); self.assertEqual(r['ageMin'], 10); self.assertGreater(len(r['items']), 0)

    def test_fail_without_cache(self):
        c = KmaClient(KEY, CONFIG, fetch=Counting(fail=True), now=Clock())
        r = c.get('metar'); self.assertEqual(r['items'], []); self.assertTrue(r['error'])

    def test_key_in_url(self):
        seen = []
        def f(url, timeout=5): seen.append(url); return mock_fetch(url, timeout)
        KmaClient(KEY, CONFIG, fetch=f, now=Clock()).get('warn')
        self.assertTrue(all('authKey=' + KEY in u for u in seen))

class HttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.log = os.path.join(cls.tmp, 'history.csv')
        client = KmaClient(KEY, CONFIG, fetch=mock_fetch, now=Clock())
        cls.srv = make_server(0, client, CONFIG, 'KAKAO-JS', cls.log, os.path.join(ROOT, 'web'))
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
    @classmethod
    def tearDownClass(cls): cls.srv.shutdown()
    def url(self, p): return f'http://127.0.0.1:{self.port}{p}'

    def test_client_config_hides_key(self):
        body = urllib.request.urlopen(self.url('/api/client-config')).read().decode()
        self.assertNotIn(KEY, body); d = json.loads(body)
        self.assertEqual(d['kakaoJsKey'], 'KAKAO-JS'); self.assertIn('limits', d['config'])

    def test_api_and_static(self):
        d = json.loads(urllib.request.urlopen(self.url('/api/asos')).read())
        self.assertGreater(len(d['items']), 0)
        self.assertEqual(urllib.request.urlopen(self.url('/web/geo.js')).status, 200)
        with self.assertRaises(urllib.error.HTTPError): urllib.request.urlopen(self.url('/web/../config.json'))

    def test_log(self):
        req = urllib.request.Request(self.url('/api/log'), method='POST', data=json.dumps(
            {'from': '김포', 'to': '서울역', 'overall': 'YELLOW', 'distanceKm': 15.9}).encode(), headers={'Content-Type': 'application/json'})
        urllib.request.urlopen(req)
        lines = open(self.log, encoding='utf-8-sig').read().strip().splitlines()
        self.assertTrue(lines[-1].endswith('김포,서울역,15.9,YELLOW'), lines[-1])

if __name__ == '__main__': unittest.main()

class ReviewC1(unittest.TestCase):
    def test_non_table_body_is_error(self):
        def f(url, timeout=5): return '{"result":{"status":403,"message":"활용신청하지 않은 API"}}'
        c = KmaClient(KEY, CONFIG, fetch=f, now=Clock())
        for kind in ('warn', 'lightning', 'asos', 'aws'):
            r = c.get(kind); self.assertTrue(r['error'], kind); self.assertEqual(r['items'], [])

class RealFormats(unittest.TestCase):
    def test_iwxxm_and_warn_json_through_client(self):
        def f(url, timeout=5):
            name = 'metar_iwxxm.json' if 'getMetar' in url else 'taf_iwxxm.json' if 'getTaf' in url else 'warn_real.json' if 'wrn_now' in url else None
            if name: return open(os.path.join(ROOT, 'tests', 'fixtures', 'kma', name), encoding='utf-8').read()
            return mock_fetch(url, timeout)
        c = KmaClient(KEY, CONFIG, fetch=f, now=Clock())
        m = c.get('metar'); self.assertIsNone(m['error']); self.assertEqual(m['items'][0]['icao'], 'RKSS')
        t = c.get('taf'); self.assertIsNone(t['error']); self.assertEqual(len(t['items'][0]['groups']), 3)
        w = c.get('warn'); self.assertIsNone(w['error']); self.assertEqual(len(w['items']), 39)
