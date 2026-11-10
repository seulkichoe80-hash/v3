import json, os, sys, tempfile, unittest
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from server.store import MemoryStore, FileStore, UpstashStore, MAX_PLACES
from test_store import FakeRedis, call

class Contract:
    def make(self): raise NotImplementedError
    def test_add_list_delete(self):
        s = self.make()
        self.assertEqual(s.places_list(), [])
        a = s.places_save({'name': '다라병원 헬리패드', 'lat': 37.5, 'lon': 127.0, 'memo': '옥상'})
        b = s.places_save({'name': '가나 기지', 'lat': 36.1, 'lon': 128.2})
        names = [p['name'] for p in s.places_list()]; self.assertEqual(names, ['가나 기지', '다라병원 헬리패드'])  # 이름순
        self.assertEqual(s.places_list()[1]['memo'], '옥상'); self.assertTrue(a['id'])
        s.places_delete(a['id']); self.assertEqual([p['id'] for p in s.places_list()], [b['id']])
        # NOTAM 칸과 서로 섞이지 않음
        s.save(1, 'D1/26 NOTAMN'); self.assertEqual(len(s.places_list()), 1); self.assertEqual(sorted(s.list()), [1])
    def test_category(self):
        s = self.make()
        a = s.places_save({'name': '가', 'lat': 37, 'lon': 127, 'cat': '병원'}); self.assertEqual(a['cat'], '병원')
        b = s.places_save({'id': a['id'], 'name': '가', 'lat': 37, 'lon': 127, 'cat': '헬리패드'})   # 같은 id는 갱신
        self.assertEqual([p['cat'] for p in s.places_list()], ['헬리패드']); self.assertEqual(s.places_save({'name': '나', 'lat': 37, 'lon': 127})['cat'], '')
        with self.assertRaises(ValueError): s.places_save({'name': '다', 'lat': 37, 'lon': 127, 'cat': 'x' * 11})
    def test_validation(self):
        s = self.make()
        for bad in [{'name': '', 'lat': 37, 'lon': 127}, {'name': 'x' * 51, 'lat': 37, 'lon': 127},
                    {'name': 'a', 'lat': 95, 'lon': 127}, {'name': 'a', 'lat': 37, 'lon': 'x'},
                    {'name': 'a', 'lat': 37, 'lon': 127, 'memo': 'm' * 101}]:
            with self.assertRaises(ValueError): s.places_save(bad)

class TMem(Contract, unittest.TestCase):
    def make(self): return MemoryStore()
    def test_max(self):
        s = MemoryStore()
        for i in range(MAX_PLACES): s.places_save({'name': f'p{i}', 'lat': 37, 'lon': 127})
        with self.assertRaises(ValueError): s.places_save({'name': 'over', 'lat': 37, 'lon': 127})

class TFile(Contract, unittest.TestCase):
    def make(self): return FileStore(os.path.join(tempfile.mkdtemp(), 'n.json'))

class FakeRedis2(FakeRedis):
    """키별 해시를 따로 보관"""
    def __init__(self): super().__init__(); self.hh = {}
    def __call__(self, url, body, headers, timeout=5):
        cmd = json.loads(body); self.h = self.hh.setdefault(cmd[1], {})
        return super().__call__(url, body, headers, timeout)

class TUpstash(Contract, unittest.TestCase):
    def make(self): return UpstashStore('https://x', 'TKN', post=FakeRedis2())

class TApi(unittest.TestCase):
    def test_crud(self):
        s = MemoryStore()
        d = json.loads(call('GET', '/api/places', store=s)[2]); self.assertTrue(d['shared']); self.assertEqual(d['places'], [])
        st, _, b = call('POST', '/api/places', json.dumps({'name': '기지A', 'lat': 37.1, 'lon': 127.2, 'memo': ''}).encode(), store=s)
        self.assertEqual(st, 200); pid = json.loads(b)['place']['id']
        self.assertEqual(json.loads(call('GET', '/api/places', store=s)[2])['places'][0]['name'], '기지A')
        self.assertEqual(call('DELETE', f'/api/places/{pid}', store=s)[0], 200)
        self.assertEqual(json.loads(call('GET', '/api/places', store=s)[2])['places'], [])
    def test_bad(self):
        s = MemoryStore()
        self.assertEqual(call('POST', '/api/places', b'{"name":"","lat":1,"lon":1}', store=s)[0], 400)
        self.assertEqual(call('POST', '/api/places', b'nope', store=s)[0], 400)
        self.assertEqual(call('POST', '/api/places', b'{"name":"a","lat":1,"lon":1}')[0], 503)
        self.assertFalse(json.loads(call('GET', '/api/places')[2])['shared'])

if __name__ == '__main__': unittest.main()
