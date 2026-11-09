"""기상청 API허브 대리 호출 + 정규화 + 캐시. 인증키는 이 모듈 밖(브라우저)으로 나가지 않는다."""
import json, os, time, urllib.request
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
    'sigwx': H1 + 'amo_sigwx.php?tmfc={tmfc_sigwx}&help=0',   # 저고도 중요기상예보: 발표시각 tmfc(UTC, YYYYMMDDHH, 05·11·17·23시)
}
TTL_MIN = {'sigwx': 30, 'asos': 5, 'aws': 2, 'warn': 5, 'lightning': 2, 'metar': 5, 'taf': 10, 'stn_sfc': 1440, 'stn_aws': 1440}
FIXTURES = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tests', 'fixtures', 'kma')


def urllib_fetch(url, timeout=8):
    req = urllib.request.Request(url, headers={'User-Agent': 'haneulgil119/1.0'})
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
             ('wrn_now', 'warn.txt'), ('lgt_pnt', 'lgt.txt'), ('amo_sigwx', 'sigwx_real.xml'), ('getMetar', 'metar.json'), ('getTaf', 'taf.json')]
    if 'nph-aws2_min' in url:  # 클라이언트는 현재 → 10분 전 순으로 호출한다
        tm2 = url.split('tm2=')[1][:12]
        name = 'aws_10ago.txt' if _MOCK_STATE.get('aws_tm2', '') > tm2 else 'aws.txt'
        _MOCK_STATE['aws_tm2'] = tm2
    else:
        name = next((f for k, f in table if k in url), 'error.html')
    with open(os.path.join(FIXTURES, name), encoding='utf-8') as f:
        return f.read()


def sigwx_issue_utc(now, back=0):
    """조회할 저고도 SIGWX 발표시각(UTC, YYYYMMDDHH). 발표(05·11·17·23UTC) 후 30분이 지난 가장 최근 것, back=1이면 한 번 이전 발표분."""
    t = (now.astimezone(timezone.utc) - timedelta(minutes=30)).replace(minute=0, second=0, microsecond=0)
    while t.hour not in (5, 11, 17, 23):
        t -= timedelta(hours=1)
    t -= timedelta(hours=6 * back)
    return t.strftime('%Y%m%d%H')


class KmaClient:
    def __init__(self, auth_key, config, fetch=urllib_fetch, now=None, timeout=8):
        self.key, self.config, self.fetch, self.timeout = auth_key, config, fetch, timeout
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.cache = {}  # kind -> (fetched_at, items)
        self._t0 = time.time()

    # --- URL ---
    def _url(self, kind, **kw):
        kst = self.now().astimezone(P.KST)
        t_min = kst - timedelta(minutes=kw.pop('lag_min', 2))
        back = kw.pop('back', 0)
        fmt = dict(tm_hour=kst.strftime('%Y%m%d%H00'), tm_min=t_min.strftime('%Y%m%d%H%M'),
                   tm_30ago=(t_min - timedelta(minutes=30)).strftime('%Y%m%d%H%M'), icao='',
                   tmfc_sigwx=sigwx_issue_utc(self.now(), back))
        fmt.update(kw)
        url = ENDPOINTS[kind].format(**fmt)
        return url + ('&' if '?' in url else '?') + 'authKey=' + self.key

    def _fetch_retry(self, url):
        """시간 초과·일시적 연결 오류는 한 번 더 시도(SIGWX는 전체 시간 제한 때문에 제외). 한 종류당 약 12초가 넘으면 재시도하지 않는다."""
        t0 = self._t0
        tmo = min(self.timeout, 6) if 'amo_sigwx' in url else self.timeout   # SIGWX는 최대 3회 시도하므로 짧게
        try:
            return self.fetch(url, timeout=tmo)
        except (TimeoutError, OSError) as e:
            if 'amo_sigwx' in url or time.time() - t0 > 12 or isinstance(e, (PermissionError, FileNotFoundError)):
                raise
            return self.fetch(url, timeout=self.timeout)

    def _get(self, kind, **kw):
        text = self._fetch_retry(self._url(kind, **kw))
        # API허브 오류 응답: {"result":{"status":401,"message":"..."}} — 어느 자료든 오류 사유를 그대로 보여준다.
        if text.lstrip().startswith('{'):
            try:
                res = json.loads(text).get('result') or {}
                if int(res.get('status', 0)) >= 400:
                    raise RuntimeError(f"기상청 오류 {res.get('status')}: {res.get('message', '')}"[:160])
            except (ValueError, TypeError, AttributeError):
                pass
        # typ01 표 형식 응답은 '#' 주석/헤더 줄을 가진다. 없으면 오류 응답(활용신청 안 됨, 인증 실패 등)으로 본다.
        # 저고도 SIGWX는 실제 형식을 확인하기 전이라 이 검사를 하지 않는다(해석 불가는 '해석 불가'로 표시).
        json_ok = kind == 'warn' and text.lstrip().startswith('[')
        if kind not in ('metar', 'taf', 'sigwx') and not json_ok and not any(l.lstrip().startswith('#') for l in text.splitlines()):
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
        if kind == 'sigwx':
            # 최신 발표분이 아직 없거나 오류면 한두 번 이전 발표분으로 다시 시도
            last_err = None
            for back in (0, 1, 2):
                try:
                    items = P.parse_sigwx(self._get('sigwx', back=back), issued=sigwx_issue_utc(now, back))
                except Exception as e:
                    last_err = e
                    continue
                if items:
                    return items
            if last_err is not None:
                raise last_err
            return []
        if kind in ('metar', 'taf'):
            def one(a):
                try:
                    text = self._get(kind, icao=a['icao'])
                except Exception:
                    return []
                if kind == 'metar':
                    parsed = [P.parse_metar_iwxxm(x, ap) for x in P.extract_iwxxm(text, 'METAR') + P.extract_iwxxm(text, 'SPECI')]
                    if not parsed:  # 문자 전문 형식 대비
                        parsed = [P.parse_metar(r, ap, now) for r in P.extract_reports(text, 'METAR') + P.extract_reports(text, 'SPECI')]
                else:
                    parsed = [P.parse_taf_iwxxm(x, ap) for x in P.extract_iwxxm(text, 'TAF')]
                    if not parsed:
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

    def raw(self, kind, limit=4000, icao='RKSS', help=False, summary=False):
        """점검용: 기상청 원본 응답 앞부분(인증키 가림)."""
        url = self._url(kind, icao=icao if icao.isalnum() else 'RKSS')
        if help:   # 설명문 요청: 다른 변수 없이 help=1과 인증키만 보낸다(변수가 틀려도 설명문은 받을 수 있게)
            url = url.split('?')[0] + '?help=1&authKey=' + self.key
        mask = (lambda s: s.replace(self.key, '****')) if self.key else (lambda s: s)
        try:
            body = self.fetch(url, timeout=self.timeout)
            if summary and kind == 'sigwx':
                body = P.summarize_sigwx(body)
            return {'url': mask(url), 'ok': True, 'body': mask(body[:limit])}
        except Exception as e:
            return {'url': mask(url), 'ok': False, 'body': mask(f'{type(e).__name__}: {e}')[:limit]}

    def get(self, kind):
        now = self.now()
        hit = self.cache.get(kind)
        if hit and (now - hit[0]) < timedelta(minutes=TTL_MIN.get(kind, 5)):
            return self._resp(hit[1], hit[0], stale=False)
        self._t0 = time.time()
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
