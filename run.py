"""헬기 운항기상 판단 도우미 실행: python run.py  (가짜 자료 시연: python run.py --mock)"""
import argparse, json, os, sys, threading, webbrowser
ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)
from server.kma import KmaClient, mock_fetch, urllib_fetch
from server.web import make_server


def main():
    ap = argparse.ArgumentParser(description='헬기 운항기상 판단 도우미')
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--mock', action='store_true', help='기상청 대신 시험용 자료 사용')
    ap.add_argument('--no-browser', action='store_true')
    a = ap.parse_args()

    with open(os.path.join(ROOT, 'config.json'), encoding='utf-8') as f:
        config = json.load(f)
    local_path = os.path.join(ROOT, 'config.local.json')
    local = {}
    if os.path.exists(local_path):
        with open(local_path, encoding='utf-8') as f:
            local = json.load(f)
    elif not a.mock:
        print('[설정 필요] config.local.example.json 을 config.local.json 으로 복사하고 '
              '기상청 API허브 인증키와 카카오 JavaScript 키를 입력하세요.')
        sys.exit(1)

    client = KmaClient(local.get('kmaAuthKey', ''), config, fetch=mock_fetch if a.mock else urllib_fetch)
    srv = make_server(a.port, client, config, local.get('kakaoJsKey', ''),
                      os.path.join(ROOT, 'logs', 'history.csv'), os.path.join(ROOT, 'web'),
                      access_code=os.environ.get('ACCESS_CODE', ''))
    url = f'http://localhost:{a.port}/'
    print(f'헬기 운항기상 판단 도우미 실행 중: {url}  {"(시험 자료)" if a.mock else ""}  종료: Ctrl+C')
    if not a.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('종료합니다.')


if __name__ == '__main__':
    main()
