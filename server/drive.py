"""구급차(자동차) 이동시간: 카카오모빌리티 자동차 길찾기 API(REST 키 필요) → 키 없음·실패 시 직선거리 기반 추정.
키는 서버 환경변수 KAKAO_REST_KEY에만 둔다(화면·브라우저로 나가지 않음)."""
import json, math, time, urllib.error, urllib.parse, urllib.request

URL = 'https://apis-navi.kakaomobility.com/v1/directions'
_CACHE = {}
TTL = 300


def _haversine_km(a, b):
    r = 6371.0088
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def estimate(o, d, cfg):
    km = _haversine_km(o, d) * float(cfg.get('roadFactor', 1.35))
    return {'ok': True, 'source': 'estimate', 'distanceKm': round(km, 1),
            'durationMin': max(1, round(km / float(cfg.get('roadSpeedKmh', 50)) * 60))}


def _http_get(url, headers, timeout=6):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode('utf-8')


def drive_time(o, d, rest_key, cfg, http_get=_http_get, now=time.time):
    """o, d = (lat, lon). 항상 {ok, source, distanceKm, durationMin[, note]} 반환."""
    key = (round(o[0], 3), round(o[1], 3), round(d[0], 3), round(d[1], 3))
    hit = _CACHE.get(key)
    if hit and now() - hit[0] < TTL:
        return hit[1]
    est = estimate(o, d, cfg)
    if not rest_key:
        est['note'] = '카카오 길찾기 키 없음 — 직선거리 기반 추정'
        return est
    q = urllib.parse.urlencode({'origin': f'{o[1]},{o[0]}', 'destination': f'{d[1]},{d[0]}', 'priority': 'TIME', 'summary': 'true'})
    try:
        out = json.loads(http_get(f'{URL}?{q}', {'Authorization': 'KakaoAK ' + rest_key}))
        route = out['routes'][0]
        if route.get('result_code', 0) != 0:
            raise ValueError(route.get('result_msg') or f"result_code {route.get('result_code')}")
        s = route['summary']
        res = {'ok': True, 'source': 'kakao', 'distanceKm': round(s['distance'] / 1000, 1), 'durationMin': max(1, round(s['duration'] / 60))}
        _CACHE[key] = (now(), res)
        return res
    except urllib.error.HTTPError as e:
        why = {401: '키 오류(REST API 키 확인)', 403: '사용 권한 없음(카카오 길찾기 API 사용 신청·활성화 필요)', 429: '호출 한도 초과'}.get(e.code, f'HTTP {e.code}')
        est['note'] = f'카카오 길찾기 실패: {why} — 직선거리 기반 추정'
        return est
    except Exception as e:      # 경로 없음·형식 오류·네트워크 등 → 추정값으로 대체하고 사유를 표시
        est['note'] = '카카오 길찾기 조회 실패(' + (str(e)[:40] or type(e).__name__) + ') — 직선거리 기반 추정'
        return est
