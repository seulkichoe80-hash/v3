import json, os, sys, unittest
from datetime import datetime, timezone
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from server import parsers as P

FX = os.path.join(ROOT, 'tests', 'fixtures', 'kma')
def fx(name):
    with open(os.path.join(FX, name), encoding='utf-8') as f: return f.read()
AIRPORTS = json.load(open(os.path.join(ROOT, 'config.json'), encoding='utf-8'))['airports']
NOW = datetime(2026, 11, 8, 5, 30, tzinfo=timezone.utc)

class T(unittest.TestCase):
    def test_num(self):
        for s in ['-9', '-99', '-99.9', '-999', '', 'abc', '-9.00']: self.assertIsNone(P.num(s), s)
        self.assertEqual(P.num('12.5'), 12.5); self.assertEqual(P.num('0'), 0.0)

    def test_stations(self):
        st = P.parse_stations(fx('stn_sfc.txt'))
        self.assertEqual(st['108']['name'], '서울'); self.assertAlmostEqual(st['108']['lat'], 37.5714, 3)
        self.assertEqual(P.parse_stations(fx('stn_aws.txt'))['400']['name'], '강남')

    def test_asos(self):
        rows = {r['stn']: r for r in P.parse_asos(fx('asos.txt'), P.parse_stations(fx('stn_sfc.txt')))}
        s = rows['108']
        self.assertEqual(s['visM'], 1500); self.assertEqual(s['cloudTenths'], 7)
        self.assertEqual(s['ceilFt'], 2625); self.assertEqual(s['obsTime'], '2026-11-08T05:00:00Z')
        self.assertEqual(s['name'], '서울'); self.assertIsNone(s['gustMs'])
        self.assertIsNone(rows['112']['ceilFt'])           # 전운량 3 → 운고 없음
        self.assertEqual(rows['112']['gustMs'], 12.4)
        self.assertIsNone(rows['119']['visM'])             # 결측 -9 → None (0 아님)

    def test_aws(self):
        rows = {r['stn']: r for r in P.parse_aws(fx('aws.txt'), P.parse_stations(fx('stn_aws.txt')))}
        self.assertEqual(rows['400']['windMs'], 6.0); self.assertEqual(rows['400']['windDir'], 305)
        self.assertEqual(rows['400']['gustMs'], 11.2); self.assertEqual(rows['400']['name'], '강남')

    def test_warn(self):
        w = P.parse_warn(fx('warn.txt'))
        self.assertEqual(len(w), 2)
        self.assertEqual(w[0]['regName'], '서울서남권'); self.assertEqual(w[0]['kind'], '강풍'); self.assertEqual(w[0]['level'], '주의보')
        self.assertEqual(w[0]['regUpName'], '서울특별시')

    def test_lightning(self):
        l = P.parse_lightning(fx('lgt.txt'))
        self.assertEqual(len(l), 2); self.assertAlmostEqual(l[0]['lat'], 37.53); self.assertEqual(l[0]['time'], '2026-11-08T04:50:00Z')

    def test_metar(self):
        raws = P.extract_reports(fx('metar.json'), 'METAR'); self.assertEqual(len(raws), 2)
        m = P.parse_metar(raws[0], AIRPORTS, NOW)
        self.assertEqual(m['icao'], 'RKSS'); self.assertEqual(m['visM'], 2500); self.assertEqual(m['ceilFt'], 800)
        self.assertEqual(m['windDir'], 320); self.assertEqual(m['windKt'], 12); self.assertEqual(m['gustKt'], 25)
        self.assertEqual(m['obsTime'], '2026-11-08T05:00:00Z'); self.assertAlmostEqual(m['lat'], 37.5583)
        c = P.parse_metar(raws[1], AIRPORTS, NOW)
        self.assertEqual(c['visM'], 10000); self.assertIsNone(c['ceilFt'])

    def test_taf(self):
        raw = P.extract_reports(fx('taf.json'), 'TAF')[0]
        t = P.parse_taf(raw, AIRPORTS, NOW)
        g = t['groups']; self.assertEqual([x['type'] for x in g], ['BASE', 'TEMPO', 'FM'])
        self.assertEqual((g[0]['visM'], g[0]['ceilFt']), (6000, 3000))
        self.assertEqual((g[0]['from'], g[0]['to']), ('2026-11-08T06:00:00Z', '2026-11-09T03:00:00Z'))
        self.assertEqual((g[1]['visM'], g[1]['ceilFt']), (2000, 800))
        self.assertEqual((g[1]['from'], g[1]['to']), ('2026-11-08T09:00:00Z', '2026-11-08T12:00:00Z'))
        self.assertEqual((g[2]['visM'], g[2]['ceilFt']), (10000, None))
        self.assertEqual((g[2]['from'], g[2]['to']), ('2026-11-09T03:00:00Z', '2026-11-09T12:00:00Z'))

    def test_error_page(self):
        e = fx('error.html')
        self.assertEqual(P.parse_asos(e, {}), []); self.assertEqual(P.parse_aws(e, {}), [])
        self.assertEqual(P.parse_warn(e), []); self.assertEqual(P.parse_lightning(e), [])
        self.assertEqual(P.parse_stations(e), {}); self.assertEqual(P.extract_reports(e, 'METAR'), [])
        self.assertIsNone(P.parse_metar('garbage', AIRPORTS, NOW)); self.assertIsNone(P.parse_taf('garbage', AIRPORTS, NOW))

if __name__ == '__main__': unittest.main()
