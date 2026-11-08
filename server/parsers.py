"""기상청 API허브 응답 파서. 어떤 파서도 예외를 밖으로 던지지 않는다(해석 불가 행은 건너뜀)."""
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
            vs, ch, ca = num(r['VS']), num(r['CH_MIN']), num(r['CA_TOT'])
            ceil = round(ch * 100 * FT_PER_M) if (ch is not None and ca is not None and ca >= 6) else None
            out.append({'stn': r['STN'], 'name': st['name'], 'lat': st['lat'], 'lon': st['lon'],
                        'obsTime': kst_to_iso(r['TM']), 'visM': None if vs is None else int(vs * 10),
                        'ceilFt': ceil, 'cloudTenths': None if ca is None else int(ca),
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
        ap = _airport(icao, airports)
        return {'icao': icao, 'name': ap['name'], 'lat': ap['lat'], 'lon': ap['lon'], 'obsTime': iso(obs),
                'visM': vis, 'ceilFt': ceil, 'windDir': wd, 'windKt': wk, 'gustKt': gk, 'raw': raw}
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
