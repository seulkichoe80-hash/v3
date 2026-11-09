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

class SigwxRequest(unittest.TestCase):
    def test_sigwx_production_url_requests_data_not_help(self):
        seen = []
        def f(url, timeout=5): seen.append(url); return mock_fetch(url, timeout)
        c = KmaClient(KEY, CONFIG, fetch=f, now=Clock()); r = c.get('sigwx')
        self.assertIn('amo_sigwx.php', seen[-1]); self.assertIn('help=0', seen[-1]); self.assertNotIn('help=1', seen[-1])
        self.assertGreater(len(r['items']), 0)

    def test_raw_help_flag(self):
        seen = []
        def f(url, timeout=5): seen.append(url); return 'x'
        c = KmaClient(KEY, CONFIG, fetch=f, now=Clock())
        c.raw('sigwx', help=True); self.assertIn('help=1', seen[-1])
        c.raw('sigwx'); self.assertIn('help=0', seen[-1])

    def test_hub_json_error_is_reported_with_message(self):
        def f(url, timeout=5): return '{"result":{"status":401,"message":"유효한 인증키가 아닙니다."}}'
        c = KmaClient(KEY, CONFIG, fetch=f, now=Clock())
        for kind in ('sigwx', 'warn', 'lightning'):
            r = c.get(kind); self.assertEqual(r['items'], []); self.assertIn('401', r['error']); self.assertIn('인증키', r['error'])

    def test_sigwx_unknown_format_is_empty_not_error(self):
        def f(url, timeout=5): return 'SIGWX 자료 형식이 다른 응답 (주석 줄 없음)\n1 2 3'
        r = KmaClient(KEY, CONFIG, fetch=f, now=Clock()).get('sigwx')
        self.assertEqual(r['items'], []); self.assertIsNone(r['error'])     # 해석 불가는 '수신 실패'가 아니라 '해석 불가'로 표시

class SigwxHelpView(unittest.TestCase):
    def test_help_mode_sends_only_help_and_key(self):
        seen = []
        def f(url, timeout=5): seen.append(url); return '설명문'
        c = KmaClient(KEY, CONFIG, fetch=f, now=Clock())
        r = c.raw('sigwx', help=True)
        u = seen[-1]
        self.assertIn('amo_sigwx.php?help=1', u); self.assertNotIn('tm=', u); self.assertIn('authKey=' + KEY, u)
        self.assertNotIn(KEY, json.dumps(r, ensure_ascii=False))           # 응답에서는 키가 가려짐
        c.raw('sigwx'); self.assertIn('tmfc=', seen[-1]); self.assertIn('help=0', seen[-1])   # 일반 모드: 발표시각은 tmfc

class SigwxTmfc(unittest.TestCase):
    def test_uses_tmfc_utc_10_digits(self):
        seen = []
        def f(url, timeout=5): seen.append(url); return mock_fetch(url, timeout)
        KmaClient(KEY, CONFIG, fetch=f, now=Clock()).get('sigwx')   # Clock = 2026-11-08 05:30 UTC → 05:30-30분=05:00 → 05UTC 발표
        import re
        m = re.search(r'amo_sigwx\.php\?tmfc=(\d{10})&', seen[-1]); self.assertTrue(m, seen[-1])
        self.assertEqual(m.group(1), '2026110805'); self.assertNotIn('tm=2', seen[-1])

    def test_falls_back_to_previous_issue(self):
        seen = []
        def f(url, timeout=5):
            seen.append(url)
            if 'tmfc=2026110805' in url: raise OSError('HTTP Error 500')
            return mock_fetch(url, timeout)
        r = KmaClient(KEY, CONFIG, fetch=f, now=Clock()).get('sigwx')
        self.assertIsNone(r['error']); self.assertGreater(len(r['items']), 0)
        self.assertTrue(any('tmfc=2026110723' in u for u in seen))

    def test_all_attempts_fail_reports_error(self):
        def f(url, timeout=5): raise OSError('HTTP Error 500')
        r = KmaClient(KEY, CONFIG, fetch=f, now=Clock()).get('sigwx')
        self.assertEqual(r['items'], []); self.assertIn('500', r['error'])


class PersistTest(unittest.TestCase):
    def test_fallback_to_saved_when_fetch_fails(self):
        from server.store import MemoryStore
        store = MemoryStore(); clock = Clock()
        ok = KmaClient(KEY, CONFIG, fetch=mock_fetch, now=clock, persist=store).get('lightning')
        self.assertFalse(ok.get('error'))
        clock.t += timedelta(minutes=12)
        def dead(url, timeout=8): raise TimeoutError('The read operation timed out')
        r = KmaClient(KEY, CONFIG, fetch=dead, now=clock, persist=store).get('lightning')   # 새 인스턴스(콜드스타트 상황)
        self.assertTrue(r['stale']); self.assertEqual(r['ageMin'], 12); self.assertIn('TimeoutError', r['error'])
        self.assertEqual(r['items'], ok['items'])
    def test_nothing_saved_still_errors(self):
        from server.store import MemoryStore
        def dead(url, timeout=8): raise TimeoutError('x')
        r = KmaClient(KEY, CONFIG, fetch=dead, now=Clock(), persist=MemoryStore()).get('lightning')
        self.assertEqual(r['items'], []); self.assertIn('TimeoutError', r['error'])


class RetryTest(unittest.TestCase):
    def test_timeout_retried_once(self):
        calls = {'n': 0}
        def flaky(url, timeout=8):
            calls['n'] += 1
            if calls['n'] == 1:
                raise TimeoutError('The read operation timed out')
            return mock_fetch(url, timeout)
        c = KmaClient(KEY, CONFIG, fetch=flaky, now=Clock())
        r = c.get('lightning')
        self.assertFalse(r.get('error')); self.assertGreaterEqual(calls['n'], 2)
    def test_two_timeouts_report_error(self):
        def dead(url, timeout=8): raise TimeoutError('The read operation timed out')
        r = KmaClient(KEY, CONFIG, fetch=dead, now=Clock()).get('lightning')
        self.assertIn('TimeoutError', r['error']); self.assertEqual(r['items'], [])
    def test_non_network_errors_not_retried(self):
        calls = {'n': 0}
        def bad(url, timeout=8):
            calls['n'] += 1; return '<html>오류</html>'
        KmaClient(KEY, CONFIG, fetch=bad, now=Clock()).get('lightning')
        self.assertEqual(calls['n'], 1)
