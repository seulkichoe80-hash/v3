import io, json, os, sys, unittest
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from server.check_api import run_checks
from server.kma import mock_fetch

CONFIG = json.load(open(os.path.join(ROOT, 'config.json'), encoding='utf-8'))
KEY = 'MY-SECRET-KEY-999'

class T(unittest.TestCase):
    def test_masks_key_and_counts(self):
        def leaky(url, timeout=5): return 'echo ' + url + '\n' + mock_fetch(url, timeout)
        buf = io.StringIO()
        run_checks(KEY, CONFIG, fetch=leaky, out=buf)
        s = buf.getvalue()
        self.assertNotIn(KEY, s); self.assertIn('****', s)
        self.assertIn('asos', s); self.assertRegex(s, r'해석 결과: [1-9]')

    def test_failure_reported(self):
        def bad(url, timeout=5): raise OSError('HTTP Error 401: ' + url)
        buf = io.StringIO(); run_checks(KEY, CONFIG, fetch=bad, out=buf)
        s = buf.getvalue(); self.assertNotIn(KEY, s); self.assertIn('실패', s)

if __name__ == '__main__': unittest.main()
