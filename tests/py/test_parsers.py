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
        self.assertEqual(s['visM'], 1500); self.assertEqual(s['cloudTenths'], 7); self.assertEqual(s['midTenths'], 5)
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

class Review(unittest.TestCase):
    def test_i1_asos_ceil_unknown(self):
        line = fx('asos.txt').splitlines()[5].replace('  7   5    8 Sc', '  8   5   -9 Sc')
        r = P.parse_asos('#\n' + line, {})[0]
        self.assertEqual(r['cloudTenths'], 8); self.assertIsNone(r['ceilFt']); self.assertTrue(r['ceilUnknown'])
    def test_i1_metar_ceil_unknown(self):
        self.assertTrue(P.parse_metar('METAR RKSS 080500Z 32012KT 9999 BKN/// 12/10 Q1015=', AIRPORTS, NOW)['ceilUnknown'])
        self.assertTrue(P.parse_metar('METAR RKSS 080500Z 32012KT 9999 12/10 Q1015=', AIRPORTS, NOW)['ceilUnknown'])
        self.assertFalse(P.parse_metar('METAR RKSS 080500Z 32012KT 9999 FEW030 12/10 Q1015=', AIRPORTS, NOW)['ceilUnknown'])
        self.assertFalse(P.parse_metar('METAR RKSI 080500Z 30008KT CAVOK 13/03 Q1016=', AIRPORTS, NOW)['ceilUnknown'])

class Real(unittest.TestCase):
    """2026-11-08 실제 기상청 API허브 응답"""
    def test_metar_iwxxm(self):
        xs = P.extract_iwxxm(fx('metar_iwxxm.json'), 'METAR'); self.assertEqual(len(xs), 1)
        m = P.parse_metar_iwxxm(xs[0], AIRPORTS)
        self.assertEqual(m['icao'], 'RKSS'); self.assertEqual(m['obsTime'], '2026-11-08T07:00:00Z')
        self.assertEqual(m['visM'], 10000); self.assertEqual(m['ceilFt'], 7000); self.assertFalse(m['ceilUnknown'])
        self.assertEqual((m['windDir'], m['windKt'], m['gustKt']), (360, 8, None))
        self.assertAlmostEqual(m['lat'], 37.5583)   # 좌표는 config 공항표 사용

    def test_metar_iwxxm_variants(self):
        x = P.extract_iwxxm(fx('metar_iwxxm.json'), 'METAR')[0]
        cav = P.parse_metar_iwxxm(x.replace('cloudAndVisibilityOK="false"', 'cloudAndVisibilityOK="true"'), AIRPORTS)
        self.assertEqual(cav['visM'], 10000); self.assertIsNone(cav['ceilFt']); self.assertFalse(cav['ceilUnknown'])
        few = P.parse_metar_iwxxm(x.replace('/OVC', '/FEW'), AIRPORTS); self.assertIsNone(few['ceilFt']); self.assertFalse(few['ceilUnknown'])
        nobase = P.parse_metar_iwxxm(x.replace('<iwxxm:base uom="[ft_i]">7000</iwxxm:base>', '<iwxxm:base nilReason="http://codes.wmo.int/common/nil/notObservable" uom="N/A" xsi:nil="true"/>'), AIRPORTS)
        self.assertIsNone(nobase['ceilFt']); self.assertTrue(nobase['ceilUnknown'])
        import re
        nocloud = P.parse_metar_iwxxm(re.sub(r'<iwxxm:cloud>.*</iwxxm:cloud>', '', x, flags=re.S), AIRPORTS)
        self.assertTrue(nocloud['ceilUnknown'])
        vv = P.parse_metar_iwxxm(re.sub(r'<iwxxm:cloud>.*</iwxxm:cloud>', '<iwxxm:cloud><iwxxm:AerodromeCloud><iwxxm:verticalVisibility uom="[ft_i]">200</iwxxm:verticalVisibility></iwxxm:AerodromeCloud></iwxxm:cloud>', x, flags=re.S), AIRPORTS)
        self.assertEqual(vv['ceilFt'], 200)
        self.assertIsNone(P.parse_metar_iwxxm('<not xml', AIRPORTS))

    def test_taf_iwxxm(self):
        t = P.parse_taf_iwxxm(P.extract_iwxxm(fx('taf_iwxxm.json'), 'TAF')[0], AIRPORTS)
        self.assertEqual(t['icao'], 'RKSS'); self.assertEqual(t['issued'], '2026-11-08T05:00:00Z')
        g = t['groups']; self.assertEqual([x['type'] for x in g], ['BASE', 'BECMG', 'BECMG'])
        self.assertEqual((g[0]['from'], g[0]['to'], g[0]['visM'], g[0]['ceilFt']), ('2026-11-08T06:00:00Z', '2026-11-09T12:00:00Z', 10000, 6000))
        self.assertEqual((g[1]['from'], g[1]['to'], g[1]['visM'], g[1]['ceilFt']), ('2026-11-08T11:00:00Z', '2026-11-09T12:00:00Z', None, None))
        self.assertEqual((g[2]['visM'], g[2]['ceilFt']), (10000, None))

    def test_warn_json(self):
        w = P.parse_warn(fx('warn_real.json')); self.assertEqual(len(w), 39)
        self.assertEqual(w[0]['regName'], '동해남부북쪽안쪽먼바다'); self.assertEqual(w[0]['kind'], '풍랑')
        self.assertEqual(w[0]['level'], '예비'); self.assertEqual(w[0]['regUpName'], '동해남부전해상')
        self.assertEqual(w[0]['tmEf'], '2026-11-09T08:58:00Z')

class Sigwx(unittest.TestCase):
    def test_rows_format(self):
        a = P.parse_sigwx(fx('sigwx_rows.txt'))
        self.assertEqual([x['kind'] for x in a], ['ICE', 'TURB'])
        self.assertEqual(len(a[0]['points']), 4); self.assertAlmostEqual(a[0]['points'][1]['lon'], 127.2)
        self.assertEqual(a[0]['issued'], '2026-11-08T05:00:00Z')
    def test_line_format(self):
        a = P.parse_sigwx(fx('sigwx_line.txt'))
        self.assertEqual(a[0]['kind'], 'MTN'); self.assertEqual(len(a[0]['points']), 4)
        self.assertEqual(a[1]['kind'], 'FZL'); self.assertEqual(len(a[1]['points']), 2)
    def test_garbage(self):
        self.assertEqual(P.parse_sigwx(fx('error.html')), []); self.assertEqual(P.parse_sigwx('#START7777\n#7777END'), [])
