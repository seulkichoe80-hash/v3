import json, os, sys, unittest
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from server import drive
from server.web import handle_api

CFG = {'roadFactor': 1.35, 'roadSpeedKmh': 50}
SEO, BUS = (37.5665, 126.9780), (35.1796, 129.0756)


class Drive(unittest.TestCase):
    def setUp(self): drive._CACHE.clear()
    def test_no_key_estimate(self):
        r = drive.drive_time(SEO, BUS, '', CFG)
        self.assertEqual(r['source'], 'estimate'); self.assertTrue(300 < r['distanceKm'] < 500); self.assertGreater(r['durationMin'], 300)
        self.assertIn('추정', r['note'])
    def test_kakao_ok_and_request(self):
        seen = {}
        def get(url, headers, timeout=6):
            seen['url'], seen['h'] = url, headers
            return json.dumps({'routes': [{'result_code': 0, 'summary': {'distance': 325400, 'duration': 14400}}]})
        r = drive.drive_time(SEO, BUS, 'KEY123', CFG, http_get=get)
        self.assertEqual((r['source'], r['distanceKm'], r['durationMin']), ('kakao', 325.4, 240))
        self.assertIn('origin=126.978%2C37.5665', seen['url']); self.assertEqual(seen['h']['Authorization'], 'KakaoAK KEY123')   # 경도,위도 순서
        r2 = drive.drive_time(SEO, BUS, 'KEY123', CFG, http_get=lambda *a, **k: 1 / 0)       # 5분 캐시
        self.assertEqual(r2['source'], 'kakao')
    def test_failures_fall_back(self):
        for bad in [lambda *a, **k: (_ for _ in ()).throw(OSError('x')), lambda *a, **k: '{"msg":"x"}',
                    lambda *a, **k: json.dumps({'routes': [{'result_code': 104, 'result_msg': '출발지와 도착지가 너무 가깝습니다'}]})]:
            drive._CACHE.clear()
            r = drive.drive_time(SEO, BUS, 'K', CFG, http_get=bad)
            self.assertEqual(r['source'], 'estimate'); self.assertIn('실패', r['note'])
    def test_api(self):
        def call(q, **kw): return handle_api('GET', '/api/drive?' + q, {}, b'', client=None, config={'dispatch': CFG}, kakao_js_key='', **kw)
        st, _, b = call('olat=37.5&olon=127&dlat=36.3&dlon=127.4'); d = json.loads(b)
        self.assertEqual((st, d['source']), (200, 'estimate'))
        self.assertEqual(call('olat=x&olon=127&dlat=36&dlon=127')[0], 400); self.assertEqual(call('olat=95&olon=127&dlat=36&dlon=127')[0], 400)
        self.assertEqual(call('olat=37')[0], 400)
        cc = json.loads(handle_api('GET', '/api/client-config', {}, b'', client=None, config={}, kakao_js_key='', kakao_rest_key='k')[2])
        self.assertTrue(cc['driveKakao'])


if __name__ == '__main__':
    unittest.main()
