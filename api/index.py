"""Vercel 서버리스 함수 입구. 모든 /api/* 요청이 여기로 온다(vercel.json rewrites).
환경변수: KMA_AUTH_KEY(기상청 API허브 키), KAKAO_JS_KEY(카카오 JavaScript 키), KAKAO_REST_KEY(카카오 REST API 키, 선택: 구급차 이동시간), VWORLD_KEY(브이월드 인증키, 선택: 항공사진), ACCESS_CODE(비우면 접속코드 없음)."""
import json, os, sys
from http.server import BaseHTTPRequestHandler
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from server.kma import KmaClient
from server.web import handle_api
from server.store import store_from_env

with open(os.path.join(ROOT, 'config.json'), encoding='utf-8') as f:
    CONFIG = json.load(f)
# 모듈 전역: 같은 인스턴스가 살아 있는 동안 5분 캐시를 공유한다.
STORE = store_from_env()
CLIENT = KmaClient(os.environ.get('KMA_AUTH_KEY', ''), CONFIG, persist=STORE)


class handler(BaseHTTPRequestHandler):
    def _run(self, method):
        n = int(self.headers.get('Content-Length', 0) or 0)
        body = self.rfile.read(min(n, 30000)) if n else b''
        status, headers, out = handle_api(method, self.path, dict(self.headers), body, client=CLIENT, config=CONFIG,
                                          kakao_js_key=os.environ.get('KAKAO_JS_KEY', ''),
                                          access_code=os.environ.get('ACCESS_CODE', ''), log_path=None, notam_store=STORE,
                                          client_ip=(self.headers.get('x-forwarded-for') or self.headers.get('x-real-ip') or '').split(',')[0].strip(),
                                          kakao_rest_key=os.environ.get('KAKAO_REST_KEY', ''), vworld_key=os.environ.get('VWORLD_KEY', ''))
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_GET(self):
        self._run('GET')

    def do_POST(self):
        self._run('POST')

    def do_PUT(self):
        self._run('PUT')

    def do_DELETE(self):
        self._run('DELETE')
