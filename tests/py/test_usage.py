import json, os, sys, tempfile, unittest
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from server.store import MemoryStore, FileStore
from server.web import handle_api


class Contract:
    def test_add_stats(self):
        s = self.make()
        self.assertEqual(s.usage_stats()['total'], 0)
        s.usage_add({'from': '창원', 'to': '잠실', 'distanceKm': 300.2, 'overall': 'GREEN'})
        s.usage_add({'from': 'A', 'to': 'B', 'via': 'C', 'distanceKm': 'x', 'overall': 'RED'})
        st = s.usage_stats()
        self.assertEqual((st['total'], st['today'], st['activeDays']), (2, 2, 1))
        self.assertEqual(st['byOverall'], {'GREEN': 1, 'RED': 1}); self.assertEqual(st['last7'][-1]['count'], 2)
        self.assertIsNone(s.usage_list()[1]['km'])           # 숫자가 아니면 비움
        self.assertEqual(len(s.list()), 0)                    # NOTAM 칸과 섞이지 않음
    def test_validation(self):
        s = self.make()
        for bad in [None, [], {'from': '', 'to': 'x'}, {'from': 'x'}]:
            with self.assertRaises(ValueError): s.usage_add(bad)


class TMem(Contract, unittest.TestCase):
    def make(self): return MemoryStore()


class TFile(Contract, unittest.TestCase):
    def make(self): return FileStore(os.path.join(tempfile.mkdtemp(), 'n.json'))


class Api(unittest.TestCase):
    def call(self, method, path, body=b'', store=None, hdr=None):
        return handle_api(method, path, hdr or {}, body, client=None, config={}, kakao_js_key='', notam_store=store)
    def test_flow(self):
        s = MemoryStore()
        st, _, b = self.call('POST', '/api/usage', json.dumps({'from': '=cmd', 'to': 'B', 'distanceKm': 10, 'overall': 'YELLOW'}).encode(), s)
        self.assertEqual(st, 200); self.assertEqual(json.loads(b)['stats']['total'], 1)
        st, _, b = self.call('GET', '/api/usage', store=s); self.assertEqual(json.loads(b)['total'], 1)
        st, h, b = self.call('GET', '/api/usage?format=csv', store=s)
        txt = b.decode('utf-8'); self.assertIn('text/csv', h['Content-Type']); self.assertIn("'=cmd", txt); self.assertIn('주의', txt)
        self.assertEqual(self.call('POST', '/api/usage', b'{', s)[0], 400)
        self.assertEqual(self.call('POST', '/api/usage', b'{}', s)[0], 400)
    def test_no_store(self):
        st, _, b = self.call('GET', '/api/usage'); self.assertEqual(json.loads(b), {'shared': False})
        self.assertEqual(self.call('POST', '/api/usage', b'{}')[0], 200)
    def test_origin_and_code(self):
        s = MemoryStore()
        st, _, _ = self.call('POST', '/api/usage', b'{}', s, {'Origin': 'https://evil.example', 'Host': 'x.vercel.app'}); self.assertEqual(st, 403)
        cc = json.loads(self.call('GET', '/api/client-config', store=s)[2]); self.assertTrue(cc['usageShared'])


if __name__ == '__main__':
    unittest.main()
