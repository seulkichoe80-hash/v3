"""기상청 API허브 응답 파서. 어떤 파서도 예외를 밖으로 던지지 않는다(해석 불가 행은 건너뜀)."""
import math
import re
from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))
FT_PER_M = 3.28084
MISSING = {-9.0, -99.0, -99.9, -999.0, -9.9}
HANGUL = re.compile(r'[가-힣]')

ASOS_COLS = ('TM STN WD WS GST_WD GST_WS GST_TM PA PS PT PR TA TD HM PV RN RN_DAY RN_JUN RN_INT '
             'SD_HR3 SD_DAY SD_TOT WC WP WW CA_TOT CA_MID CH_MIN CT CT_TOP CT_MID CT_LOW VS SS SI '
             'ST_GD TS TE_005 TE_01 TE_02 TE_03 ST_SEA WH BF IR IX').split()
AWS_COLS = 'TM STN WD1 WS1 WDS WSS WD10 WS10 TA RE RN15 RN60 RN12H RNDAY HM PA PS TD'.split()
WARN_CODE = {'W': '강풍', 'R': '호우', 'C': '한파', 'D': '건조', 'O': '해일', 'N': '지진해일',
             'V': '풍랑', 'T': '태풍', 'S': '대설', 'Y': '황사', 'H': '폭염', 'F': '안개'}
WARN_LVL = {'1': '예비', '2': '주의보', '3': '경보'}


def num(s):
    try:
        v = float(str(s).strip())
    except (TypeError, ValueError):
        return None
    return None if v in MISSING else v


def iso(dt):
    return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def kst_to_iso(tm):
    """YYYYMMDDHHMI[SS] (KST) → ISO UTC. 실패 시 None."""
    tm = str(tm).strip()
    try:
        fmt = '%Y%m%d%H%M%S' if len(tm) == 14 else '%Y%m%d%H%M'
        return iso(datetime.strptime(tm, fmt).replace(tzinfo=KST))
    except ValueError:
        return None


def _data_lines(text):
    for line in str(text or '').splitlines():
        s = line.strip()
        if not s or s.startswith('#') or s.startswith('<'):
            continue
        yield s


def parse_table(text, columns=None):
    """# 주석 무시, 공백/쉼표 구분 자동. columns 없으면 마지막 # 헤더 줄에서 이름 추출."""
    lines = str(text or '').splitlines()
    if columns is None:
        heads = [l.lstrip('#').strip() for l in lines if l.startswith('#') and re.search(r'[A-Z_]{2,}', l)
                 and '7777' not in l and '---' not in l]
        columns = re.split(r'[,\s]+', heads[-1]) if heads else []
        columns = [c for c in columns if c]
    rows = []
    for s in _data_lines(text):
        parts = [p.strip() for p in (s.split(',') if ',' in s else s.split())]
        if len(parts) < 2:
            continue
        rows.append({c: (parts[i] if i < len(parts) else '') for i, c in enumerate(columns)})
    return rows


def parse_stations(text):
    out = {}
    for s in _data_lines(text):
        p = s.split()
        if len(p) < 4 or not p[0].isdigit():
            continue
        lon, lat = num(p[1]), num(p[2])
        if lon is None or lat is None:
            continue
        name = next((x for x in p[3:] if HANGUL.search(x)), p[0])
        out[p[0]] = {'name': name, 'lat': lat, 'lon': lon}
    return out


def _st(stations, stn):
    return stations.get(stn, {'name': stn, 'lat': None, 'lon': None})


def parse_asos(text, stations):
    out = []
    for r in parse_table(text, ASOS_COLS):
        try:
            if not r['TM'].isdigit():
                continue
            st = _st(stations, r['STN'])
            vs, ch, ca, cm = num(r['VS']), num(r['CH_MIN']), num(r['CA_TOT']), num(r['CA_MID'])
            # 운고 = 가장 낮은 구름층이 5/8 이상 덮인 경우의 높이(제2조 32호). 층별 자료가 없어 '중하층 운량 6/10 이상'일 때 최저운고를 운고로 근사한다.
            # 중하층 운량이 결측이면 전운량이 6/10 미만일 때만 '운고 없음'으로 보고, 그 외에는 판단하지 않는다(자료없음).
            if cm is not None:
                low_cover = cm >= 6
                undetermined = False
            else:
                low_cover = False
                undetermined = ca is not None and ca >= 6
            ceil = round(ch * 100 * FT_PER_M) if (low_cover and ch is not None) else None
            out.append({'stn': r['STN'], 'name': st['name'], 'lat': st['lat'], 'lon': st['lon'],
                        'obsTime': kst_to_iso(r['TM']), 'visM': None if vs is None else int(vs * 10),
                        'ceilFt': ceil, 'cloudTenths': None if ca is None else int(ca), 'midTenths': None if cm is None else int(cm),
                        'ceilUnknown': undetermined or (low_cover and ch is None),
                        'windDir': num(r['WD']), 'windMs': num(r['WS']), 'gustMs': num(r['GST_WS'])})
        except (KeyError, ValueError, TypeError):
            continue
    return out


def parse_aws(text, stations):
    out = []
    for r in parse_table(text, AWS_COLS):
        try:
            if not r['TM'].isdigit():
                continue
            st = _st(stations, r['STN'])
            wd = num(r['WD10'])
            out.append({'stn': r['STN'], 'name': st['name'], 'lat': st['lat'], 'lon': st['lon'],
                        'obsTime': kst_to_iso(r['TM']), 'windDir': None if wd is None else int(wd),
                        'windMs': num(r['WS10']), 'gustMs': num(r['WSS'])})
        except (KeyError, ValueError, TypeError):
            continue
    return out


def parse_warn(text):
    out = []
    src = str(text or '').strip()
    if src.startswith('['):  # 실제 응답(disp=1): JSON 배열, 값 뒤 공백 패딩
        try:
            rows = __import__('json').loads(src)
        except ValueError:
            rows = []
        for r in rows if isinstance(rows, list) else []:
            if not isinstance(r, dict):
                continue
            g = lambda k: str(r.get(k, '') or '').strip()
            kind, level = WARN_CODE.get(g('WRN'), g('WRN')), WARN_LVL.get(g('LVL'), g('LVL'))
            if not HANGUL.search(kind + level):
                continue
            out.append({'regUp': g('REG_UP'), 'regUpName': g('REG_UP_KO'), 'regId': g('REG_ID'), 'regName': g('REG_KO'),
                        'tmFc': kst_to_iso(g('TM_FC')), 'tmEf': kst_to_iso(g('TM_EF')), 'kind': kind, 'level': level, 'cmd': g('CMD')})
        return out
    for s in _data_lines(text):
        p = [x.strip() for x in s.split(',')]
        if len(p) < 9:
            continue
        kind = WARN_CODE.get(p[6], p[6])
        level = WARN_LVL.get(p[7], p[7])
        if not HANGUL.search(kind + level):
            continue
        out.append({'regUp': p[0], 'regUpName': p[1], 'regId': p[2], 'regName': p[3], 'tmFc': kst_to_iso(p[4]),
                    'tmEf': kst_to_iso(p[5]), 'kind': kind, 'level': level, 'cmd': p[8]})
    return out


def parse_lightning(text):
    """행마다 날짜(12~14자리)와 한반도 범위 위·경도 실수를 찾아낸다(컬럼 순서 변화에 강함)."""
    out = []
    for s in _data_lines(text):
        p = re.split(r'[,\s]+', s)
        tm = next((x for x in p if re.fullmatch(r'\d{12}|\d{14}', x)), None)
        fl = [num(x) for x in p if re.fullmatch(r'-?\d+\.\d+', x)]
        lat = next((v for v in fl if v is not None and 30 <= v <= 44), None)
        lon = next((v for v in fl if v is not None and 120 <= v <= 135), None)
        if tm and lat is not None and lon is not None:
            out.append({'time': kst_to_iso(tm), 'lat': lat, 'lon': lon})
    return out


REPORT_RE = {k: re.compile(r'\b(' + k + r'(?:\s+(?:COR|AMD))?\s+RK[A-Z]{2}\s[^=<"]*?=)') for k in ('METAR', 'SPECI', 'TAF')}


def extract_reports(text, kind):
    src = str(text or '').replace('\\n', ' ')
    return [re.sub(r'\s+', ' ', m.group(1)).strip() for m in REPORT_RE[kind].finditer(src)]


def _airport(icao, airports):
    return next((a for a in airports if a['icao'] == icao), {'name': icao, 'lat': None, 'lon': None})


def _ddhhmm(dd, hh, mm, now):
    """일·시·분(UTC) → now 기준 가장 가까운 달로 보정한 datetime."""
    cands = []
    for dm in (-1, 0, 1):
        y, m = now.year, now.month + dm
        if m == 0: y, m = y - 1, 12
        if m == 13: y, m = y + 1, 1
        try:
            base = datetime(y, m, 1, tzinfo=timezone.utc)
            cands.append(base + timedelta(days=dd - 1, hours=hh, minutes=mm))
        except ValueError:
            pass
    return min(cands, key=lambda d: abs((d - now).total_seconds())) if cands else None


def _vis_ceil(tokens):
    vis, ceil = None, None
    for t in tokens:
        if t == 'CAVOK':
            vis = 10000
        elif re.fullmatch(r'\d{4}', t):
            vis = 10000 if t == '9999' else int(t)
        m = re.fullmatch(r'(BKN|OVC|VV)(\d{3})(CB|TCU)?', t)
        if m:
            h = int(m.group(2)) * 100
            ceil = h if ceil is None else min(ceil, h)
    return vis, ceil


def parse_metar(raw, airports, now=None):
    now = now or datetime.now(timezone.utc)
    try:
        tk = raw.replace('=', '').split()
        i = next(i for i, t in enumerate(tk) if re.fullmatch(r'RK[A-Z]{2}', t))
        icao = tk[i]
        tm = re.fullmatch(r'(\d{2})(\d{2})(\d{2})Z', tk[i + 1])
        obs = _ddhhmm(int(tm.group(1)), int(tm.group(2)), int(tm.group(3)), now)
        rest = tk[i + 2:]
        cut = [k for k, t in enumerate(rest) if t in ('NOSIG', 'TEMPO', 'BECMG', 'RMK')]
        body = rest[:cut[0]] if cut else rest
        wd = wk = gk = None
        for t in body:
            w = re.fullmatch(r'(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT', t)
            if w:
                wd = None if w.group(1) == 'VRB' else int(w.group(1)); wk = int(w.group(2))
                gk = int(w.group(3)) if w.group(3) else None
                break
        vis, ceil = _vis_ceil(body)
        # 운고 높이 미상: BKN///·OVC///·VV/// 이거나, 구름 정보 그룹이 아예 없음
        no_ceil_ok = any(t in ('CAVOK', 'NSC', 'NCD', 'SKC', 'CLR') or re.fullmatch(r'(FEW|SCT)\d{3}(CB|TCU)?', t) for t in body)
        unknown = ceil is None and (any(re.fullmatch(r'(BKN|OVC|VV)///.*', t) for t in body) or not no_ceil_ok)
        ap = _airport(icao, airports)
        return {'icao': icao, 'name': ap['name'], 'lat': ap['lat'], 'lon': ap['lon'], 'obsTime': iso(obs),
                'visM': vis, 'ceilFt': ceil, 'ceilUnknown': unknown, 'windDir': wd, 'windKt': wk, 'gustKt': gk, 'raw': raw}
    except (StopIteration, AttributeError, IndexError, ValueError, TypeError):
        return None


def parse_taf(raw, airports, now=None):
    now = now or datetime.now(timezone.utc)
    try:
        tk = raw.replace('=', '').split()
        i = next(i for i, t in enumerate(tk) if re.fullmatch(r'RK[A-Z]{2}', t))
        icao = tk[i]
        it = re.fullmatch(r'(\d{2})(\d{2})(\d{2})Z', tk[i + 1])
        issued = _ddhhmm(int(it.group(1)), int(it.group(2)), int(it.group(3)), now)
        vm = re.fullmatch(r'(\d{2})(\d{2})/(\d{2})(\d{2})', tk[i + 2])

        def per(d1, h1):  # 24시 표기 대응
            d = _ddhhmm(int(d1), 0, 0, issued)
            return d + timedelta(hours=int(h1))
        vfrom, vto = per(vm.group(1), vm.group(2)), per(vm.group(3), vm.group(4))
        groups, cur = [], {'type': 'BASE', 'from': vfrom, 'to': vto, 'tokens': []}
        j = i + 3
        while j < len(tk):
            t = tk[j]
            fm = re.fullmatch(r'FM(\d{2})(\d{2})(\d{2})', t)
            pr = re.fullmatch(r'PROB\d{2}', t)
            if fm or t in ('BECMG', 'TEMPO') or pr:
                groups.append(cur)
                if fm:
                    start = per(fm.group(1), fm.group(2)) + timedelta(minutes=int(fm.group(3)))
                    cur = {'type': 'FM', 'from': start, 'to': vto, 'tokens': []}
                else:
                    typ = 'PROB' if pr else t
                    if pr and j + 1 < len(tk) and tk[j + 1] == 'TEMPO':
                        j += 1
                    p = re.fullmatch(r'(\d{2})(\d{2})/(\d{2})(\d{2})', tk[j + 1])
                    j += 1
                    cur = {'type': typ, 'from': per(p.group(1), p.group(2)), 'to': per(p.group(3), p.group(4)), 'tokens': []}
                    if typ == 'BECMG':
                        cur['to'] = vto
            else:
                cur['tokens'].append(t)
            j += 1
        groups.append(cur)
        # BASE·FM 구간은 다음 FM 시작까지
        mains = [g for g in groups if g['type'] in ('BASE', 'FM')]
        for a, b in zip(mains, mains[1:]):
            a['to'] = b['from']
        out = []
        for g in groups:
            vis, ceil = _vis_ceil(g['tokens'])
            out.append({'type': g['type'], 'from': iso(g['from']), 'to': iso(g['to']), 'visM': vis, 'ceilFt': ceil})
        ap = _airport(icao, airports)
        return {'icao': icao, 'name': ap['name'], 'lat': ap['lat'], 'lon': ap['lon'], 'issued': iso(issued),
                'validFrom': iso(vfrom), 'validTo': iso(vto), 'groups': out, 'raw': raw}
    except (StopIteration, AttributeError, IndexError, ValueError, TypeError):
        return None


# ---------------- IWXXM (기상청 AmmIwxxmService 실제 응답 형식) ----------------
import json as _json
import xml.etree.ElementTree as _ET


def _ln(tag):
    return tag.rsplit('}', 1)[-1]


def _find(el, *names):
    """하위 요소 중 로컬 이름 경로가 names인 첫 요소."""
    cur = [el]
    for n in names:
        nxt = []
        for c in cur:
            nxt += [x for x in c.iter() if _ln(x.tag) == n and x is not c]
        if not nxt:
            return None
        cur = nxt[:1]
    return cur[0]


def _children(el, name):
    return [x for x in el if _ln(x.tag) == name]


def _attr(el, name):
    for k, v in el.attrib.items():
        if _ln(k) == name:
            return v
    return None


def _num_el(el):
    if el is None or _attr(el, 'nil') == 'true' or _attr(el, 'nilReason'):
        return None
    try:
        return float((el.text or '').strip())
    except ValueError:
        return None


def extract_iwxxm(text, kind):
    """JSON 응답(items.item[].metarMsg/tafMsg) 또는 원문에서 IWXXM XML 문자열 목록."""
    tag = '<iwxxm:' + kind
    out = []

    def walk(o):
        if isinstance(o, dict):
            for v in o.values(): walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
        elif isinstance(o, str) and tag in o:
            out.append(o)
    try:
        walk(_json.loads(text))
    except (ValueError, TypeError):
        out = re.findall(r'(<iwxxm:' + kind + r'[\s>].*?</iwxxm:' + kind + r'>)', str(text or ''), flags=re.S)
    return out


def _iw_vis_ceil(fc):
    """MeteorologicalAerodromeObservation/Forecast → (visM, ceilFt, ceilUnknown, hasCloudInfo)."""
    if _attr(fc, 'cloudAndVisibilityOK') == 'true':
        return 10000, None, False, True
    v = _num_el(_find(fc, 'prevailingVisibility'))
    vis = None if v is None else (10000 if v >= 9999 else int(v))
    cloud = _find(fc, 'cloud')
    if cloud is None:
        return vis, None, True, False
    if _attr(cloud, 'nilReason'):  # NSC/NCD 등 '운고 없음'
        return vis, None, False, True
    ceil, unknown = None, False
    vv = _find(cloud, 'verticalVisibility')
    if vv is not None:
        h = _num_el(vv)
        if h is None: unknown = True
        else: ceil = int(h)
    for layer in [x for x in cloud.iter() if _ln(x.tag) == 'CloudLayer']:
        amt = _find(layer, 'amount')
        href = (_attr(amt, 'href') or '') if amt is not None else ''
        if href.endswith(('/BKN', '/OVC')):
            h = _num_el(_find(layer, 'base'))
            if h is None: unknown = True
            else: ceil = int(h) if ceil is None else min(ceil, int(h))
    return vis, ceil, (unknown and ceil is None), True


def _tpos(el, *names):
    e = _find(el, *names)
    return (e.text or '').strip() if e is not None and e.text else None


def _isoz(s):
    return s if s and s.endswith('Z') else (s + 'Z' if s else None)


def parse_metar_iwxxm(xml, airports):
    try:
        root = _ET.fromstring(xml)
        icao = _tpos(root, 'locationIndicatorICAO') or _tpos(root, 'designator')
        obs_el = _find(root, 'observation')
        fc = _find(obs_el, 'MeteorologicalAerodromeObservation') if obs_el is not None else None
        if not icao or fc is None:
            return None
        vis, ceil, unknown, _ = _iw_vis_ceil(fc)
        wind = _find(fc, 'AerodromeSurfaceWind')
        wd = wk = gk = None
        if wind is not None:
            d = _num_el(_find(wind, 'meanWindDirection'))
            wd = None if d is None else int(d)
            s_el = _find(wind, 'meanWindSpeed'); s = _num_el(s_el)
            g_el = _find(wind, 'windGustSpeed'); g = _num_el(g_el)
            f = (1 / 0.5144) if s_el is not None and 'm/s' in (_attr(s_el, 'uom') or '') else 1
            wk = None if s is None else round(s * f); gk = None if g is None else round(g * f)
        ap = _airport(icao, airports)
        return {'icao': icao, 'name': ap['name'], 'lat': ap['lat'], 'lon': ap['lon'],
                'obsTime': _isoz(_tpos(root, 'observationTime', 'timePosition')),
                'visM': vis, 'ceilFt': ceil, 'ceilUnknown': unknown, 'windDir': wd, 'windKt': wk, 'gustKt': gk,
                'raw': 'IWXXM'}
    except (_ET.ParseError, ValueError, TypeError, AttributeError):
        return None


CHANGE = {'BECOMING': 'BECMG', 'TEMPORARY_FLUCTUATIONS': 'TEMPO', 'FROM': 'FM'}


def parse_taf_iwxxm(xml, airports):
    try:
        root = _ET.fromstring(xml)
        icao = _tpos(root, 'locationIndicatorICAO') or _tpos(root, 'designator')
        vp = _find(root, 'validPeriod')
        vfrom, vto = _isoz(_tpos(vp, 'beginPosition')), _isoz(_tpos(vp, 'endPosition'))
        if not icao or not vfrom or not vto:
            return None
        groups = []
        for wrap_name in ('baseForecast', 'changeForecast'):
            for wrap in _children(root, wrap_name):
                fc = _find(wrap, 'MeteorologicalAerodromeForecast')
                if fc is None:
                    continue
                ind = _attr(fc, 'changeIndicator')
                typ = 'BASE' if wrap_name == 'baseForecast' else CHANGE.get(ind, 'PROB' if ind and ind.startswith('PROBABILITY') else 'TEMPO')
                pt = _find(fc, 'phenomenonTime')
                b = _isoz(_tpos(pt, 'beginPosition') or _tpos(pt, 'timePosition')) if pt is not None else vfrom
                e = _isoz(_tpos(pt, 'endPosition')) if pt is not None else None
                vis, ceil, _, _ = _iw_vis_ceil(fc)
                if typ in ('BECMG', 'FM') or not e:
                    e = vto
                groups.append({'type': typ, 'from': b or vfrom, 'to': e, 'visM': vis, 'ceilFt': ceil})
        mains = [g for g in groups if g['type'] in ('BASE', 'FM')]
        for a, b in zip(mains, mains[1:]):
            a['to'] = b['from']
        ap = _airport(icao, airports)
        return {'icao': icao, 'name': ap['name'], 'lat': ap['lat'], 'lon': ap['lon'],
                'issued': _isoz(_tpos(root, 'issueTime', 'timePosition')), 'validFrom': vfrom, 'validTo': vto,
                'groups': groups, 'raw': 'IWXXM'}
    except (_ET.ParseError, ValueError, TypeError, AttributeError):
        return None


# ---------------- 저고도 중요기상예보(SIGWX) ----------------
# 공공데이터포털 설명: "요소 종류, 요소 이름, 위경도값". 실제 컬럼 순서를 확인하기 전이라
# 행에서 한반도 범위 위·경도 쌍과 글자(종류·이름)를 찾아 같은 요소끼리 묶는 방식으로 해석한다.
SIGWX_KIND = [('ICE', ('ICE', 'ICING', '착빙')), ('TURB', ('TURB', 'KTG', 'TABUL', '난류', '난기류')),
              ('MTN', ('MT OBSC', 'MTW', 'MOUNTAIN', '산악')),
              ('WIND', ('SFC_WIND', 'WIND_STRONG', 'L_WIND', '지상풍')), ('VIS', ('SFC_VIS', 'VIS', '시정', 'FG', 'BR', '안개', 'HZ')),
              ('TS', ('CB', 'TS', '뇌우', '적란운')), ('CLD', ('CLD', 'BKN', 'OVC', '구름')),
              ('FZL', ('FZLVL', 'FRZ', 'FREEZING', '결빙고도', '0°C', '0℃', '0도'))]


def _sigwx_kind(label):
    up = label.upper()
    for k, keys in SIGWX_KIND:
        if any(key.upper() in up for key in keys):
            return k
    return 'ETC'


def _parse_sigwx_lines(text):
    groups, order = {}, []
    for s in _data_lines(text):
        toks = [t for t in re.split(r'[,\t ]+', s) if t]
        if len(toks) < 3:
            continue
        nums = [(i, num(t)) for i, t in enumerate(toks) if re.fullmatch(r'-?\d+\.\d+', t)]
        pts, used = [], set()
        for (i1, a), (i2, b) in zip(nums, nums[1:]):
            if i1 in used or a is None or b is None:
                continue
            if 30 <= a <= 45 and 115 <= b <= 135:
                pts.append({'lat': a, 'lon': b}); used |= {i1, i2}
            elif 115 <= a <= 135 and 30 <= b <= 45:   # 경도·위도 순서
                pts.append({'lat': b, 'lon': a}); used |= {i1, i2}
        if not pts:
            continue
        times = [t for t in toks if re.fullmatch(r'\d{12}', t)]
        words = [t for t in toks if not re.fullmatch(r'-?\d+(\.\d+)?', t)]
        ints = [t for t in toks if re.fullmatch(r'\d{1,3}', t)]
        label = ' '.join(words) or '기타'
        key = (times[0] if times else '', ints[0] if (ints and len(pts) == 1) else '', label)
        if key not in groups:
            groups[key] = {'kind': _sigwx_kind(label), 'label': label, 'issued': kst_to_iso(times[0]) if times else None, 'points': []}
            order.append(key)
        groups[key]['points'] += pts
    return [groups[k] for k in order]


def _raw_pairs(v):
    """pt 값에서 숫자 쌍 (a, b)을 모은다(범위 검사 없음). 문자열·[[a,b],…]·[{lat,lon}|{x,y},…]·[a,b,a,b…] 지원."""
    raw = []
    if isinstance(v, str):
        nums = [float(x) for x in re.findall(r'-?\d+(?:\.\d+)?', v)]
        raw = list(zip(nums[0::2], nums[1::2]))
    elif isinstance(v, (list, tuple)):
        if v and all(isinstance(x, (int, float)) for x in v):
            raw = list(zip(v[0::2], v[1::2]))
        else:
            for x in v:
                if isinstance(x, (list, tuple)) and len(x) >= 2 and all(isinstance(y, (int, float)) for y in x[:2]):
                    raw.append((x[0], x[1]))
                elif isinstance(x, dict):
                    a = x.get('lat', x.get('LAT')); b = x.get('lon', x.get('LON', x.get('lng')))
                    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
                        raw.append((a, b))
                elif isinstance(x, str):
                    raw += _raw_pairs(x)
    return raw


def _latlon_pairs(v):
    """(위도, 경도) 쌍만 남긴다. 한반도 범위(위도 30~45, 경도 115~135)가 아니면 버린다(화면 좌표 등). 경도·위도 순서도 범위로 구분."""
    out = []
    for a, b in _raw_pairs(v):
        if 30 <= a <= 45 and 115 <= b <= 135:
            out.append({'lat': float(a), 'lon': float(b)})
        elif 115 <= a <= 135 and 30 <= b <= 45:
            out.append({'lat': float(b), 'lon': float(a)})
    return out


def _walk_sigwx(o, found):
    if isinstance(o, dict):
        if 'pt' in o and any(k in o for k in ('item_type', 'item_name', 'label', 'contour_name')):
            found.append(o)
        else:
            for v in o.values():
                _walk_sigwx(v, found)
    elif isinstance(o, list):
        for v in o:
            _walk_sigwx(v, found)


_MERC_R = 6378137.0
_MERC_O = 20037508.342789244      # 웹지도(EPSG:3857) 세계 범위의 절반(m)


def _merc_to_latlon(x, y):
    """기상청 SIGWX <list_pt>의 투영 좌표 → (위도, 경도). 웹지도 미터 좌표를 좌상단 원점(오른쪽 +x, 아래쪽 +y)으로 옮긴 값이다.
    실제 응답으로 화면 모서리가 위도 39.0/27.5, 경도 121.0/135.0으로 정확히 계산됨을 확인했다(2026-11-09)."""
    lon = math.degrees((x - _MERC_O) / _MERC_R)
    lat = math.degrees(2 * math.atan(math.exp((_MERC_O - y) / _MERC_R)) - math.pi / 2)
    return lat, lon


def _xml_walk(node):
    """하위 요소를 돌되, 화면 그림용 <fpv> 안(픽셀 좌표)은 건너뛴다."""
    for c in node:
        if _ln(c.tag).lower() in ('fpv', 'list_pt_fpv'):
            continue
        yield c
        yield from _xml_walk(c)


def _xml_points(el):
    """item의 위치를 [{lat,lon}]으로. 투영 좌표(큰 숫자)는 변환하고, 위경도 값은 그대로 쓴다. 한반도 주변(위도 15~55, 경도 100~160)이 아니면 버린다."""
    out, plain = [], []
    if el.attrib.get('pt'):
        plain.append(el.attrib['pt'])
    for d in _xml_walk(el):
        if _ln(d.tag).lower() not in ('pt', 'point', 'p', 'pos', 'position', 'coord', 'latlon', 'lonlat'):
            continue
        a = {k.lower(): v for k, v in d.attrib.items()}
        la, lo = a.get('lat') or a.get('y'), a.get('lon') or a.get('lng') or a.get('x')
        txt = (d.text or '').strip()
        try:
            if la is not None and lo is not None:
                fx, fy = float(lo), float(la)                     # x=경도 쪽, y=위도 쪽
                if abs(fx) > 1e6 and abs(fy) > 1e6:               # 투영 좌표
                    lat, lon = _merc_to_latlon(fx, fy)
                    if 15 <= lat <= 55 and 100 <= lon <= 160:
                        out.append({'lat': lat, 'lon': lon})
                else:
                    plain.append([float(la), float(lo)])
            elif txt:
                plain.append(txt)
            elif a:
                plain.append(' '.join(a.values()))
        except ValueError:
            continue
    return out + _latlon_pairs(plain)


def _xml_items(root):
    return [e for e in root.iter() if _ln(e.tag) == 'item' and any(k in e.attrib for k in ('item_type', 'contour_name', 'label', 'item_name'))]


def _alt_from_label(label):
    """아이콘 라벨 "XXX\n060" → 위쪽(상한)/아래쪽(하한) 고도. XXX는 차트 범위 밖(제한 없음). 값은 FL(백 피트 단위)."""
    parts = [t for t in re.split(r'\s+', str(label or '').strip()) if t]
    if len(parts) != 2:
        return None
    def fl(t):
        return int(t) * 100 if re.fullmatch(r'\d{3}', t) else None
    top, base = fl(parts[0]), fl(parts[1])
    if top is None and base is None:
        return None
    if base is not None and top is None:
        text = f'FL{base // 100:03d} 이상'
    elif top is not None and base is None:
        text = f'FL{top // 100:03d} 이하'
    else:
        text = f'FL{base // 100:03d}~FL{top // 100:03d}'
    return {'baseFt': base, 'topFt': top, 'text': text}


def _inside(lat, lon, poly):
    c = False
    for i in range(len(poly)):
        a, b = poly[i], poly[i - 1]
        if (a['lat'] > lat) != (b['lat'] > lat) and lon < (b['lon'] - a['lon']) * (lat - a['lat']) / (b['lat'] - a['lat']) + a['lon']:
            c = not c
    return c


def _parse_sigwx_xml(src, iso_issued):
    try:
        root = _ET.fromstring(src)
    except _ET.ParseError:
        return []
    parent = {c: p for p in root.iter() for c in p}
    def layer_of(e):
        while e in parent:
            e = parent[e]
            if _ln(e.tag).lower() in ('low', 'mid', 'high'):
                return _ln(e.tag).lower()
        return None
    out = []
    for e in _xml_items(root):
        a = e.attrib
        name = str(a.get('contour_name') or '')
        label = ' '.join(str(a.get(k) or '') for k in ('item_name', 'label')).strip()
        kind = _sigwx_kind(f"{name} {label}")
        pts = _xml_points(e)
        it = {'kind': kind, 'label': (label or name or '기타'), 'contour': name, 'layer': layer_of(e), 'issued': iso_issued, 'points': pts,
              'geo': bool(pts), 'closed': str(a.get('is_close', 'true')).lower() in ('true', '1'), 'icon': str(a.get('item_type')) == '7',
              '_rawlabel': str(a.get('label') or '')}
        if kind == 'FZL':
            m = re.search(r'0\s*[°º℃]\s*C?\s*[:：]?\s*(\d{3})', label)
            if m:
                it['fzlFt'] = int(m.group(1)) * 100
        out.append(it)
    # 고도 정보: 구역 안에 놓인 아이콘(같은 그림 종류·같은 층)의 라벨 "XXX\n060"에서 읽는다
    icons = [x for x in out if not x['closed'] and x['points'] and _alt_from_label(x['_rawlabel'])]
    for x in out:
        if x['closed'] and len(x['points']) >= 3 and x['kind'] not in ('FZL',):
            for ic in icons:
                if ic['contour'] == x['contour'] and ic['layer'] == x['layer'] and _inside(ic['points'][0]['lat'], ic['points'][0]['lon'], x['points']):
                    x['alt'] = _alt_from_label(ic['_rawlabel'])
                    break
    for x in out:
        x.pop('_rawlabel', None)
    return out


def summarize_sigwx(text):
    """형식 확인용 요약(점검 화면): 층·종류별 개수와 위경도 변환 범위를 한 화면에 보이도록 압축한다."""
    from collections import Counter
    src = str(text or '').strip()
    if not src.startswith('<'):
        return '해석할 수 없는 형식입니다(XML 아님). 앞부분:\n' + src[:600]
    items = _parse_sigwx_xml(src, None)
    try:
        root = _ET.fromstring(src)
    except _ET.ParseError as e:
        return f'XML을 해석할 수 없습니다({e}). 앞부분:\n' + src[:600]
    lines = ['[구조 요약]', f'루트: {_ln(root.tag)} ' + ' '.join(f'{k}={v}' for k, v in list(root.attrib.items())[:8]),
             f'item {len(items)}건']
    cnt = Counter((x['layer'] or '-', x['contour'], x['kind'], '구역' if x['closed'] else '선·아이콘') for x in items)
    for (ly, c, k, shape), n in sorted(cnt.items()):
        lines.append(f'  {ly:>3} | {c} | {k} | {shape} ×{n}')
    allp = [p for x in items for p in x['points']]
    if allp:
        lines.append('위경도로 변환된 위치: %d개 → 위도 %.2f~%.2f, 경도 %.2f~%.2f' % (len(allp), min(p['lat'] for p in allp), max(p['lat'] for p in allp),
                                                                                    min(p['lon'] for p in allp), max(p['lon'] for p in allp)))
    else:
        lines.append('위경도로 변환된 위치: 0개 (위치 형식을 확인해야 합니다)')
    fz = sorted({x['fzlFt'] for x in items if x.get('fzlFt')})
    if fz:
        lines.append('0℃ 고도선: ' + ', '.join(f'{v}ft' for v in fz))
    alts = [f"{x['kind']} {x['alt']['text']}" for x in items if x.get('alt')]
    if alts:
        lines.append('구역 고도: ' + ', '.join(alts[:8]))
    return '\n'.join(lines)


def parse_sigwx(text, issued=None):
    """저고도 중요기상예보. issued: 조회한 발표시각 tmfc(UTC, YYYYMMDDHH). JSON(출력 변수 item_type·item_name·label·pt)을 우선 해석하고, 아니면 텍스트 행 형식으로 해석한다."""
    iso_issued = None
    if issued and re.fullmatch(r'\d{10}', str(issued)):
        iso_issued = datetime.strptime(str(issued), '%Y%m%d%H').replace(tzinfo=timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    out = []
    src = str(text or '').strip()
    if src.startswith('<'):
        return _parse_sigwx_xml(src, iso_issued)
    if src[:1] in '[{':
        try:
            found = []
            _walk_sigwx(_json.loads(src), found)
        except ValueError:
            found = []
        for o in found:
            pts = _latlon_pairs(o.get('pt'))
            if not pts:
                continue
            label = ' '.join(str(o.get(k) or '') for k in ('item_name', 'label', 'item_type')).strip() or '기타'
            kind = _sigwx_kind(str(o.get('item_type') or '') + ' ' + label)
            out.append({'kind': kind, 'label': label, 'issued': iso_issued, 'points': pts})
        if out:
            return out
    out = _parse_sigwx_lines(text)
    if iso_issued:
        for x in out:
            x['issued'] = x['issued'] or iso_issued
    return out
