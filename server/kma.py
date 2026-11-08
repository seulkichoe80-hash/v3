"""기상청 API허브 대리 호출 + 정규화 + 캐시. 인증키는 이 모듈 밖(브라우저)으로 나가지 않는다."""
import os, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from . import parsers as P

H1 = 'https://apihub.kma.go.kr/api/typ01/url/'
H1C = 'https://apihub.kma.go.kr/api/typ01/cgi-bin/url/'
H2 = 'https://apihub.kma.go.kr/api/typ02/openApi/'
# 실제 응답 확인 후 이곳만 고치면 된다.
ENDPOINTS = {
    'stn_sfc': H1 + 'stn_inf.php?inf=SFC&stn=&help=0',
    'stn_aws': H1 + 'stn_inf.php?inf=AWS&stn=&help=0',
    'asos': H1 + 'kma_sfctm2.php?tm={tm_hour}&stn=0&help=0',
    'aws': H1C + 'nph-aws2_min?tm2={tm_min}&stn=0&disp=0&help=0',
    'warn': H1 + 'wrn_now_data.php?fe=f&tm=&disp=1&help=0',
    'lightning': H1 + 'lgt_pnt.php?tm1={tm_30ago}&tm2={tm_min}&help=0',
    'metar': H2 + 'AmmIwxxmService/getMetar?pageNo=1&numOfRows=10&dataType=JSON&icao={icao}',
    'taf': H2 + 'AmmIwxxmService/getTaf?pageNo=1&numOfRows=10&dataType=JSON&icao={icao}',
}
TTL_MIN = {'asos': 5, 'aws': 2, 'warn': 5, 'lightning': 2, 'metar': 5, 'taf': 10, 'stn_sfc': 1440, 'stn_aws': 1440}
FIXTURES = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tests', 'fixtures', 'kma')


def urllib_fetch(url, timeout=5):
    req = urllib.request.Request(url, headers={'User-Agent': 'heli-wx/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    for enc in ('utf-8', 'cp949'):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode('utf-8', 'replace')


_MOCK_STATE = {}


def mock_fetch(url, timeout=5):
    """--mock 및 테스트용: URL에 따라 픽스처 반환."""
    table = [('inf=SFC', 'stn_sfc.txt'), ('inf=AWS', 'stn_aws.txt'), ('kma_sfctm2', 'asos.txt'),
             ('wrn_now', 'warn.txt'), ('lgt_pnt', 'lgt.txt'), ('getMetar', 'metar.json'), ('getTaf', 'taf.json')]
    if 'nph-aws2_min' in url:  # 클라이언트는 현재 → 10분 전 순으로 호출한다
        tm2 = url.split('tm2=')[1][:12]
        name = 'aws_10ago.txt' if _MOCK_STATE.get('aws_tm2', '') > tm2 else 'aws.txt'
        _MOCK_STATE['aws_tm2'] = tm2
    else:
        name = next((f for k, f in table if k in url), 'error.html')
    with open(os.path.join(FIXTURES, name), encoding='utf-8') as f:
        return f.read()


class KmaClient:
    def __init__(self, auth_key, config, fetch=urllib_fetch, now=None, timeout=5):
        self.key, self.config, self.fetch, self.timeout = auth_key, config, fetch, timeout
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.cache = {}  # kind -> (fetched_at, items)

    # --- URL ---
    def _url(self, kind, **kw):
        kst = self.now().astimezone(P.KST)
        t_min = kst - timedelta(minutes=kw.pop('lag_min', 2))
        fmt = dict(tm_hour=kst.strftime('%Y%m%d%H00'), tm_min=t_min.strftime('%Y%m%d%H%M'),
                   tm_30ago=(t_min - timedelta(minutes=30)).strftime('%Y%m%d%H%M'), icao='')
        fmt.update(kw)
        url = ENDPOINTS[kind].format(**fmt)
        return url + ('&' if '?' in url else '?') + 'authKey=' + self.key

    def _get(self, kind, **kw):
        text = self.fetch(self._url(kind, **kw), timeout=self.timeout)
        # typ01 표 형식 응답은 '#' 주석/헤더 줄을 가진다. 없으면 오류 응답(활용신청 안 됨, 인증 실패 등)으로 본다.
        if kind not in ('metar', 'taf') and not any(l.lstrip().startswith('#') for l in text.splitlines()):
            raise RuntimeError('기상청 응답 형식 아님: ' + text.strip()[:120])
        return text

    # --- 종류별 수집 ---
    def _stations(self, which):
        hit = self.cache.get(which)
        if hit and (self.now() - hit[0]) < timedelta(minutes=TTL_MIN[which]):
            return hit[1]
        st = P.parse_stations(self._get(which))
        if st:
            self.cache[which] = (self.now(), st)
        return st

    def _collect(self, kind):
        ap = self.config.get('airports', [])
        now = self.now()
        if kind == 'asos':
            st = self._stations('stn_sfc')
            items = P.parse_asos(self._get('asos'), st)
            if not items:  # 정시 자료가 아직 없으면 1시간 전
                prev = (now.astimezone(P.KST) - timedelta(hours=1)).strftime('%Y%m%d%H00')
                items = P.parse_asos(self._get('asos', tm_hour=prev), st)
            return items
        if kind == 'aws':
            st = self._stations('stn_aws')
            cur = P.parse_aws(self._get('aws', lag_min=2), st)
            old = {x['stn']: x for x in P.parse_aws(self._get('aws', lag_min=12), st)}
            for x in cur:
                x['windMs10ago'] = old.get(x['stn'], {}).get('windMs')
            return cur
        if kind == 'warn':
            return P.parse_warn(self._get('warn'))
        if kind == 'lightning':
            return P.parse_lightning(self._get('lightning'))
        if kind in ('metar', 'taf'):
            def one(a):
                try:
                    text = self._get(kind, icao=a['icao'])
                except Exception:
                    return []
                if kind == 'metar':
                    raws = P.extract_reports(text, 'METAR') + P.extract_reports(text, 'SPECI')
                    parsed = [P.parse_metar(r, ap, now) for r in raws]
                else:
                    parsed = [P.parse_taf(r, ap, now) for r in P.extract_reports(text, 'TAF')]
                return [p for p in parsed if p and p['icao'] == a['icao']]
            with ThreadPoolExecutor(max_workers=8) as ex:
                lists = list(ex.map(one, ap))
            items = []
            for lst in lists:  # 공항별 최신 1건
                if lst:
                    items.append(max(lst, key=lambda p: p.get('obsTime') or p.get('issued') or ''))
            if not items and ap:
                raise RuntimeError('공항 자료를 받지 못함')
            return items
        raise KeyError(kind)

    def raw(self, kind, limit=4000):
        """점검용: 기상청 원본 응답 앞부분(인증키 가림)."""
        url = self._url(kind, icao='RKSS')
        mask = (lambda s: s.replace(self.key, '****')) if self.key else (lambda s: s)
        try:
            body = self.fetch(url, timeout=self.timeout)
            return {'url': mask(url), 'ok': True, 'body': mask(body[:limit])}
        except Exception as e:
            return {'url': mask(url), 'ok': False, 'body': mask(f'{type(e).__name__}: {e}')[:limit]}

    def get(self, kind):
        now = self.now()
        hit = self.cache.get(kind)
        if hit and (now - hit[0]) < timedelta(minutes=TTL_MIN.get(kind, 5)):
            return self._resp(hit[1], hit[0], stale=False)
        try:
            items = self._collect(kind)
            self.cache[kind] = (now, items)
            return self._resp(items, now, stale=False)
        except Exception as e:  # 실패: 캐시가 있으면 오래된 자료로 응답
            msg = f'{type(e).__name__}: {e}'.replace(self.key, '****') if self.key else str(e)
            if hit:
                return self._resp(hit[1], hit[0], stale=True, error=msg)
            return {'items': [], 'fetchedAt': None, 'stale': False, 'ageMin': None, 'error': msg}

    def _resp(self, items, at, stale, error=None):
        return {'items': items, 'fetchedAt': P.iso(at), 'stale': stale,
                'ageMin': int((self.now() - at).total_seconds() // 60), 'error': error}
