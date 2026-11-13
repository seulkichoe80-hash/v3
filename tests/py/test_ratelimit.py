import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from server import web


class RateTest(unittest.TestCase):
    def setUp(self): web._RATE.clear()

    def test_local_unlimited(self):
        for _ in range(web.RATE_MAX + 50): self.assertEqual(web._rate_limited('', '/api/x', 1000), 0)

    def test_general_limit_and_window(self):
        for i in range(web.RATE_MAX): self.assertEqual(web._rate_limited('1.1.1.1', '/api/places', 1000 + i * 0.01), 0)
        self.assertGreater(web._rate_limited('1.1.1.1', '/api/places', 1005), 0)
        self.assertEqual(web._rate_limited('2.2.2.2', '/api/places', 1005), 0)          # 다른 IP는 영향 없음
        self.assertEqual(web._rate_limited('1.1.1.1', '/api/places', 1000 + web.RATE_WINDOW + 5), 0)   # 창이 지나면 풀림

    def test_drive_has_stricter_limit(self):
        for i in range(web.RATE_MAX_DRIVE): self.assertEqual(web._rate_limited('3.3.3.3', '/api/drive', 2000 + i * 0.01), 0)
        self.assertGreater(web._rate_limited('3.3.3.3', '/api/drive', 2005), 0)
        self.assertEqual(web._rate_limited('3.3.3.3', '/api/places', 2005), 0)

    def test_handle_api_returns_429(self):
        kw = dict(client=None, config={}, kakao_js_key='', client_ip='9.9.9.9')
        web._RATE[('9.9.9.9', 'all')] = [1e12] * web.RATE_MAX                      # 가득 찬 상태
        st, h, b = web.handle_api('GET', '/api/places', {}, b'', **kw)
        self.assertEqual(st, 429); self.assertIn('Retry-After', {k.title(): v for k, v in dict(h).items()})


if __name__ == '__main__':
    unittest.main()
