"""실제 기상청 응답 형식 점검: python server/check_api.py
각 API를 한 번씩 호출해 응답 앞부분과 해석 건수를 출력한다. 출력에서 인증키는 ****로 가린다.
결과를 그대로 복사해 개발 담당(또는 AI)에게 전달하면 해석기를 실제 형식에 맞출 수 있다."""
import json, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from server import parsers as P
from server.kma import ENDPOINTS, KmaClient, urllib_fetch

def _count(kind, text, client):
    ap = client.config.get('airports', [])
    if kind in ('stn_sfc', 'stn_aws'): return len(P.parse_stations(text))
    if kind == 'asos': return len(P.parse_asos(text, {}))
    if kind == 'aws': return len(P.parse_aws(text, {}))
    if kind == 'warn': return len(P.parse_warn(text))
    if kind == 'lightning': return len(P.parse_lightning(text))
    if kind == 'metar': return len([x for x in (P.parse_metar(r, ap) for r in P.extract_reports(text, 'METAR')) if x])
    if kind == 'taf': return len([x for x in (P.parse_taf(r, ap) for r in P.extract_reports(text, 'TAF')) if x])
    return 0

def run_checks(key, config, fetch=urllib_fetch, out=sys.stdout, lines=40):
    client = KmaClient(key, config, fetch=fetch)
    mask = (lambda s: s.replace(key, '****')) if key else (lambda s: s)
    w = lambda s='': out.write(mask(str(s)) + '\n')
    for kind in ENDPOINTS:
        url = client._url(kind, icao='RKSS')
        w('=' * 70); w(f'[{kind}] {url}')
        try:
            text = fetch(url, timeout=10)
        except Exception as e:
            w(f'  호출 실패: {type(e).__name__}: {e}'); continue
        for line in text.splitlines()[:lines]: w('  ' + line[:300])
        n = _count(kind, text, client)
        w(f'  → 해석 결과: {n}건' + ('  ※ 형식 확인 필요' if n == 0 else ''))
    w('=' * 70); w('끝. 위 내용을 복사해 전달하세요(인증키는 가려져 있습니다).')

if __name__ == '__main__':
    with open(os.path.join(ROOT, 'config.json'), encoding='utf-8') as f: cfg = json.load(f)
    try:
        with open(os.path.join(ROOT, 'config.local.json'), encoding='utf-8') as f: k = json.load(f).get('kmaAuthKey', '')
    except FileNotFoundError:
        sys.exit('config.local.json 이 없습니다. config.local.example.json 을 복사해 키를 넣으세요.')
    run_checks(k, cfg)
