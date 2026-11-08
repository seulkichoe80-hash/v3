"""NOTAM 칸 공유 저장소. 칸 번호 1~MAX_SLOTS, 값은 {text, savedAt}.
- UpstashStore: Vercel 연결 Upstash Redis(REST). 환경변수 KV_REST_API_URL/TOKEN 또는 UPSTASH_REDIS_REST_URL/TOKEN
- FileStore: 로컬 실행판(logs/notams.json)
- MemoryStore: 테스트"""
import json, os, threading, urllib.request
from datetime import datetime, timezone

MAX_SLOTS = 10
MAX_TEXT = 20000
KEY = 'heliwx:notams'


def _now():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _check(slot, text=''):
    if not isinstance(slot, int) or not 1 <= slot <= MAX_SLOTS:
        raise ValueError(f'칸 번호는 1~{MAX_SLOTS}')
    if len(text) > MAX_TEXT:
        raise ValueError(f'칸당 {MAX_TEXT}자 이내')


class MemoryStore:
    def __init__(self):
        self._d = {}

    def list(self):
        return {k: dict(v) for k, v in self._d.items()}

    def save(self, slot, text):
        _check(slot, text)
        self._d[slot] = {'text': text, 'savedAt': _now()}

    def delete(self, slot):
        _check(slot)
        self._d.pop(slot, None)


class FileStore(MemoryStore):
    _lock = threading.Lock()

    def __init__(self, path):
        self.path = path
        super().__init__()

    def _load(self):
        try:
            with open(self.path, encoding='utf-8') as f:
                return {int(k): v for k, v in json.load(f).items()}
        except (FileNotFoundError, ValueError):
            return {}

    def _write(self, d):
        os.makedirs(os.path.dirname(self.path) or '.', exist_ok=True)
        tmp = self.path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump({str(k): v for k, v in d.items()}, f, ensure_ascii=False)
        os.replace(tmp, self.path)

    def list(self):
        return self._load()

    def save(self, slot, text):
        _check(slot, text)
        with self._lock:
            d = self._load(); d[slot] = {'text': text, 'savedAt': _now()}; self._write(d)

    def delete(self, slot):
        _check(slot)
        with self._lock:
            d = self._load(); d.pop(slot, None); self._write(d)


def _urllib_post(url, body, headers, timeout=5):
    req = urllib.request.Request(url, data=body.encode('utf-8'), headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode('utf-8')


class UpstashStore:
    def __init__(self, url, token, post=_urllib_post):
        self.url, self.token, self.post = url.rstrip('/'), token, post

    def _cmd(self, *args):
        out = json.loads(self.post(self.url, json.dumps(list(args)), {'Authorization': 'Bearer ' + self.token,
                                                                      'Content-Type': 'application/json'}))
        if 'error' in out:
            raise OSError('저장소 오류: ' + str(out['error']))
        return out.get('result')

    def list(self):
        flat = self._cmd('HGETALL', KEY) or []
        d = {}
        for k, v in zip(flat[0::2], flat[1::2]):
            try:
                d[int(k)] = json.loads(v)
            except ValueError:
                continue
        return d

    def save(self, slot, text):
        _check(slot, text)
        self._cmd('HSET', KEY, str(slot), json.dumps({'text': text, 'savedAt': _now()}, ensure_ascii=False))

    def delete(self, slot):
        _check(slot)
        self._cmd('HDEL', KEY, str(slot))


def store_from_env(env=os.environ):
    url = env.get('KV_REST_API_URL') or env.get('UPSTASH_REDIS_REST_URL')
    tok = env.get('KV_REST_API_TOKEN') or env.get('UPSTASH_REDIS_REST_TOKEN')
    return UpstashStore(url, tok) if url and tok else None
