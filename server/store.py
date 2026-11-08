"""상황실 공유 저장소: NOTAM 칸(1~MAX_SLOTS)과 주요지점(최대 MAX_PLACES).
저장 방식(해시 hall/hset/hdel)만 바꿔 끼운다.
- UpstashStore: Vercel 연결 Upstash Redis(REST). 환경변수 KV_REST_API_URL/TOKEN 등(접두어 자동 인식)
- FileStore: 로컬 실행판(logs/notams.json)
- MemoryStore: 테스트"""
import json, math, os, threading, time, urllib.request, uuid
from datetime import datetime, timezone

MAX_SLOTS = 10
MAX_TEXT = 20000
MAX_PLACES = 500
KEY = 'heliwx:notams'
PLACES_KEY = 'heliwx:places'


def _now():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _check(slot, text=''):
    if not isinstance(slot, int) or not 1 <= slot <= MAX_SLOTS:
        raise ValueError(f'칸 번호는 1~{MAX_SLOTS}')
    if len(text) > MAX_TEXT:
        raise ValueError(f'칸당 {MAX_TEXT}자 이내')


class _Ops:
    """NOTAM 칸·주요지점 기능. 하위 클래스가 hall/hset/hdel을 구현한다."""

    # 호출 제한(접속코드 오입력) 카운터: 기본은 프로세스 메모리, UpstashStore는 Redis(INCR+EXPIRE)
    def _rl_map(self):
        return self.__dict__.setdefault('_rl', {})

    def rl_count(self, key):
        c, exp = self._rl_map().get(key, (0, 0))
        return c if exp > time.time() else 0

    def rl_hit(self, key, ttl):
        c, exp = self._rl_map().get(key, (0, 0))
        now = time.time()
        if exp <= now:
            c, exp = 0, now + ttl
        self._rl_map()[key] = (c + 1, exp)
        return c + 1

    # NOTAM 칸
    def list(self):
        d = {}
        for k, v in self.hall(KEY).items():
            try:
                d[int(k)] = json.loads(v)
            except ValueError:
                continue
        return d

    def save(self, slot, text):
        _check(slot, text)
        self.hset(KEY, str(slot), json.dumps({'text': text, 'savedAt': _now()}, ensure_ascii=False))

    def delete(self, slot):
        _check(slot)
        self.hdel(KEY, str(slot))

    # 주요지점
    def places_list(self):
        out = []
        for v in self.hall(PLACES_KEY).values():
            try:
                out.append(json.loads(v))
            except ValueError:
                continue
        return sorted(out, key=lambda p: p.get('name', ''))

    def places_save(self, p):
        if not isinstance(p, dict):
            raise ValueError('형식 오류')
        name = str(p.get('name', '')).strip()
        memo = str(p.get('memo', '') or '').strip()
        try:
            lat, lon = float(p.get('lat')), float(p.get('lon'))
        except (TypeError, ValueError):
            raise ValueError('좌표 오류')
        if not 1 <= len(name) <= 50:
            raise ValueError('이름은 1~50자')
        if len(memo) > 100:
            raise ValueError('메모는 100자 이내')
        if not (math.isfinite(lat) and math.isfinite(lon) and abs(lat) <= 90 and abs(lon) <= 180):
            raise ValueError('좌표 범위 오류')
        pid = str(p.get('id') or '') or uuid.uuid4().hex[:12]
        existing = self.hall(PLACES_KEY)
        if pid not in existing and len(existing) >= MAX_PLACES:
            raise ValueError(f'주요지점은 최대 {MAX_PLACES}곳')
        rec = {'id': pid, 'name': name, 'lat': round(lat, 6), 'lon': round(lon, 6), 'memo': memo, 'savedAt': _now()}
        self.hset(PLACES_KEY, pid, json.dumps(rec, ensure_ascii=False))
        return rec

    def places_delete(self, pid):
        self.hdel(PLACES_KEY, str(pid)[:40])


class MemoryStore(_Ops):
    def __init__(self):
        self._d = {}

    def hall(self, key):
        return dict(self._d.get(key, {}))

    def hset(self, key, field, value):
        self._d.setdefault(key, {})[field] = value

    def hdel(self, key, field):
        self._d.get(key, {}).pop(field, None)


class FileStore(_Ops):
    _lock = threading.Lock()

    def __init__(self, path):
        self.path = path

    def _load(self):
        try:
            with open(self.path, encoding='utf-8') as f:
                d = json.load(f)
        except (FileNotFoundError, ValueError):
            return {}
        if d and all(k.isdigit() for k in d):  # 예전 형식(NOTAM 칸만) 호환
            d = {KEY: {k: json.dumps(v, ensure_ascii=False) for k, v in d.items()}}
        return d

    def _write(self, d):
        os.makedirs(os.path.dirname(self.path) or '.', exist_ok=True)
        tmp = self.path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(d, f, ensure_ascii=False)
        os.replace(tmp, self.path)

    def hall(self, key):
        return dict(self._load().get(key, {}))

    def hset(self, key, field, value):
        with self._lock:
            d = self._load(); d.setdefault(key, {})[field] = value; self._write(d)

    def hdel(self, key, field):
        with self._lock:
            d = self._load(); d.get(key, {}).pop(field, None); self._write(d)


def _urllib_post(url, body, headers, timeout=5):
    req = urllib.request.Request(url, data=body.encode('utf-8'), headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode('utf-8')


class UpstashStore(_Ops):
    def __init__(self, url, token, post=_urllib_post):
        self.url, self.token, self.post = url.rstrip('/'), token, post

    def _cmd(self, *args):
        out = json.loads(self.post(self.url, json.dumps(list(args)), {'Authorization': 'Bearer ' + self.token,
                                                                      'Content-Type': 'application/json'}))
        if 'error' in out:
            raise OSError('저장소 오류: ' + str(out['error']))
        return out.get('result')

    def hall(self, key):
        flat = self._cmd('HGETALL', key) or []
        return dict(zip(flat[0::2], flat[1::2]))

    def hset(self, key, field, value):
        self._cmd('HSET', key, field, value)

    def hdel(self, key, field):
        self._cmd('HDEL', key, field)

    def rl_count(self, key):
        v = self._cmd('GET', key)
        return int(v) if v is not None else 0

    def rl_hit(self, key, ttl):
        n = int(self._cmd('INCR', key))
        if n == 1:
            self._cmd('EXPIRE', key, ttl)
        return n


def store_from_env(env=os.environ):
    url = env.get('KV_REST_API_URL') or env.get('UPSTASH_REDIS_REST_URL')
    tok = env.get('KV_REST_API_TOKEN') or env.get('UPSTASH_REDIS_REST_TOKEN')
    if not (url and tok):  # Vercel 연결 시 지정한 접두어(예: STORAGE_)가 붙은 경우
        for k in sorted(env):
            if k.endswith('_REST_API_URL') and env.get(k[:-len('URL')] + 'TOKEN'):
                url, tok = env[k], env[k[:-len('URL')] + 'TOKEN']
                break
    return UpstashStore(url, tok) if url and tok else None
