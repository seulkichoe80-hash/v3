// 화면 로직: 입력 → 자료 수집(/api/*) → 판정(judge.js) → 표시. 카카오맵이 없으면 좌표 직접 입력으로 계속 동작.
import { distanceKm, sampleRouteMulti, isNightDuringRoute, routeLengthKm, KM_PER_NM } from './geo.js';
import { compareTransport } from './transport.js';
import { routeOverSea } from './landmask.js';
import { AREAS, AIRAC_NOTE } from './airspace.js';
import { parseCoord, formatCoord, COORD_PLACEHOLDER } from './coords.js';
import { splitNotams, parseNotam } from './notam.js';
import { evaluate, GRADE_TEXT, dirText, SIGWX_TEXT } from './judge.js';
import { TEMPLATES, ETC_CHECKS, ROUTE_HOSPS, CATS, titleOf, parseReq, parseTime, composeLoc, buildBrief } from './brief.js';
import { criteriaTable, art22Items } from './rules.js';

const $ = (id) => document.getElementById(id);
const KINDS = ['metar', 'taf', 'asos', 'aws', 'warn', 'lightning', 'sigwx'];
const KIND_TEXT = { metar: 'METAR', taf: 'TAF', asos: 'ASOS 지상관측', aws: 'AWS', warn: '기상특보', lightning: '낙뢰', sigwx: '저고도 중요기상' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kstStr = (d, withDate = false) => {
  if (!d) return '-';
  const k = new Date(new Date(d).getTime() + 9 * 3600e3), p = (n) => String(n).padStart(2, '0');
  return (withDate ? `${k.getUTCMonth() + 1}/${k.getUTCDate()} ` : '') + `${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
};

const CODE_KEY = 'heliwx.code', HIST_KEY = 'heliwx.history', FMT_KEY = 'heliwx.coordfmt', NOTAM_KEY = 'heliwx.notams', COORD_ON_KEY = 'heliwx.coordOn', PLACES_KEY = 'heliwx.places', MAX_VIA = 5, MAX_SLOTS = 10;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } },
};
// 모든 /api 호출은 여기로: 접속코드 헤더를 붙이고, 401이면 코드 입력 창을 다시 띄운다.
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const code = store.get(CODE_KEY, '');
  if (code) headers['X-Access-Code'] = code;
  const r = await fetch(path, { ...opts, headers });
  if (r.status === 429) { const d = await r.clone().json().catch(() => ({})); showGate(d.error || '접속코드 오입력 횟수를 초과했습니다. 잠시 후 다시 시도하세요.'); throw new Error('접속코드 잠금'); }
  if (r.status === 401) {
    const d = await r.clone().json().catch(() => ({}));
    store.set(CODE_KEY, ''); showGate('접속코드가 올바르지 않습니다. 다시 입력하세요.' + (d.attemptsLeft !== undefined ? ` (남은 시도 ${d.attemptsLeft}회)` : '')); throw new Error('접속코드 필요');
  }
  return r;
}
function showGate(msg = '') { $('code-msg').textContent = msg; $('code-gate').hidden = false; $('code-input').focus(); }
function askCode() {
  return new Promise((resolve) => {
    showGate();
    $('code-form').onsubmit = async (e) => {
      e.preventDefault();
      store.set(CODE_KEY, $('code-input').value.trim());
      const r = await fetch('/api/warn', { headers: { 'X-Access-Code': store.get(CODE_KEY, '') } }).catch(() => null);
      if (r && r.status === 429) { store.set(CODE_KEY, ''); const d = await r.json().catch(() => ({})); $('code-msg').textContent = d.error || '오입력 횟수를 초과했습니다. 잠시 후 다시 시도하세요.'; }
      else if (r && r.status !== 401) { $('code-gate').hidden = true; $('code-input').value = ''; resolve(); }
      else { const d = r ? await r.json().catch(() => ({})) : {}; store.set(CODE_KEY, ''); $('code-msg').textContent = '접속코드가 올바르지 않습니다.' + (d.attemptsLeft !== undefined ? ` (남은 시도 ${d.attemptsLeft}회)` : ''); }
    };
  });
}

const state = { config: null, kakao: null, map: null, geocoder: null, placeSvc: null, overlays: [], last: null, clickTarget: 'to', notamShared: false, slots: {}, slotCount: 2, openSlots: new Set(), favs: [], placesShared: false,
  points: [{ role: 'from', name: '', lat: null, lon: null, text: '', stayMin: 0 }, { role: 'to', name: '', lat: null, lon: null, text: '', stayMin: 0 }] };

// ---------- 시작 ----------
async function init() {
  const tick = () => { $('clock').textContent = 'KST ' + kstStr(new Date(), true); };
  tick(); setInterval(tick, 1000);
  const cc = await (await fetch('/api/client-config', { cache: 'no-store' })).json();
  state.config = cc.config; state.version = cc.version || ''; state.vworldKey = cc.vworldKey || '';
  $('ver').textContent = state.version ? `버전 ${state.version}` : '';
  $('reload-btn').addEventListener('click', () => location.reload()); state.serverLog = cc.serverLog; state.usageShared = !!cc.usageShared;
  if (cc.needsCode) {
    const ok = store.get(CODE_KEY, '') && (await fetch('/api/warn', { headers: { 'X-Access-Code': store.get(CODE_KEY, '') } }).then((r) => r.status !== 401 && r.status !== 429).catch(() => false));
    if (!ok) await askCode();
  }
  $('history-csv').addEventListener('click', downloadHistory);
  const loadSigwxRaw = async (mode) => {   // 'data' | 'help' | 'summary'
    const pre = $('sigwx-raw'); pre.textContent = '불러오는 중…'; pre.dataset.mode = mode;
    try {
      const d = await (await api('/api/raw/sigwx?limit=20000' + (mode === 'help' ? '&help=1' : mode === 'summary' ? '&summary=1' : ''))).json();
      pre.textContent = ({ help: '[API 설명문]\n', summary: '', data: '[조회 결과]\n' }[mode]) + (d.ok ? '' : '[수신 실패] ') + (d.body || d.error || '');
    } catch (err) { pre.textContent = '불러오지 못했습니다: ' + err.message; }
  };
  $('sigwx-raw-wrap').addEventListener('toggle', (e) => { if (e.target.open && !$('sigwx-raw').dataset.mode) loadSigwxRaw('summary'); });
  $('sigwx-sum-btn').addEventListener('click', () => loadSigwxRaw('summary'));
  $('sigwx-data-btn').addEventListener('click', () => loadSigwxRaw('data'));
  $('sigwx-help-btn').addEventListener('click', () => loadSigwxRaw('help'));
  showHistoryCount();
  $('usage-csv').addEventListener('click', downloadUsage);
  wireAmb();
  setupBrief();
  setupSheets();
  setupExtras();
  document.querySelectorAll('.info-btn').forEach((b) => b.addEventListener('click', () => { const t = $(b.dataset.target); if (t) t.hidden = !t.hidden; }));
  refreshUsage();
  $('cruise').value = cc.config.cruiseKt; $('prep').value = (cc.config.dispatch || {}).heliPrepMin ?? 15;
  $('depart').value = kstInputNow();
  const fmt = store.get(FMT_KEY, 'dd'); $('coord-fmt').value = ['dd', 'ddm', 'dms'].includes(fmt) ? fmt : 'dd';
  $('coord-fmt').addEventListener('change', () => { store.set(FMT_KEY, $('coord-fmt').value); reformatAll(); renderPlaces(); $('place-coord').placeholder = '좌표 (' + COORD_PLACEHOLDER[fmtNow()].split('  ')[0] + ')'; });
  setCoordsOn(store.get(COORD_ON_KEY, false), false);
  $('coord-toggle').addEventListener('change', (e) => setCoordsOn(e.target.checked, true));
  $('add-via').addEventListener('click', addVia);
  $('notam-add').addEventListener('click', () => { if (state.slotCount < MAX_SLOTS) { state.slotCount++; state.openSlots.add(state.slotCount); renderSlots(); } });
  $('notam-reload').addEventListener('click', loadNotams);
  loadNotams();
  loadPlaces();
  $('place-cat').innerHTML = PLACE_CATS.map((c) => `<option>${c}</option>`).join(''); $('place-cat').value = '기타';
  $('place-more').addEventListener('click', () => { state.placeLimit = (state.placeLimit || PLACE_PAGE) + PLACE_PAGE; renderPlaces(); });
  $('place-q').addEventListener('input', () => { state.placeLimit = PLACE_PAGE; renderPlaces(); });
  $('place-csv-out').addEventListener('click', downloadPlacesCsv);
  $('place-csv-in').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) { try { await importPlacesCsv(f); } catch (err) { $('place-csv-msg').textContent = '불러오기 실패: ' + err.message; } } });
  $('place-add').addEventListener('click', addPlaceFromForm);
  $('place-from').addEventListener('change', (e) => {
    const p = state.points[pointKeys().indexOf(e.target.value)];
    if (p && Number.isFinite(p.lat)) { $('place-name').value = p.name || ''; $('place-coord').value = formatCoord(p, fmtNow()); }
  });
  for (const id of ['depart', 'cruise']) $(id).addEventListener('change', updateAuto);
  renderPoints();
  $('run').addEventListener('click', run);
  $('copy').addEventListener('click', copyReport);
  loadKakao(cc.kakaoJsKey);
}

function kstInputNow() {
  const k = new Date(Date.now() + 9 * 3600e3);
  return k.toISOString().slice(0, 16);
}
const departUtc = () => {
  const d = new Date(($('depart').value || kstInputNow()).slice(0, 16) + ':00+09:00');
  return Number.isFinite(d.getTime()) ? d : new Date();
};

// ---------- 카카오맵 ----------
function setCoordsOn(on, remember) {
  document.body.classList.toggle('coords-on', on);
  $('coord-toggle').checked = on;
  if (remember) store.set(COORD_ON_KEY, on);
}

function kakaoFailed(msg) {
  setCoordsOn(true, false);   // 지도가 없으면 좌표 입력이 유일한 수단
  $('map-off').hidden = false;
  $('map-off').textContent = msg + ' — 각 지점의 좌표칸에 직접 입력하면 판단은 계속 가능합니다.';
}

function loadKakao(key) {
  if (!key) return kakaoFailed('카카오 JavaScript 키가 설정되지 않음(config.local.json)');
  const timer = setTimeout(() => !state.kakao && kakaoFailed('카카오맵 로드 실패 — 인터넷 연결 또는 도메인 등록(localhost:8000) 확인'), 8000);
  const s = document.createElement('script');
  s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&libraries=services&autoload=false`;
  s.onerror = () => { clearTimeout(timer); kakaoFailed('카카오맵 로드 실패 — 인터넷 연결 또는 도메인 등록(localhost:8000) 확인'); };
  s.onload = () => {
    try {
      window.kakao.maps.load(() => {
        clearTimeout(timer);
        const k = window.kakao.maps;
        state.kakao = k;
        state.map = new k.Map($('map'), { center: new k.LatLng(36.4, 127.8), level: 12 });
        state.map.addControl(new k.ZoomControl(), k.ControlPosition.RIGHT);
        fitKorea(); setupMapType(); $('mapsearch').hidden = false;
        state.geocoder = new k.services.Geocoder();
        state.placeSvc = new k.services.Places();
        setTimeout(syncMapNotams, 0);     // 지도가 준비되면 이미 입력·저장된 NOTAM을 바로 표시
        k.event.addListener(state.map, 'click', (e) => mapClickAt(e.latLng.getLat(), e.latLng.getLng()));
      });
    } catch (e) { clearTimeout(timer); kakaoFailed('카카오맵 초기화 실패: ' + e.message); }
  };
  document.head.appendChild(s);
}

// ---------- 지점(출발·경유·목적) ----------
const fmtNow = () => $('coord-fmt').value;
function pointKeys() {
  let v = 0; return state.points.map((p) => (p.role === 'via' ? `via${++v}` : p.role));
}
const roleLabel = (key) => (key === 'from' ? '출발지' : key === 'to' ? '목적지' : `경유지 ${key.slice(3)}`);

function renderPoints() {
  const keys = pointKeys();
  if (!keys.includes(state.clickTarget)) state.clickTarget = 'to';
  $('points').innerHTML = state.points.map((p, i) => {
    const k = keys[i];
    const base = p.role === 'from' && (state.config.bases || []).length
      ? `<select id="pt-${k}-base" aria-label="출발 기지"><option value="">기지 선택</option>${state.config.bases.map((b, j) => `<option value="${j}">${esc(b.name)}</option>`).join('')}</select>` : '';
    const tools = p.role === 'via' ? `<div class="tools">체류 <input id="pt-${k}-stay" class="stay" type="number" min="0" max="600" step="5" value="${p.stayMin || 0}" aria-label="체류시간(분)">분
        <button type="button" data-act="dup" data-i="${i}" aria-label="복제" title="이 경유지를 바로 아래에 복제">복제</button><button type="button" data-act="up" data-i="${i}" aria-label="위로">▲</button><button type="button" data-act="down" data-i="${i}" aria-label="아래로">▼</button><button type="button" data-act="del" data-i="${i}">삭제</button></div>` : '';
    return `<fieldset class="place ${p.role}" data-i="${i}"><legend>${roleLabel(k)}</legend>${base}
      <div class="search"><input id="pt-${k}-q" type="search" placeholder="장소 검색" autocomplete="off"><ul class="results" id="pt-${k}-results"></ul></div>
      <div class="row coord-only"><input id="pt-${k}-name" placeholder="이름 (좌표로 입력할 때)" value="${esc(p.name)}"></div>
      <div class="loc" id="pt-${k}-loc">${Number.isFinite(p.lat) ? `📍 ${esc(p.name || '')} (${p.lat.toFixed(4)}, ${p.lon.toFixed(4)})` : '위치 미지정 — 검색 후 Enter 또는 지도 클릭'}</div>
      <div class="row coord-only"><input id="pt-${k}-coord" placeholder="${esc(COORD_PLACEHOLDER[fmtNow()])}" value="${esc(p.text)}" spellcheck="false" aria-label="${roleLabel(k)} 좌표"></div>
      <div class="coord-msg coord-only" id="pt-${k}-msg"></div>${tools}
      <label class="inline"><input type="radio" name="clickset" value="${k}" ${state.clickTarget === k ? 'checked' : ''}> 지도 클릭·주요지점 → 이 지점</label></fieldset>`;
  }).join('');
  state.points.forEach((p, i) => wirePoint(p, keys[i]));
  $('add-via').disabled = state.points.filter((p) => p.role === 'via').length >= MAX_VIA;
  updatePlaceFrom(); updateAuto(); drawRouteOnly(); showAmb();
}

function wirePoint(p, k) {
  const coord = $(`pt-${k}-coord`);
  const apply = () => {
    p.text = coord.value;
    const msg = $(`pt-${k}-msg`);
    if (!p.text.trim()) { p.lat = p.lon = null; msg.textContent = ''; msg.className = 'coord-msg'; coord.classList.remove('bad'); return; }
    const r = parseCoord(p.text, fmtNow());
    if (r.error) { p.lat = p.lon = null; msg.textContent = '⚠ ' + r.error; msg.className = 'coord-msg err'; coord.classList.add('bad'); }
    else {
      p.lat = r.lat; p.lon = r.lon; coord.classList.remove('bad');
      msg.textContent = `→ ${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}${r.warning ? ' · ' + r.warning : ''}`;
      msg.className = 'coord-msg' + (r.warning ? ' warn' : '');
    }
    $(`pt-${k}-loc`).textContent = Number.isFinite(p.lat) ? `📍 ${p.name || ''} (${p.lat.toFixed(4)}, ${p.lon.toFixed(4)})` : '위치 미지정 — 검색 후 Enter 또는 지도 클릭';
    updatePlaceFrom(); updateAuto(); drawRouteOnly(); showAmb();
  };
  coord.addEventListener('change', apply);
  coord.addEventListener('blur', apply);
  if (p.text) apply();
  $(`pt-${k}-name`).addEventListener('input', (e) => { p.name = e.target.value; updatePlaceFrom(); });
  const stay = $(`pt-${k}-stay`); if (stay) stay.addEventListener('input', (e) => { p.stayMin = Math.max(0, Number(e.target.value) || 0); updateAuto(); });
  const base = $(`pt-${k}-base`);
  if (base) base.addEventListener('change', (e) => { const b = state.config.bases[+e.target.value]; if (b) setPointByKey(k, { name: b.name, lat: b.lat, lon: b.lon }); });
  document.querySelectorAll(`fieldset[data-i] input[name=clickset][value="${k}"]`).forEach((r) => r.addEventListener('change', () => { state.clickTarget = k; }));
  setupSearch(k);
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const i = +b.dataset.i, pts = state.points;
  if (b.dataset.act === 'del') pts.splice(i, 1);
  if (b.dataset.act === 'dup') { if (pts.filter((p) => p.role === 'via').length >= MAX_VIA) return; pts.splice(i + 1, 0, { ...pts[i], role: 'via' }); }
  if (b.dataset.act === 'up' && pts[i - 1]?.role === 'via') [pts[i - 1], pts[i]] = [pts[i], pts[i - 1]];
  if (b.dataset.act === 'down' && pts[i + 1]?.role === 'via') [pts[i + 1], pts[i]] = [pts[i], pts[i + 1]];
  renderPoints();
});

function addVia() {
  if (state.points.filter((p) => p.role === 'via').length >= MAX_VIA) return;
  state.points.splice(state.points.length - 1, 0, { role: 'via', name: '', lat: null, lon: null, text: '', stayMin: 0 });
  renderPoints();
}

function reformatAll() {
  for (const p of state.points) if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) p.text = formatCoord(p, fmtNow());
  renderPoints();
}

function setPointByKey(k, place) {
  const i = pointKeys().indexOf(k); if (i < 0) return;
  Object.assign(state.points[i], { name: place.name, lat: place.lat, lon: place.lon, text: formatCoord(place, fmtNow()) });
  renderPoints();
}

function matchPlaces(q) {
  const t = q.trim().toLowerCase(); if (!t) return [];
  return state.favs.filter((p) => (p.name + ' ' + (p.memo || '')).toLowerCase().includes(t)).slice(0, 8);
}

function setupSearch(k) {
  searchBox($(`pt-${k}-q`), $(`pt-${k}-results`), (pl) => setPointByKey(k, pl));
}
// 검색칸 공통: 주요지점·카카오 장소검색·좌표 직접 입력 → onPick({name, lat, lon})
function searchBox(q, list, onPick) {
  document.addEventListener('click', (e) => { if (!q.contains(e.target) && !list.contains(e.target)) list.innerHTML = ''; });
  q.addEventListener('keydown', (e) => { if (e.key === 'Escape') list.innerHTML = ''; });
  let t = null;
  q.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const c = parseCoord(q.value, fmtNow());                       // 좌표를 그대로 입력한 경우
    if (!c.error && Number.isFinite(c.lat)) { onPick({ name: q.value.trim(), lat: c.lat, lon: c.lon }); list.innerHTML = ''; return; }
    const first = list.querySelector('li[data-f], li[data-i]');
    if (first) first.click();
    else { clearTimeout(t); q.dispatchEvent(new Event('input')); setTimeout(() => list.querySelector('li[data-f], li[data-i]')?.click(), 900); }
  });
  q.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const query = q.value.trim();
      const favs = matchPlaces(query);
      const draw = (kakao, note = '') => {
        list.innerHTML = favs.map((p, i) => `<li tabindex="0" class="fav" data-f="${i}"><span class="tagfav">주요지점</span> ${esc(p.name)}<small>${esc(p.memo || '')} ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</small></li>`).join('')
          + kakao.map((d, i) => `<li tabindex="0" data-i="${i}">${esc(d.place_name)}<small>${esc(d.road_address_name || d.address_name)}</small></li>`).join('')
          + (note ? `<li class="empty"><small>${esc(note)}</small></li>` : '');
        list.querySelectorAll('li').forEach((li) => {
          const pick = () => {
            if (li.dataset.f !== undefined) { const p = favs[+li.dataset.f]; onPick({ name: p.name, lat: p.lat, lon: p.lon, addr: p.memo || '' }); }
            else { const d = kakao[+li.dataset.i]; onPick({ name: d.place_name, lat: +d.y, lon: +d.x, addr: d.road_address_name || (d.address_name !== '주소' ? d.address_name : '') || '' }); }
          };
          const pickClose = () => { pick(); list.innerHTML = ''; };
          li.addEventListener('click', pickClose);
          li.addEventListener('keydown', (e) => e.key === 'Enter' && pickClose());
        });
      };
      if (query.length < 1) { list.innerHTML = ''; return; }
      if (!state.placeSvc || !state.kakao) { draw([], favs.length ? '' : '카카오 장소검색 불가(지도 미연결) — 주요지점 또는 좌표 직접 입력 사용'); return; }
      if (query.length < 2) { draw([], favs.length ? '' : '두 글자 이상 입력'); return; }
      draw([], '검색 중…');
      // 장소명(카카오 키워드 검색)과 주소(지번·도로명)를 함께 찾아 합친다. 응답이 6초 넘게 없으면 오류 안내
      const S = state.kakao.services.Status, wait = (fn) => new Promise((res) => {
        const t = setTimeout(() => res({ data: [], st: 'TIMEOUT' }), 6000);
        try { fn((data, st) => { clearTimeout(t); res({ data: data || [], st }); }); } catch { clearTimeout(t); res({ data: [], st: 'ERROR' }); }
      });
      Promise.all([
        wait((cb) => state.placeSvc.keywordSearch(query, cb)),
        wait((cb) => (state.geocoder ? state.geocoder.addressSearch(query, cb) : cb([], S.ZERO_RESULT))),
      ]).then(([kw, ad]) => {
        if (q.value.trim() !== query) return;                       // 그 사이 검색어가 바뀜
        const docs = [
          ...(kw.st === S.OK ? kw.data.slice(0, 6) : []),
          ...(ad.st === S.OK ? ad.data.slice(0, 4).map((a) => ({ place_name: a.address_name, address_name: '주소', y: a.y, x: a.x })) : []),
        ];
        if (docs.length) draw(docs);
        else if (kw.st === 'TIMEOUT' && ad.st === 'TIMEOUT') draw([], '카카오 응답 없음 — 잠시 후 다시 시도하거나 좌표를 입력하세요');
        else if ([kw.st, ad.st].some((x) => x !== S.ZERO_RESULT && x !== S.OK)) draw([], '카카오 검색 오류 — 잠시 후 다시 시도');
        else draw([], favs.length ? '' : '검색 결과 없음 — 장소명 또는 주소(예: 경기 평택시 평남로 616)를 더 자세히 입력하세요');
      });
    }, 250);
  });
}

// ---------- 주요지점(공유 저장) ----------
async function loadPlaces() {
  let list = [], shared = false, err = '';
  try {
    const d = await (await api('/api/places')).json();
    if (d.error) throw new Error(d.error);
    shared = !!d.shared; list = d.places || [];
  } catch (e) { err = e.message; }
  if (!shared) list = store.get(PLACES_KEY, []);
  state.placesShared = shared; state.favs = list;
  $('places-mode').textContent = err ? `⚠ 공유 저장소 오류 — 이 브라우저 저장본 사용 (${err})` : shared ? '' : '공유 저장소 미연결 — 이 브라우저에만 저장';   // 정상일 때는 안내를 숨김
  renderPlaces();
}

function updatePlaceFrom() {
  const sel = $('place-from'); if (!sel) return;
  const keys = pointKeys(), cur = sel.value;
  sel.innerHTML = '<option value="">현재 지점에서 가져오기…</option>' + state.points.map((p, i) => Number.isFinite(p.lat)
    ? `<option value="${keys[i]}">${esc(roleLabel(keys[i]).replace(/\(.*\)/, ''))}: ${esc(p.name || formatCoord(p, 'dd'))}</option>` : '').join('');
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

const PLACE_CATS = ['항공대', '병원', '헬리패드', '기타'], PLACE_PAGE = 30;
const placeCat = (p) => (PLACE_CATS.includes(p.cat) ? p.cat : '기타');
function placeRow(p) {
  return `<li data-id="${esc(p.id)}"><button type="button" class="pick" title="선택된 지점에 넣기">${esc(p.name)}
      <small>${esc(formatCoord(p, fmtNow()))}${p.memo ? ' · ' + esc(p.memo) : ''}</small></button>
      <select class="catsel" aria-label="종류 변경">${PLACE_CATS.map((c) => `<option${placeCat(p) === c ? ' selected' : ''}>${c}</option>`).join('')}</select>
      <button type="button" class="mini del">삭제</button></li>`;
}
function renderPlaces() {
  const q = $('place-q').value.trim().toLowerCase(), cat = state.placeCat || '전체';
  const chips = ['전체', ...PLACE_CATS];
  $('place-chips').innerHTML = chips.map((c) => `<button type="button" class="chip${c === cat ? ' on' : ''}" data-cat="${c}">${c}</button>`).join('');
  $('place-chips').querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => { state.placeCat = b.dataset.cat; state.placeLimit = PLACE_PAGE; renderPlaces(); }));
  const all = state.favs.slice().sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const items = all.filter((p) => (!q || (p.name + ' ' + (p.memo || '')).toLowerCase().includes(q)) && (cat === '전체' || placeCat(p) === cat));
  const limit = state.placeLimit || PLACE_PAGE, shown = items.slice(0, limit);
  $('place-list').innerHTML = shown.length ? shown.map(placeRow).join('')
    : `<li><small>${state.favs.length ? '해당하는 주요지점이 없습니다' : '등록된 주요지점이 없습니다'}</small></li>`;
  $('place-more').hidden = items.length <= limit;
  $('place-more').textContent = `더 보기 (${items.length - limit}곳 더)`;
  document.querySelectorAll('#place-list li[data-id]').forEach((li) => {
    const p = state.favs.find((x) => x.id === li.dataset.id);
    li.querySelector('.pick').addEventListener('click', () => { setPointByKey(state.clickTarget, { name: p.name, lat: p.lat, lon: p.lon }); showSheet(1); });
    li.querySelector('.catsel').addEventListener('change', async (e) => { try { await savePlace({ ...p, cat: e.target.value }); } catch (err) { alert('종류 변경 실패: ' + err.message); } });
    li.querySelector('.del').addEventListener('click', async () => {
      if (!confirm(`주요지점 "${p.name}"을(를) 삭제할까요?${state.placesShared ? ' (모든 사용자에게서 삭제됩니다)' : ''}`)) return;
      try { await deletePlace(p.id); } catch (e) { alert('삭제 실패: ' + e.message); }
    });
  });
}

async function savePlace(p) {
  if (state.placesShared) {
    const r = await api('/api/places', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || r.status);
    state.favs = [...state.favs.filter((x) => x.id !== d.place.id), d.place].sort((a, b) => (a.name < b.name ? -1 : 1));
  } else {
    if (!p.name || p.name.length > 50) throw new Error('이름은 1~50자');
    const rec = { ...p, id: p.id || Math.random().toString(16).slice(2, 14), savedAt: new Date().toISOString() };
    state.favs = [...state.favs.filter((x) => x.id !== rec.id), rec].sort((a, b) => (a.name < b.name ? -1 : 1)); store.set(PLACES_KEY, state.favs);
  }
  renderPlaces();
}

async function deletePlace(id) {
  if (state.placesShared) { const r = await api(`/api/places/${encodeURIComponent(id)}`, { method: 'DELETE' }); if (!r.ok) throw new Error(r.status); }
  state.favs = state.favs.filter((x) => x.id !== id);
  if (!state.placesShared) store.set(PLACES_KEY, state.favs);
  renderPlaces();
}

async function addPlaceFromForm() {
  const msg = $('place-msg'), name = $('place-name').value.trim();
  const c = parseCoord($('place-coord').value, fmtNow());
  if (!name) { msg.textContent = '이름을 입력하세요'; return; }
  if (c.error) { msg.textContent = '좌표: ' + c.error; return; }
  try {
    await savePlace({ name, lat: c.lat, lon: c.lon, memo: $('place-memo').value.trim(), cat: $('place-cat').value });
    $('place-name').value = $('place-coord').value = $('place-memo').value = ''; msg.textContent = '추가했습니다';
  } catch (e) { msg.textContent = '추가 실패: ' + e.message; }
}


// ---------- 주요지점 엑셀(CSV) 내려받기·불러오기 ----------
const csvCell = (v) => { let t = String(v ?? ''); if (/^[=+\-@]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',' || c === '\t') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}
function downloadPlacesCsv() {
  const head = ['이름', '종류', '위도', '경도', '메모'];
  const lines = [head, ...state.favs.slice().sort((a, b) => a.name.localeCompare(b.name, 'ko')).map((p) => [p.name, placeCat(p), p.lat, p.lon, p.memo || ''])];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + lines.map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  a.download = `재난하늘119-주요지점-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
}
async function importPlacesCsv(file) {
  const msg = $('place-csv-msg');
  const buf = await file.arrayBuffer();
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('euc-kr').decode(buf); }   // 엑셀 기본 저장(CP949)도 읽음
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length < 2) { msg.textContent = '불러올 줄이 없습니다 (첫 줄은 제목: 이름, 종류, 위도, 경도, 메모)'; return; }
  const idx = (names) => rows[0].findIndex((h) => names.includes(h.trim()));
  const ci = { name: idx(['이름', '명칭', 'name']), cat: idx(['종류', '분류', 'cat']), lat: idx(['위도', 'lat']), lon: idx(['경도', 'lon', 'lng']), memo: idx(['메모', 'memo']) };
  if (ci.name < 0 || ci.lat < 0 || ci.lon < 0) { msg.textContent = '첫 줄에 "이름, 위도, 경도" 열이 있어야 합니다 (종류·메모는 선택)'; return; }
  let added = 0, updated = 0; const errs = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r], name = (row[ci.name] || '').trim(), lat = parseFloat(row[ci.lat]), lon = parseFloat(row[ci.lon]);
    const cat = ci.cat >= 0 ? (row[ci.cat] || '').trim() : '', memo = ci.memo >= 0 ? (row[ci.memo] || '').trim().slice(0, 100) : '';
    if (!name || name.length > 50 || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { errs.push(`${r + 1}번째 줄`); continue; }
    const exist = state.favs.find((p) => p.name === name);
    try {
      await savePlace({ ...(exist ? { id: exist.id } : {}), name, lat, lon, memo, cat: PLACE_CATS.includes(cat) ? cat : (exist ? placeCat(exist) : '기타') });
      if (exist) updated++; else added++;
    } catch (e) { errs.push(`${r + 1}번째 줄(${e.message})`); }
  }
  msg.textContent = `불러오기 완료 — 추가 ${added}곳, 갱신 ${updated}곳${errs.length ? `, 건너뜀 ${errs.length}건: ${errs.slice(0, 4).join(', ')}${errs.length > 4 ? ' …' : ''}` : ''}`;
}

// ---------- NOTAM 칸(공유 저장) ----------
async function loadNotams() {
  let slots = {}, shared = false, err = '';
  try {
    const d = await (await api('/api/notams')).json();
    if (d.error) throw new Error(d.error);
    shared = !!d.shared; slots = d.slots || {};
  } catch (e) { err = e.message; }
  if (!shared) slots = store.get(NOTAM_KEY, {});
  state.notamShared = shared;
  state.slots = {};
  for (const [k, v] of Object.entries(slots)) state.slots[+k] = { text: v.text, savedText: v.text, savedAt: v.savedAt };
  await compactSlots();
  state.slotCount = Math.min(MAX_SLOTS, Math.max(2, state.slotCount, ...Object.keys(state.slots).map(Number)));
  $('notam-mode').textContent = err ? `⚠ 공유 저장소 오류 — 이 브라우저 저장본 사용 (${err})`
    : shared ? '' : '공유 저장소 미연결 — 이 브라우저에만 저장됩니다';   // 정상(공유 저장)일 때는 안내를 숨김
  renderSlots();
}

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
function slotSummary(text) {
  if (!text.trim()) return { t: '비어 있음', cls: '' };
  const ns = splitNotams(text).map(parseNotam);
  const ok = ns.filter((n) => n.id);
  if (!ok.length) return { t: '⚠ 해석 불가 — 원문 확인', cls: 'err' };
  const now = new Date();
  const expired = ok.every((n) => !n.endPerm && n.end && n.end < now);
  const n = ok[0];
  const until = n.endPerm ? 'PERM' : n.end ? kstStr(n.end, true) + '까지' : '';
  return { t: `${n.id} ${n.qcodeText || ''} · ${until}${ok.length > 1 ? ` 외 ${ok.length - 1}건` : ''}${expired ? ' · 만료(삭제 권장)' : ''}`, cls: expired ? 'exp' : '' };
}

function renderSlots() {
  const html = [];
  for (let i = 1; i <= state.slotCount; i++) {
    html.push(`<details class="nslot" data-n="${i}" ${state.openSlots.has(i) ? 'open' : ''}>
      <summary class="nh" id="notam-${i}-sum"><span class="no">${CIRCLED[i - 1]}</span><span class="nt" id="notam-${i}-title"></span><span class="st" id="notam-${i}-status"></span></summary>
      <textarea id="notam-${i}" rows="4" spellcheck="false" placeholder="(D2840/26 NOTAMN …) 붙여넣기" aria-label="NOTAM ${i}번 칸"></textarea>
      <div class="nb"><span class="st"></span>
        <button type="button" class="mini" id="notam-${i}-save">저장</button><button type="button" class="mini" id="notam-${i}-del">삭제</button></div></details>`);
  }
  $('notam-slots').innerHTML = html.join('');
  for (let i = 1; i <= state.slotCount; i++) {
    const ta = $(`notam-${i}`), s = state.slots[i] || { text: '', savedText: '', savedAt: null };
    ta.closest('details').addEventListener('toggle', (e) => { if (e.target.open) state.openSlots.add(i); else state.openSlots.delete(i); });
    ta.value = s.text || '';
    const refresh = () => {
      const cur = state.slots[i] || { text: '', savedText: '', savedAt: null };
      const sum = slotSummary(ta.value);
      const t = $(`notam-${i}-title`); t.textContent = sum.t; t.className = 'nt ' + sum.cls;
      const dirty = ta.value !== (cur.savedText || '');
      $(`notam-${i}-status`).textContent = dirty ? '· 저장 안 됨' : cur.savedAt ? `· 저장됨 ${kstStr(cur.savedAt, true)}` : '';
      ta.closest('.nslot').classList.toggle('dirty', dirty);
    };
    ta.addEventListener('input', () => { state.slots[i] = { ...(state.slots[i] || {}), text: ta.value }; refresh(); syncMapNotams(); updateTabCounts(); });
    $(`notam-${i}-save`).addEventListener('click', () => saveSlot(i, ta.value).then(refresh));
    $(`notam-${i}-del`).addEventListener('click', () => {
      if (!ta.value.trim() && !(state.slots[i] || {}).savedText) return;
      if (!confirm(`${CIRCLED[i - 1]}번 칸을 삭제할까요?${state.notamShared ? ' (모든 사용자에게서 삭제됩니다)' : ''}`)) return;
      deleteSlot(i).then(async () => { ta.value = ''; refresh(); if (await compactSlots()) renderSlots(); syncMapNotams(); updateTabCounts(); });
    });
    refresh();
  }
  $('notam-add').disabled = state.slotCount >= MAX_SLOTS;
  syncMapNotams(); updateTabCounts();
}

async function saveSlot(i, text) {
  const st = $(`notam-${i}-status`) || {};
  try {
    if (state.notamShared) {
      const r = await api(`/api/notams/${i}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || r.status);
    } else {
      const all = store.get(NOTAM_KEY, {}); all[i] = { text, savedAt: new Date().toISOString() }; store.set(NOTAM_KEY, all);
    }
    state.slots[i] = { text, savedText: text, savedAt: new Date().toISOString() };
  } catch (e) { st.textContent = '저장 실패: ' + e.message; throw e; }
}

async function deleteSlot(i) {
  if (state.notamShared) {
    const r = await api(`/api/notams/${i}`, { method: 'DELETE' });
    if (!r.ok) { const st = $(`notam-${i}-status`); if (st) st.textContent = '삭제 실패'; throw new Error('delete'); }
  } else { const all = store.get(NOTAM_KEY, {}); delete all[i]; store.set(NOTAM_KEY, all); }
  delete state.slots[i];
}

// 비어 있는 칸을 앞으로 당겨 ①번부터 차례로 채운다(저장된 NOTAM 기준). 저장하지 않은 편집이 있으면 건드리지 않는다.
async function compactSlots() {
  const idx = Object.keys(state.slots).map(Number).sort((a, b) => a - b);
  const filled = idx.filter((i) => (state.slots[i].savedText || '').trim());
  const blanks = idx.filter((i) => !(state.slots[i].savedText || '').trim());
  if (filled.every((orig, n) => orig === n + 1) && !blanks.length) return false;
  const dirty = Array.from({ length: state.slotCount }, (_, k) => k + 1).some((i) => { const ta = $(`notam-${i}`); return ta && ta.value !== ((state.slots[i] || {}).savedText || ''); });
  if (dirty) return false;
  const texts = filled.map((i) => state.slots[i].savedText);
  try {
    for (let n = 0; n < texts.length; n++) if ((state.slots[n + 1] || {}).savedText !== texts[n]) await saveSlot(n + 1, texts[n]);
    for (const i of idx) if (i > texts.length) await deleteSlot(i);
  } catch { return true; }
  return true;
}
const notamText = () => Array.from({ length: state.slotCount }, (_, k) => $(`notam-${k + 1}`)?.value || '').filter((t) => t.trim()).join('\n\n');

// 판단에 쓸 지점 목록(모두 좌표가 있어야 함)
function readyPoints() {
  const keys = pointKeys(), out = [], bad = [];
  state.points.forEach((p, i) => {
    if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) out.push({ name: p.name.trim() || roleLabel(keys[i]).replace(/\(.*\)/, ''), lat: p.lat, lon: p.lon, stayMin: p.role === 'via' ? p.stayMin : 0 });
    else bad.push(roleLabel(keys[i]));
  });
  return { pts: out, bad };
}

function cruiseKt() {
  const v = Number($('cruise').value);
  return Number.isFinite(v) && v >= 40 && v <= 250 ? v : state.config.cruiseKt;
}

function flightTimes(pts) {
  const dep = departUtc();
  const min = (routeLengthKm(pts) / (cruiseKt() * KM_PER_NM)) * 60 + pts.reduce((a, p) => a + (p.stayMin || 0), 0);
  return { dep, arr: new Date(dep.getTime() + min * 60e3) };
}

function updateAuto() {
  const { pts, bad } = readyPoints();
  if (bad.length || pts.length < 2) { $('daynight-auto').textContent = ''; return; }
  const { dep, arr } = flightTimes(pts);
  $('daynight-auto').textContent = '자동: ' + (isNightDuringRoute(pts, dep, arr) ? '야간' : '주간');
}

// ---------- 경로 행정구역(특보 매칭·해상 판별) ----------
function routeRegions(route) {
  if (!state.geocoder) return Promise.resolve({ regions: [], seaPoints: 0, available: false });
  const pts = sampleRouteMulti(route, 10);
  const step = Math.max(1, Math.ceil(pts.length / 30));
  const sel = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  const k = state.kakao;
  return Promise.all(sel.map((p) => new Promise((res) => {
    state.geocoder.coord2RegionCode(p.lon, p.lat, (r, st) => {
      if (st !== k.services.Status.OK || !r.length) return res(null);
      const h = r.find((x) => x.region_type === 'H') || r[0];
      res({ sido: h.region_1depth_name, sigungu: h.region_2depth_name });
    });
  }))).then((list) => {
    const seen = new Set(), regions = [];
    for (const r of list) if (r && !seen.has(r.sido + r.sigungu)) { seen.add(r.sido + r.sigungu); regions.push(r); }
    return { regions, seaPoints: list.filter((x) => !x).length, available: true };
  });
}


// ---------- 사용 편의 기능 ----------
const ROUTES_KEY = 'heliwx.routes', LOOK_KEY = 'heliwx.look', LAST_OLD_MIN = 20;
function routeLabel(pts) { return pts.map((p) => p.name).join(' → '); }
function loadRoutes() { return store.get(ROUTES_KEY, []); }
function saveRoute(pts, amb) {
  const entry = { label: routeLabel(pts), pts: pts.map((p) => ({ name: p.name, lat: p.lat, lon: p.lon, stayMin: p.stayMin || 0 })), amb: { from: state.amb.from, to: state.amb.to }, savedAt: Date.now() };
  store.set(ROUTES_KEY, [entry, ...loadRoutes().filter((r) => r.label !== entry.label)].slice(0, 10));
  fillRecentRoutes();
}
function fillRecentRoutes() {
  const sel = $('recent-routes'); if (!sel) return;
  sel.innerHTML = '<option value="">최근 조회 경로 불러오기…</option>' + loadRoutes().map((r, i) => `<option value="${i}">${esc(r.label)}</option>`).join('');
}
function applyRoute(r) {
  if (!r || !r.pts || r.pts.length < 2) return;
  const last = r.pts.length - 1;
  state.points = r.pts.map((p, i) => ({ role: i === 0 ? 'from' : i === last ? 'to' : 'via', name: p.name, lat: p.lat, lon: p.lon, text: formatCoord(p, fmtNow()), stayMin: p.stayMin || 0 }));
  state.amb = { from: (r.amb && r.amb.from) || null, to: (r.amb && r.amb.to) || null };
  renderPoints(); showAmb();
}
function swapRoute() {
  const pts = state.points; if (pts.length < 2) return;
  const rev = pts.slice().reverse().map((p) => ({ ...p }));
  state.points = rev.map((p, i) => ({ ...p, role: i === 0 ? 'from' : i === rev.length - 1 ? 'to' : 'via', stayMin: i === 0 || i === rev.length - 1 ? 0 : p.stayMin || 0 }));
  if (state.amb.from || state.amb.to) state.amb = { from: state.amb.to, to: state.amb.from };
  renderPoints(); showAmb();
}
function headlineText(r, tp) {
  const sev = { RED: 0, YELLOW: 1, NA: 2 };
  const key = r.rows.filter((x) => x.grade in sev).sort((a, b) => sev[a.grade] - sev[b.grade])[0];
  const times = tp && tp.amb ? `헬기 ${tp.heli.totalMin}분 · 구급차 ${tp.amb.totalMin}분` : tp ? `헬기 ${tp.heli.totalMin}분` : '';
  return { l1: times || GRADE_TEXT[r.overall], l2: `${tp ? tp.text : ''}${key ? ` — 핵심: ${key.segment} ${key.item} ${key.value}` : ''}` };
}
function renderHeadline(r, tp) {
  const h = headlineText(r, tp), el = $('headline');
  el.hidden = false; el.dataset.grade = r.overall;
  el.innerHTML = `<b>${esc(h.l1)}</b><span>${esc(h.l2)}</span>`;
}
function renderDataStatus(meta) {
  $('data-status').innerHTML = meta.length ? '<span class="ds-t">기상 자료</span>' + meta.map((m) => {
    const bad = m.error && !m.hasItems, old = m.stale || (m.ageMin !== null && m.ageMin > (state.config.freshnessMin[m.k] || 1e9));
    const txt = bad ? '수신 실패' : m.ageMin === null ? '—' : m.ageMin < 1 ? '방금' : `${m.ageMin}분 전`;
    return `<span class="ds ${bad ? 'bad' : old ? 'old' : 'ok'}">${esc(m.label)} ${txt}</span>`;
  }).join('') : '';
}
let oldTimer = null;
function startOldWatch() {
  clearInterval(oldTimer); state.lastRunAt = Date.now(); $('old-banner').hidden = true;
  oldTimer = setInterval(() => {
    const min = Math.floor((Date.now() - state.lastRunAt) / 60000);
    if (min >= LAST_OLD_MIN) { const b = $('old-banner'); b.hidden = false; b.innerHTML = `⚠ 이 판단은 <b>${min}분 전</b> 결과입니다. 기상이 바뀌었을 수 있으니 <button type="button" id="old-rerun" class="mini">다시 실행</button>`; $('old-rerun').addEventListener('click', run); }
  }, 30000);
}
function applyLook() {
  let l = {}; try { l = JSON.parse(localStorage.getItem(LOOK_KEY) || '{}'); } catch { /* 저장 불가여도 동작 */ }
  document.body.classList.toggle('big', !!l.big); document.documentElement.classList.toggle('dark', !!l.dark);
  $('btn-big').setAttribute('aria-pressed', l.big ? 'true' : 'false'); $('btn-dark').setAttribute('aria-pressed', l.dark ? 'true' : 'false');
}
function toggleLook(key) {
  let l = {}; try { l = JSON.parse(localStorage.getItem(LOOK_KEY) || '{}'); } catch { /* 무시 */ }
  l[key] = !l[key]; try { localStorage.setItem(LOOK_KEY, JSON.stringify(l)); } catch { /* 무시 */ }
  applyLook();
}
function setupExtras() {
  fillRecentRoutes(); setupFinder();
  $('recent-routes').addEventListener('change', (e) => { if (e.target.value !== '') applyRoute(loadRoutes()[+e.target.value]); e.target.value = ''; });
  $('swap').addEventListener('click', swapRoute);
  $('depart-now').addEventListener('click', () => { $('depart').value = kstInputNow(); });
  for (const id of ['depart', 'cruise', 'prep']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !$('run').disabled) { e.preventDefault(); run(); } });
  $('btn-help').addEventListener('click', () => { const h = $('help-panel'); h.hidden = !h.hidden; $('btn-help').setAttribute('aria-expanded', h.hidden ? 'false' : 'true'); });
  $('btn-big').addEventListener('click', () => toggleLook('big'));
  $('btn-dark').addEventListener('click', () => toggleLook('dark'));
  applyLook();
  $('data-warn').addEventListener('click', (e) => { if (e.target.closest('#retry-run')) run(); });
}

// ---------- 낡은 화면 감지 ----------
// 열어 둔 페이지는 옛 코드를 그대로 쓰므로, 서버 버전이 바뀌었으면 새로고침 안내를 띄운다.
async function checkVersion() {
  try {
    const d = await (await fetch('/api/client-config', { cache: 'no-store' })).json();
    if (state.version && d.version && d.version !== state.version) $('stale-banner').hidden = false;
  } catch { /* 확인 실패는 무시 */ }
}

// ---------- 실행 ----------
async function run() {
  const { pts, bad } = readyPoints();
  if (bad.length) { $('run-msg').textContent = `좌표가 없거나 형식이 틀린 지점: ${bad.join(', ')}`; return; }
  const from = pts[0], to = pts[pts.length - 1];
  const amb = ambPoints(pts);
  $('run').disabled = true; $('run-msg').textContent = '기상자료 수집 중…';
  checkVersion();
  try {
    const [settled, rr, road] = await Promise.all([
      Promise.allSettled(KINDS.map((k) => fetchKind(k))),
      routeRegions(pts).catch(() => ({ regions: [], seaPoints: 0, available: false })),
      (amb.from && amb.to ? api(`/api/drive?olat=${amb.from.lat}&olon=${amb.from.lon}&dlat=${amb.to.lat}&dlon=${amb.to.lon}`).then((r) => (r.ok ? r.json() : null)).catch(() => null) : Promise.resolve(null)),
    ]);
    const data = {}, dataStatus = {}, warns = [], meta = [];
    settled.forEach((s, i) => {
      const k = KINDS[i];
      meta.push(s.status === 'rejected' ? { k, label: KIND_TEXT[k], error: true, hasItems: false, ageMin: null, stale: false } : { k, label: KIND_TEXT[k], error: !!s.value.error, hasItems: !!(s.value.items || []).length, ageMin: s.value.ageMin ?? null, stale: !!s.value.stale });
      if (s.status === 'rejected') { data[k] = []; dataStatus[k] = 'error'; warns.push(`${KIND_TEXT[k]} 수신 실패`); return; }
      data[k] = s.value.items || [];
      if (s.value.error && !data[k].length) { dataStatus[k] = 'error'; warns.push(`${KIND_TEXT[k]} 수신 실패 — ${String(s.value.error).slice(0, 140)}`); }
      else if (s.value.stale) {
        warns.push(`${KIND_TEXT[k]} ${s.value.ageMin}분 전 자료 사용(재수신 실패)`);
        const lim = state.config.freshnessMin[k];
        if (lim && s.value.ageMin > lim) dataStatus[k] = 'stale';
      }
    });

    const { dep, arr } = flightTimes(pts);
    const dn = $('daynight').value, ls = $('landsea').value;
    const isNight = dn === 'auto' ? isNightDuringRoute(pts, dep, arr) : dn === 'night';
    // 해상 자동 판별: 카카오 행정구역 조회와 내장 해안선(바다 위 점)을 합쳐 하나라도 바다면 해상(더 엄격한 기준)
    const mask = routeOverSea(pts);
    const seaSuggest = mask.sea || (rr.available && rr.seaPoints > 0);
    const isSea = ls === 'auto' ? seaSuggest : ls === 'sea';
    $('landsea-auto').textContent = `자동: ${seaSuggest ? '해상 구간 포함' : '육상'}`;
    if (!rr.available) warns.push('카카오맵 없음 — 특보구역 매칭 생략(특보 직접 확인), 해상 판별은 내장 해안선 기준');

    const text = notamText();
    const result = evaluate({
      points: pts, departUtc: dep, cruiseKt: cruiseKt(), isNight, isSea, data, dataStatus,
      regionsAvailable: rr.available, seaRoute: seaSuggest,
      notams: splitNotams(text).map(parseNotam), notamsProvided: text.trim().length > 0,
      routeRegions: rr.regions, now: new Date(), config: state.config, airspaceAreas: AREAS,
    });
    const dsp = state.config.dispatch || {};
    const prep = Number.isFinite(+$('prep').value) && $('prep').value !== '' && +$('prep').value >= 0 ? Math.round(+$('prep').value) : (dsp.heliPrepMin ?? 15);
    const tp = compareTransport({ prepMin: prep, flightMin: result.durationMin, overall: result.overall, road, closeMin: dsp.closeMin ?? 5, missing: amb.from && amb.to ? '' : '구급차 이동시간 칸에 현장→병원을 입력하거나, 경유지 1에 현장을 추가하세요' });
    tp.ambRoute = amb.from && amb.to ? `${amb.from.name} → ${amb.to.name}` : '';
    result.transport = tp;
    result.reportText += ' | ' + transportLine(tp) + ` | 조회 ${kstStr(new Date(), true)} KST`;
    state.last = { result, data, pts };
    $('map-click-on').checked = false;     // 판단 실행 후에는 지도를 눌러도 출발·목적지가 바뀌지 않게 잠금
    renderTransport(tp);
    render(result, { isNight, isSea, warns });
    renderHeadline(result, tp); renderDataStatus(meta); startOldWatch(); saveRoute(pts);
    drawMap(result, data, pts);
    $('run-msg').textContent = `판단 완료 ${kstStr(new Date())}`;
    const entry = { time: new Date().toISOString(), from: from.name, to: to.name, via: pts.slice(1, -1).map((p) => p.name).join(' / '), distanceKm: result.distanceKm, overall: result.overall };
    store.set(HIST_KEY, [entry, ...store.get(HIST_KEY, [])].slice(0, 5000));
    showHistoryCount();
    logUsage(entry);
    if (state.serverLog) api('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) }).catch(() => {});
  } catch (e) {
    $('run-msg').textContent = '오류: ' + e.message + ' — 하단 수동 확인 링크를 이용하세요.';
  } finally { $('run').disabled = false; }
}

// ---------- 표시 ----------
function render(r, ctx) {
  const o = $('overall');
  o.className = 'overall'; o.dataset.grade = r.overall;
  o.innerHTML = `${esc(GRADE_TEXT[r.overall])}${r.overallNote ? `<span class="sub">${esc(r.overallNote)}</span>` : ''}`;
  $('route-info').innerHTML = [
    ['거리', `${r.distanceKm}km / ${r.distanceNm}NM`], ['소요', `${r.durationMin}분${r.totalStayMin ? ` (체류 ${r.totalStayMin}분)` : ''}`], ['도착 예정', kstStr(r.arriveUtc)],
    ['적용 기준', `${ctx.isNight ? '야간' : '주간'}·${ctx.isSea ? '해상' : '육상'} ${r.limits.visM}m/${r.limits.ceilFt}ft`],
  ].map(([k, v]) => `<div>${esc(k)}<b>${esc(v)}</b></div>`).join('');
  $('data-warn').innerHTML = ctx.warns.length ? ctx.warns.map(esc).join('<br>') + ' <button type="button" id="retry-run" class="mini">다시 시도</button>' : '';
  $('sun').innerHTML = (r.sunNote ? `<div class="alert">☀ ${esc(r.sunNote)}</div>` : '')
    + r.sun.map((s) => `<div class="s"><b>${esc(s.segment)}</b><span>${esc(s.name)}</span><span>일출 ${esc(kstStr(s.sunrise))} · 일몰 ${esc(kstStr(s.sunset))}</span></div>`).join('');
  $('legs').innerHTML = r.legs.length > 1 || r.totalStayMin ? r.legs.map((l, i) => `<tr><td data-l="구간">${esc(l.from)} → ${esc(l.to)}</td><td data-l="거리">${l.distanceKm}km</td><td data-l="소요">${l.durationMin}분</td>
    <td data-l="출발">${esc(kstStr(l.departUtc))}${i > 0 && r.points[i].stayMin ? ` <small>(체류 ${r.points[i].stayMin}분)</small>` : ''}</td><td data-l="도착">${esc(kstStr(l.arriveUtc))}</td></tr>`).join('') : '';

  $('rows').innerHTML = r.rows.map((x) => `<tr class="${x.grade}">
    <td data-l="구간">${esc(x.segment)}</td><td data-l="항목">${esc(x.item)}</td><td data-l="값">${esc(x.value)}</td><td data-l="기준">${esc(x.limit)}</td>
    <td data-l="판정"><span class="badge ${x.grade}">${esc(GRADE_TEXT[x.grade])}</span>${x.note ? `<div class="note">${esc(x.note)}</div>` : ''}</td>
    <td class="note" data-l="출처">${esc(x.source)}${x.obsTime ? ' · ' + esc(kstStr(x.obsTime)) : ''}</td></tr>`).join('');

  $('wind').innerHTML = r.wind.map((w) => `<div class="card"><small>${esc(w.segment)} · ${esc(w.name)}</small>
    <div class="v">${w.windMs === null ? '-' : `<span class="arrow" style="transform:rotate(${(w.windDir ?? 0) + 180}deg)">↑</span> ${esc(dirText(w.windDir))} ${esc(w.windMs)}m/s <small>(${esc(w.windKt)}kt)</small>`}</div>
    <small>순간최대 ${w.gustMs ?? '-'}m/s${w.gustKt !== null && w.gustKt !== undefined ? ` (${w.gustKt}kt)` : ''}${w.trend ? ' · 10분 추세 ' + esc(w.trend) : ''}${w.obsTime ? ' · ' + esc(kstStr(w.obsTime)) : ''}</small></div>`).join('');

  const inScope = r.notams.filter((n) => n.inScope).sort((a, b) => (a.distanceNm ?? 1e9) - (b.distanceNm ?? 1e9));
  const out = r.notams.length - inScope.length;
  const rel = (n) => (n.relation === 'CROSS' ? (n.prohibited ? '비행금지구역 통과' : '경로 통과') : n.relation === 'BUFFER' ? '완충구역 통과' : n.relation === 'NEAR' ? `경로 ${n.distanceNm.toFixed(1)}NM 근접` : n.relation === 'CLEAR' ? `경로에서 ${n.distanceNm.toFixed(1)}NM` : '위치 해석 불가');
  // 경로상에 해당하는 NOTAM(통과·근접, 위치를 읽지 못한 것 포함)만 안내하고, 경로와 무관한 것은 접어 둔다
  const card = (n) => `<div class="n ${n.grade}">
      <b>${esc(n.id || '해석 불가')}</b> ${esc(n.qcodeText || '')} · ${esc(rel(n))}
      · ${n.activeDuringFlight === null ? '발효기간 해석 불가' : n.activeDuringFlight ? '<b>비행 시간대 발효</b>' : '비행 시간대 미발효'}
      <div>${esc(kstStr(n.start, true))} ~ ${n.endPerm ? 'PERM' : esc(kstStr(n.end, true))}${n.endEst ? ' (EST)' : ''} KST · ${esc(n.lower)}~${esc(n.upper)}
      ${n.geomSource === 'Q' ? ' · Q-line 기준(근사)' : ''}</div>
      ${n.center ? `<div class="ncoord">📍 ${esc(formatCoord(n.center, fmtNow()))} · ${n.prohibited ? '금지 ' : ''}반경 ${esc(fmtNm(n.radiusNm))}</div>` : ''}
      ${n.buffer ? `<div class="nbuf">┄ 완충구역: 금지구역 바깥으로 +${esc(n.buffer.widthNm)}NM (중심에서 ${esc(n.buffer.outerNm)}NM)<br><small>${esc(n.buffer.basis)}</small></div>` : ''}
      ${(n.exceptions || []).length ? `<div class="nexc">예외(원문): ${n.exceptions.map(esc).join(' / ')}</div>` : ''}
      ${n.needsPermission ? `<div class="perm">⚠ 소방헬기 사전허가 필요${n.phones.length ? ': ' + esc(n.phones.join(', ')) : ''}</div>` : ''}
      <details><summary>원문</summary><pre>${esc(n.raw)}</pre></details></div>`;
  const onRoute = inScope.filter((n) => n.relation !== 'CLEAR'), offRoute = inScope.filter((n) => n.relation === 'CLEAR');
  $('notam-list').innerHTML = (onRoute.length ? onRoute.map(card).join('')
    : `<p class="hint">${!notamText().trim() ? 'NOTAM 미입력 — xNotam 조회 후 붙여넣기' : inScope.length ? '경로상에 해당하는 NOTAM이 없습니다' : '확인 대상(D 시리즈) NOTAM 없음'}</p>`)
    + (offRoute.length ? `<details class="faroff"><summary>경로와 무관한 NOTAM ${offRoute.length}건 (보기)</summary>${offRoute.map(card).join('')}</details>` : '')
    + (out ? `<p class="hint">확인 대상 아님(D 시리즈 외) ${out}건</p>` : '');

  $('report-text').value = r.reportText;
  const g22 = art22Items({ isNight: ctx.isNight, isSea: ctx.isSea });
  $('art22').innerHTML = g22.length ? `<details open class="a22"><summary>제22조 특수조건 확인 <small>(규정 원문 · 판정에는 반영되지 않음)</small></summary>`
    + g22.map((g) => `<div class="g"><b>${esc(g.title)}</b><ul>${g.items.map((x) => `<li><label><input type="checkbox"> ${esc(x)}</label></li>`).join('')}</ul>${g.proviso ? `<p class="hint">※ ${esc(g.proviso)}</p>` : ''}</div>`).join('')
    + (ctx.isSea && $('landsea').value === 'auto' ? '<p class="hint">※ 경로에 바다 위 구간이 있어 해상 기준(더 엄격)을 적용했습니다. 육상 비행이면 [육상/해상]에서 "육상"을 선택하세요.</p>' : '') + '</details>' : '';
  const ct = criteriaTable(state.config);
  const rowsHtml = (list) => list.map((x) => `<tr><th>${esc(x.label)}</th><td>${esc(x.value)}${x.basis ? ` <small>(${esc(x.basis)})</small>` : ''}</td></tr>`).join('');
  $('criteria').innerHTML = `<h4>규정 조문 (119항공대 운영 규정)</h4><table class="kv">${rowsHtml(ct.regulation)}</table>
    <h4>시스템 설정값 <small>(규정이 아니라 보수적으로 정한 운영 설정 — config.json에서 변경)</small></h4><table class="kv">${rowsHtml(ct.settings)}</table>`;
  $('sigwx-raw-wrap').hidden = false;
}

async function syncLocalUsage() {      // 이 브라우저의 지난 이력(집계 기준일 이후)을 공용 누적에 합침. 같은 기록은 중복되지 않음
  const SINCE = Date.parse('2026-11-08T00:00:00+09:00'), DONE_KEY = 'heliwx.usageSynced';
  const rows = store.get(HIST_KEY, []).filter((r) => r.time && Date.parse(r.time) >= SINCE && r.from && r.to);
  if (!rows.length || store.get(DONE_KEY, 0) >= rows.length) return;
  for (let i = 0; i < rows.length; i += 50) {
    const r = await api('/api/usage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: rows.slice(i, i + 50) }) });
    if (!r.ok) return;
  }
  store.set(DONE_KEY, rows.length);
}
async function refreshUsage() {
  if (!state.usageShared) return;
  try { await syncLocalUsage(); } catch { /* 합치기는 다음에 다시 시도 */ }
  try { const d = await (await api('/api/usage')).json(); if (d.shared) showUsage(d); } catch { /* 누적 표시는 부가 기능 */ }
}
function showUsage(u) {
  $('usage-box').hidden = false; $('usage-chip').hidden = false;
  $('usage-total').textContent = u.total.toLocaleString('ko-KR'); $('usage-chip-n').textContent = u.total.toLocaleString('ko-KR');
  $('usage-sub').textContent = u.total ? `· 오늘 ${u.today}건 · 사용일 ${u.activeDays}일` + ` · ${u.since} 부터 집계` : '· 아직 기록 없음';
  const max = Math.max(1, ...u.last7.map((d) => d.count));
  $('usage-bars').innerHTML = u.last7.map((d) => `<span class="${d.count ? '' : 'zero'}" style="height:${Math.max(4, Math.round((d.count / max) * 100))}%" title="${esc(d.date)} ${d.count}건"></span>`).join('');
}
async function downloadUsage() {
  const r = await api('/api/usage?format=csv');
  if (!r.ok) { alert('내려받지 못했습니다 (' + r.status + ')'); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await r.blob());
  a.download = `재난하늘119-공용누적이력-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
}
// 기상 자료 한 종류 수신: 실패(오류·응답 없음)이면 잠시 뒤 한 번 더 시도
async function fetchKind(k) {
  const once = () => api('/api/' + k).then((r) => r.json());
  try {
    const d = await once();
    if (!(d.error && !(d.items || []).length)) return d;
  } catch (e) { if (/접속코드/.test(e.message)) throw e; }
  await new Promise((r) => setTimeout(r, 1500));
  return once();
}
function transportLine(tp) {
  const h = `헬기 총 ${tp.heli.totalMin}분(접수→이륙 ${tp.heli.prepMin}분+비행 ${tp.heli.flightMin}분)`;
  const a = tp.amb ? `구급차 ${tp.amb.totalMin}분(${tp.amb.distanceKm}km, ${tp.amb.source === 'kakao' ? '카카오 길찾기' : '추정'})` : '구급차 시간 미확인';
  return `출동수단 비교: ${h} vs ${a} → ${tp.text}`;
}
function renderTransport(tp) {
  const el = $('transport'); el.hidden = false;
  const bar = (parts) => { const t = parts.reduce((a, [, v]) => a + v, 0) || 1; return `<div class="bar">${parts.map(([c, v]) => `<i class="${c}" style="width:${(v / t) * 100}%"></i>`).join('')}</div>`; };
  const maxT = Math.max(tp.heli.totalMin, tp.amb ? tp.amb.totalMin : 0) || 1;
  const heli = `<div class="tcard ${tp.verdict === 'HELI' ? 'win' : ''}"><div>🚁 헬기</div><b class="big">${tp.heli.totalMin}분</b>
      <div style="width:${(tp.heli.totalMin / maxT) * 100}%">${bar([['p', tp.heli.prepMin], ['f', tp.heli.flightMin]])}</div>
      <div>접수→이륙 ${tp.heli.prepMin}분 + 비행 ${tp.heli.flightMin}분</div><div class="tsub">항공대 → 현장 → 병원</div></div>`;
  const amb = tp.amb ? `<div class="tcard ${tp.verdict === 'AMBULANCE' && tp.diffMin !== null ? 'win' : ''}"><div>🚑 구급차</div><b class="big">${tp.amb.totalMin}분</b>
      <div style="width:${(tp.amb.totalMin / maxT) * 100}%">${bar([['r', tp.amb.totalMin]])}</div>
      <div>도로 ${tp.amb.distanceKm}km · ${tp.amb.source === 'kakao' ? '카카오맵 최단시간 경로' : '직선거리 기반 추정'}</div><div class="tsub">${esc(tp.ambRoute || '현장 → 병원')}</div>${tp.amb.source === 'kakao' ? '' : `<div class="tsub warn">⚠ ${esc(tp.amb.note || '추정값')}</div>`}</div>`
    : `<div class="tcard"><div>🚑 구급차</div><b class="big">-</b><div>${esc(/입력|추가/.test(tp.missing || '') ? '현장→병원 미지정' : '이동시간을 구하지 못함')}</div></div>`;
  el.innerHTML = `<h3>출동 수단 비교 <small>(헬기 vs 구급차 · 목적지까지 소요시간)</small></h3><div class="tcols">${heli}${amb}</div>
    <div class="verdict ${tp.verdict}">${esc(tp.text)}</div>
    ${tp.caution.map((c) => `<p class="tnote">※ ${esc(c)}</p>`).join('')}
    <p class="tnote">※ 헬기는 접수~이륙 준비 후 비행시간을 더한 값이며 착륙·환자 인계 시간은 포함하지 않습니다. 최종 판단은 통제관·기장이 합니다.</p>`;
}
// ---------- 구급차 이동시간(현장 → 병원) ----------
state.amb = { from: null, to: null };
function wireAmb() {
  for (const side of ['from', 'to']) {
    searchBox($(`amb-${side}-q`), $(`amb-${side}-results`), (pl) => { state.amb[side] = pl; $(`amb-${side}-q`).value = ''; $(`amb-${side}-q`).placeholder = pl.name; showAmb(); });
  }
  $('amb-clear').addEventListener('click', () => { state.amb = { from: null, to: null }; for (const s of ['from', 'to']) { $(`amb-${s}-q`).value = ''; $(`amb-${s}-q`).placeholder = s === 'from' ? '현장 검색' : '병원 검색'; } showAmb(); });
  showAmb();
}
function showAmb() {
  if (!$('amb-loc')) return;
  const pts = readyPoints().pts, d = ambPoints(pts);
  const fmt = (x, auto) => (x ? `📍 ${x.name} (${x.lat.toFixed(4)}, ${x.lon.toFixed(4)})${auto ? ' · 자동' : ''}` : '입력 필요');
  $('amb-loc').textContent = `${fmt(d.from, !state.amb.from && d.from)} → ${fmt(d.to, !state.amb.to && d.to)}`;
}
// 입력이 없으면 경유지 1(현장)→목적지(병원)을 쓴다. 경유지도 없으면 null
function ambPoints(pts) {
  const via1 = pts.length > 2 ? pts[1] : null, dest = pts.length > 1 ? pts[pts.length - 1] : null;
  return { from: state.amb.from || via1, to: state.amb.to || dest };
}
// ---------- 입력 시트(엑셀 시트 탭처럼 ①임무 입력 ②주요지점 ③항공고시보 전환) ----------
const SHEET_KEY = 'heliwx.sheet';
function showSheet(n) {
  n = String(n);
  document.querySelectorAll('.sheet-tab').forEach((b) => { const on = b.dataset.sheet === n; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
  document.querySelectorAll('.sheet').forEach((d) => { d.hidden = d.id !== 'sheet-' + n; });
  const rb = $('runbar'); if (rb) rb.hidden = n === '4';          // 임무브리핑에는 판단 실행 줄이 필요 없음
  try { sessionStorage.setItem(SHEET_KEY, n); } catch { /* 저장 불가여도 동작 */ }
}
function setupSheets() {
  document.querySelectorAll('.sheet-tab').forEach((b) => b.addEventListener('click', () => showSheet(b.dataset.sheet)));
  let n = '1'; try { n = sessionStorage.getItem(SHEET_KEY) || '1'; } catch { /* 무시 */ }
  showSheet(['1', '2', '3', '4'].includes(n) ? n : '1');
}
function updateTabCounts() { /* 탭에는 개수를 표시하지 않음 */ }
function fmtNm(nm) { return nm == null ? '-' : `${+(+nm).toFixed(1)}NM`; }   // NOTAM 화면은 NM만 표시(km 병기 없음)
// 누적 사용량 1건 기록(판단 실행·임무브리핑 복사)
function logUsage(entry) {
  if (!state.usageShared) return;
  api('/api/usage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) }).then((r) => r.ok ? r.json() : null).then((d) => d && d.stats && showUsage(d.stats)).catch(() => {});
}
function showHistoryCount() { $('history-count').textContent = `(이 브라우저 ${store.get(HIST_KEY, []).length}건)`; }
function downloadHistory() {
  const rows = store.get(HIST_KEY, []);
  const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const csv = ['시각(KST),출발,경유지,목적지,거리km,종합판정', ...rows.map((r) => [kstStr(r.time, true), r.from, r.via || '', r.to, r.distanceKm, GRADE_TEXT[r.overall] || r.overall].map(cell).join(','))].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `재난하늘119-이력-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
}

async function copyReport() {
  const t = $('report-text').value;
  if (!t) return;
  try { await navigator.clipboard.writeText(t); } catch { $('report-text').select(); document.execCommand('copy'); }
  $('copy').textContent = '복사됨'; setTimeout(() => { $('copy').textContent = '보고문 복사'; }, 1500);
}

// ---------- 지도 ----------
function clearOverlays() { state.overlays.forEach((o) => o.setMap(null)); state.overlays = []; }
function add(o) { o.setMap(state.map); state.overlays.push(o); return o; }
function drawRouteOnly() {
  const { pts, bad } = readyPoints();
  if (state.map && !bad.length && pts.length >= 2) drawMap(null, null, pts);
}



// ---------- 위치·좌표 찾기: 지도 위 검색창 → 이동·표시·좌표 보기·복사·지점으로 지정 ----------
function foundText(f) { return `${f.lat.toFixed(6)}, ${f.lon.toFixed(6)}`; }
function showFound(f, move = true) {
  state.found = f;
  const c = $('ms-card'); c.hidden = false;
  $('ms-name').textContent = f.name; $('ms-addr').textContent = f.addr || '';
  $('ms-dec').textContent = foundText(f); $('ms-ddm').textContent = formatCoord(f, 'ddm'); $('ms-dms').textContent = formatCoord(f, 'dms');
  if (move) moveMapTo(f);
  redrawFound();
}
function moveMapTo(f) {
  if (AERIAL.on && AERIAL.map) AERIAL.map.setView([f.lat, f.lon], 18);
  else if (state.map && state.kakao) { state.map.setCenter(new state.kakao.LatLng(f.lat, f.lon)); state.map.setLevel(3); }
}
function redrawFound() {
  if (state.map && state.kakao) { if (state.foundOv) state.foundOv.setMap(null); state.foundOv = null; if (state.found) { state.foundOv = new state.kakao.CustomOverlay({ position: new state.kakao.LatLng(state.found.lat, state.found.lon), yAnchor: 1, zIndex: 20, content: `<div class="found-pin">📍 ${esc(state.found.name)}</div>` }); state.foundOv.setMap(state.map); } }
  if (AERIAL.map) { if (AERIAL.foundMk) AERIAL.map.removeLayer(AERIAL.foundMk); AERIAL.foundMk = null; if (state.found && window.L) AERIAL.foundMk = window.L.circleMarker([state.found.lat, state.found.lon], { radius: 9, color: '#fff', weight: 3, fillColor: '#ff9800', fillOpacity: 1 }).addTo(AERIAL.map).bindTooltip(esc(state.found.name), { permanent: true, direction: 'top', className: 'pt-tip', opacity: 1 }); }
}
function clearFound() { state.found = null; $('ms-card').hidden = true; redrawFound(); }
async function copyText(t) { try { await navigator.clipboard.writeText(t); } catch { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); } }
function setupFinder() {
  searchBox($('ms-q'), $('ms-results'), (pl) => { $('ms-q').value = ''; showFound(pl, true); });
  $('ms-close').addEventListener('click', clearFound);
  document.querySelectorAll('#ms-card .cp').forEach((b) => b.addEventListener('click', async () => { await copyText($(b.dataset.cp).textContent); b.textContent = '복사됨'; setTimeout(() => { b.textContent = '복사'; }, 1400); }));
  const asPoint = (key) => () => { const f = state.found; if (!f) return; setPointByKey(key, { name: f.name, lat: f.lat, lon: f.lon }); showSheet(1); };
  $('ms-from').addEventListener('click', asPoint('from')); $('ms-to').addEventListener('click', asPoint('to'));
  $('ms-via').addEventListener('click', () => {
    const f = state.found; if (!f) return;
    if (state.points.filter((p) => p.role === 'via').length >= MAX_VIA) { $('run-msg').textContent = `경유지는 최대 ${MAX_VIA}개입니다`; return; }
    state.points.splice(state.points.length - 1, 0, { role: 'via', name: f.name, lat: f.lat, lon: f.lon, text: formatCoord(f, fmtNow()), stayMin: 0 }); renderPoints(); showSheet(1);
  });
  $('ms-save').addEventListener('click', () => {
    const f = state.found; if (!f) return;
    showSheet(2); $('place-name').value = f.name.slice(0, 50); $('place-coord').value = formatCoord(f, fmtNow()); $('place-name').focus(); $('place-msg').textContent = '종류·메모를 확인하고 [추가]를 누르세요';
  });
}

// ---------- 지도에서 지점 지정(카카오·항공사진 공통) ----------
function mapClickAt(lat, lon) {
  if (!$('map-click-on').checked) {   // 잠겨 있으면 지점은 바꾸지 않고, 누른 곳의 주소·좌표만 보여 준다
    const q = { name: `지도 지점(${lat.toFixed(4)}, ${lon.toFixed(4)})`, lat, lon, addr: '' };
    state.geocoder.coord2Address(lon, lat, (res, st) => { if (st === state.kakao.services.Status.OK && res[0]) { q.name = (res[0].road_address || res[0].address).address_name; } showFound(q, false); });
    return;
  }
  const which = state.clickTarget;
  const p = { name: `지도 지점(${lat.toFixed(4)}, ${lon.toFixed(4)})`, lat, lon };
  state.geocoder.coord2Address(p.lon, p.lat, (res, st) => {
    if (st === state.kakao.services.Status.OK && res[0]) p.name = (res[0].road_address || res[0].address).address_name;
    setPointByKey(which, p);
  });
}

// ---------- 항공사진(국토교통부 브이월드) 보기: 고해상도 항공사진 위에 경로·NOTAM·비행금지구역을 같은 좌표로 그림 ----------
const AERIAL = { map: null, group: null, labels: null, labelsOn: true, on: false, errs: 0 };
window.__heliAerial = AERIAL;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  return new Promise((res, rej) => {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/web/vendor/leaflet.css'; document.head.appendChild(l);
    const sc = document.createElement('script'); sc.src = '/web/vendor/leaflet.js'; sc.onload = res; sc.onerror = () => rej(new Error('항공사진 지도 모듈을 불러오지 못했습니다'));
    document.head.appendChild(sc);
  });
}
function noteMap(msg) { const n = $('map-note'); n.textContent = msg || ''; n.hidden = !msg; }
async function setAerial(on) {
  if (on === AERIAL.on) return;
  const kb = state.map.getBounds();
  if (on) {
    try { await loadLeaflet(); } catch (e) { noteMap(e.message); $('mt-road').click(); return; }
    $('map').style.visibility = 'hidden'; $('map2').hidden = false;
    if (!AERIAL.map) {
      const key = encodeURIComponent(state.vworldKey), L = window.L;
      AERIAL.map = L.map('map2', { zoomControl: true, attributionControl: true, maxZoom: 21, minZoom: 5 });
      const tile = (layer, ext, extra = {}) => L.tileLayer(`https://api.vworld.kr/req/wmts/1.0.0/${key}/${layer}/{z}/{y}/{x}.${ext}`, { maxZoom: 21, attribution: '© 국토교통부 브이월드', ...extra });
      // 아래층: 어디서나 있는 낮은 단계 사진을 키워서 깔아 둠(위층 타일이 비어도 빈칸이 안 생김). 위층: 가능한 가장 선명한 단계(19)
      tile('Satellite', 'jpeg', { maxNativeZoom: 17, attribution: '' }).addTo(AERIAL.map);
      const sat = tile('Satellite', 'jpeg', { maxNativeZoom: 19, errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==' });
      sat.on('tileerror', () => { AERIAL.errs++; if (AERIAL.errs === 6) noteMap('항공사진을 불러오지 못하고 있습니다(인증키·사용 도메인 확인 또는 일시 장애)'); });
      sat.on('tileload', () => { if (AERIAL.errs) { AERIAL.errs = 0; noteMap(''); } });
      sat.addTo(AERIAL.map);
      AERIAL.labels = tile('Hybrid', 'png', { maxNativeZoom: 19, attribution: '' }); if (AERIAL.labelsOn !== false) AERIAL.labels.addTo(AERIAL.map);
      AERIAL.group = L.layerGroup().addTo(AERIAL.map);
      AERIAL.map.on('click', (e) => mapClickAt(e.latlng.lat, e.latlng.lng));
    }
    AERIAL.on = true; AERIAL.map.invalidateSize();
    const sw = kb.getSouthWest(), ne = kb.getNorthEast();
    AERIAL.map.fitBounds([[sw.getLat(), sw.getLng()], [ne.getLat(), ne.getLng()]]);
    drawAerial(state.last ? state.last.result : null, readyPoints().pts); redrawFound();
  } else {
    AERIAL.on = false; noteMap('');
    if (AERIAL.map) {
      const b = AERIAL.map.getBounds(), k = state.kakao;
      $('map2').hidden = true; $('map').style.visibility = '';
      state.map.relayout();
      const kb2 = new k.LatLngBounds(); kb2.extend(new k.LatLng(b.getSouth(), b.getWest())); kb2.extend(new k.LatLng(b.getNorth(), b.getEast()));
      state.map.setBounds(kb2, 0, 0, 0, 0);
    }
  }
}
function drawAerial(result, pts) {
  if (!AERIAL.on || !AERIAL.map) return;
  const L = window.L, g = AERIAL.group; g.clearLayers();
  for (const a of AREAS) {
    const col = a.color;
    L.polygon(a.poly.map((p) => [p.lat, p.lon]), { color: col, weight: 2, dashArray: '6 5', fillColor: col, fillOpacity: 0.12 }).addTo(g)
      .bindTooltip(`${a.short} ${a.kind === 'P' ? '비행금지' : '비행제한'} · ${esc(a.name)}`, { sticky: true, className: 'ar-tip', opacity: 1 });
  }
  const list = result ? result.notams.filter((n) => n.inScope && n.center) : currentNotams();
  list.forEach((n) => {
    const off = n.relation === 'CLEAR' || n.activeDuringFlight === false;
    L.circle([n.center.lat, n.center.lon], { radius: ringNm(n) * 1852, color: '#ffb300', weight: 2, dashArray: '4 6', opacity: off ? 0.5 : 0.95, fillColor: '#ffb300', fillOpacity: 0.05 }).addTo(g);
    L.circle([n.center.lat, n.center.lon], { radius: n.radiusNm * 1852, color: '#ff2d20', weight: 3, dashArray: off ? '8 6' : null, opacity: off ? 0.7 : 1, fillColor: '#ff2d20', fillOpacity: off ? 0.08 : 0.2 }).addTo(g);
    L.tooltip({ permanent: true, direction: 'top', className: 'nt-tip', opacity: 1 }).setContent(`${esc(n.id || 'NOTAM')}<br>${n.prohibited ? '금지 ' : ''}반경 ${esc(fmtNm(n.radiusNm))}${n.buffer ? `<br>완충 +${esc(n.buffer.widthNm)}NM (${esc(n.buffer.outerNm)}NM)` : ''}<br>${esc(notamPeriod(n))}`).setLatLng([n.center.lat, n.center.lon]).addTo(g);
  });
  if (pts && pts.length >= 2) {
    const ll = pts.map((p) => [p.lat, p.lon]);
    L.polyline(ll, { color: '#00e5ff', weight: 5, opacity: 0.95 }).addTo(g);
    pts.forEach((p, i) => {
      L.circleMarker([p.lat, p.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#0b4f8a', fillOpacity: 1 }).addTo(g)
        .bindTooltip(`${i === 0 ? '출발 ' : i === pts.length - 1 ? '목적 ' : `경유${i} `}${esc(p.name)}`, { permanent: true, direction: 'right', className: 'pt-tip', opacity: 1 });
    });
  }
}

// 지도 종류 전환: 일반 ↔ 위성(스카이뷰 + 지명 겹침). 선택은 이 브라우저에 기억한다.
const MAPTYPE_KEY = 'heliwx.maptype';
function setMapType(kind) {
  const k = state.kakao; if (!k || !state.map) return;
  const aerial = kind === 'aerial';
  if (aerial && !state.vworldKey) return;
  setAerial(aerial);
  if (!aerial) state.map.setMapTypeId(k.MapTypeId.ROADMAP);
  for (const [id, on] of [['mt-road', !aerial], ['mt-aerial', aerial]]) { $(id).classList.toggle('on', on); $(id).setAttribute('aria-pressed', on ? 'true' : 'false'); }
  $('mt-labels').hidden = !aerial;
  try { localStorage.setItem(MAPTYPE_KEY, kind); } catch { /* 저장 불가여도 동작 */ }
}
const LABELS_KEY = 'heliwx.aerialLabels';
function setAerialLabels(on) {
  AERIAL.labelsOn = on;
  if (AERIAL.map && AERIAL.labels) { if (on) AERIAL.labels.addTo(AERIAL.map); else AERIAL.map.removeLayer(AERIAL.labels); }
  $('mt-labels').classList.toggle('on', on); $('mt-labels').setAttribute('aria-pressed', on ? 'true' : 'false');
  try { localStorage.setItem(LABELS_KEY, on ? '1' : '0'); } catch { /* 무시 */ }
}
function setupMapType() {
  if (!state.vworldKey) return;           // 항공사진을 쓸 수 없으면 일반 지도만 사용(버튼 표시 안 함)
  $('maptype').hidden = false;
  $('mt-road').addEventListener('click', () => setMapType('road'));
  $('mt-aerial').addEventListener('click', () => setMapType('aerial'));
  $('mt-labels').addEventListener('click', () => setAerialLabels(!AERIAL.labelsOn));
  let on = true; try { on = localStorage.getItem(LABELS_KEY) !== '0'; } catch { /* 무시 */ }
  AERIAL.labelsOn = on; $('mt-labels').classList.toggle('on', on); $('mt-labels').setAttribute('aria-pressed', on ? 'true' : 'false');
  let k = 'road'; try { k = localStorage.getItem(MAPTYPE_KEY) || 'road'; } catch { /* 무시 */ }
  if (k === 'aerial') setMapType('aerial');
}
// 처음(새로고침) 지도 시점: 대한민국 전체(제주·울릉도·독도 포함)
function fitKorea() {
  const k = state.kakao; if (!k || !state.map) return;
  const b = new k.LatLngBounds(); b.extend(new k.LatLng(33.0, 124.6)); b.extend(new k.LatLng(38.7, 131.9));
  state.map.setBounds(b, 10, 10, 10, 10);
}
// ---------- 비행금지구역(P-73·P-518 등) 지도 표시(상시) ----------
function areaLayer() {
  const k = state.kakao; if (!k) return;
  for (const a of AREAS) {
    const pg = add(new k.Polygon({ path: a.poly.map((p) => new k.LatLng(p.lat, p.lon)), strokeWeight: 2, strokeColor: a.color, strokeOpacity: 0.9, strokeStyle: 'shortdash', fillColor: a.color, fillOpacity: 0.10 }));
    // 지도에는 글자를 상시 표시하지 않고, 마우스를 올리면(또는 눌러 보면) 구역 이름을 잠시 보여 준다
    const tip = (e) => { hideAreaTip(); state.areaTip = new k.CustomOverlay({ position: e.latLng, yAnchor: 1.4, zIndex: 25, content: `<div class="area-label ${a.kind}" title="${esc(AIRAC_NOTE)}">${esc(a.short)} ${a.kind === 'P' ? '비행금지' : '비행제한'} · ${esc(a.name)}</div>` }); state.areaTip.setMap(state.map); };
    k.event.addListener(pg, 'mouseover', tip); k.event.addListener(pg, 'mouseout', hideAreaTip);
  }
}
function hideAreaTip() { if (state.areaTip) { state.areaTip.setMap(null); state.areaTip = null; } }
// ---------- NOTAM 지도 표시(상시): 붙여넣은 D 시리즈 NOTAM을 판단 실행 전에도 빨간 원·좌표·반경으로 그림 ----------
// 유효시간(KST): 시작 ~ 종료(PERM·추정(EST) 표시)
function notamPeriod(n) {
  const a = n.start ? kstStr(n.start, true) : '?', b = n.endPerm ? 'PERM' : n.end ? kstStr(n.end, true) : '?';
  return `${a} ~ ${b}${n.endEst ? '(EST)' : ''} KST`;
}
function currentNotams() {
  return splitNotams(notamText()).map(parseNotam).filter((n) => n.id && n.series === 'D' && n.center);
}
const bufferNm = () => ((state.config && state.config.radius && state.config.radius.notamNearNm) ?? 5);
const ringNm = (n) => (n.buffer ? n.buffer.outerNm : n.radiusNm + bufferNm());   // NOTAM이 완충구역을 정하면 그 외곽, 아니면 시스템 근접 경고권
const far0 = (n) => n.relation === 'CLEAR' || n.activeDuringFlight === false;
function notamLayer(list, bounds, extend) {
  const k = state.kakao, ll = (p) => new k.LatLng(p.lat, p.lon);
  list.forEach((n, idx) => {
    const far = n.relation === 'CLEAR';                 // 판단 실행 결과 경로와 무관한 NOTAM은 점선·옅게
    const off = n.activeDuringFlight === false || far;  // 비행 시간대 미발효로 확인된 NOTAM도 점선·옅게
    add(new k.Circle({ center: ll(n.center), radius: ringNm(n) * 1852, strokeWeight: 2, strokeColor: '#ff8f00', strokeOpacity: far0(n) ? 0.45 : 0.9, strokeStyle: 'shortdash', fillColor: '#ff8f00', fillOpacity: 0.04 }));   // 근접 경고권(버퍼존): 판정에서 "근접"으로 보는 거리
    add(new k.Circle({ center: ll(n.center), radius: n.radiusNm * 1852, strokeWeight: 3, strokeColor: '#d6201a', strokeOpacity: off ? 0.55 : 1, strokeStyle: off ? 'dash' : 'solid', fillColor: '#d6201a', fillOpacity: off ? 0.06 : 0.18 }));
    add(new k.CustomOverlay({ position: ll(n.center), xAnchor: [0.5, -0.12, 1.12][idx % 3], yAnchor: [1.2, 0.5, 0.5][idx % 3], zIndex: 10 + idx, content: `<div class="nt-label${off ? ' off' : ''}${list.length > 3 ? ' compact' : ''}">${esc(n.id || 'NOTAM')}<br>${esc(formatCoord(n.center, fmtNow()))}<br>${n.prohibited ? '금지 ' : ''}반경 ${fmtNm(n.radiusNm)}${n.buffer ? `<br>완충 +${n.buffer.widthNm}NM (${n.buffer.outerNm}NM)` : ''}${far ? ' · 경로 무관' : off ? ' · 미발효' : ''}<br>${esc(notamPeriod(n))}</div>` }));
    if (extend && bounds) bounds.extend(ll(n.center));
  });
}
let notamSyncTimer = null;
function syncMapNotams() {
  clearTimeout(notamSyncTimer);
  notamSyncTimer = setTimeout(() => {
    if (!state.kakao || !state.map) return;
    const { pts, bad } = readyPoints();
    if (!bad.length && pts.length >= 2) { drawMap(null, null, pts); return; }   // 경로가 있으면 경로와 함께 다시 그림
    clearOverlays(); areaLayer();
    notamLayer(currentNotams(), null, false); drawAerial(null, []); redrawFound();          // 경로가 없을 때는 지도 시점을 바꾸지 않는다(처음에는 대한민국 전체)
  }, 250);
}

function drawMap(result, data, pts) {
  const k = state.kakao; if (!k || !state.map) return;
  clearOverlays();
  const ll = (p) => new k.LatLng(p.lat, p.lon);
  add(new k.Polyline({ path: pts.map(ll), strokeWeight: 4, strokeColor: '#0b4f8a', strokeOpacity: 0.9 }));
  pts.forEach((p, i) => add(new k.CustomOverlay({ position: ll(p), yAnchor: 1,
    content: `<div class="pin">${esc((i === 0 ? '출발 ' : i === pts.length - 1 ? '목적 ' : `경유${i} `) + p.name)}</div>` })));
  const b = new k.LatLngBounds(); pts.forEach((p) => b.extend(ll(p)));
  areaLayer();
  notamLayer(result ? result.notams.filter((n) => n.inScope && n.center) : currentNotams(), b, !!result);   // NOTAM은 판단 실행 전에도 항상 표시
  if (result && data) {
    const lim = result.limits, f = state.config.limits.cautionFactor;
    const g = (o) => (o.visM === null || o.visM === undefined ? 'NA' : o.visM < lim.visM || (o.ceilFt !== null && o.ceilFt < lim.ceilFt) ? 'RED' : o.visM < lim.visM * f || (o.ceilFt !== null && o.ceilFt < lim.ceilFt * f) ? 'YELLOW' : 'GREEN');
    const near = (o) => o && typeof o.lat === 'number' && pts.some((p) => distanceKm(o, p) < Math.max(60, routeLengthKm(pts) / 2 + 40));
    for (const o of [...data.metar, ...data.asos].filter(near)) {
      add(new k.CustomOverlay({ position: ll(o), content: `<div class="stn-dot ${g(o)}" title="${esc(o.name)} 시정 ${o.visM ?? '-'}m 운고 ${o.ceilFt ?? '-'}ft"></div>` }));
    }
    const SIG_COLOR = { ICE: '#1f77d0', TURB: '#c4231a', MTN: '#7a5a2a', VIS: '#2e9e5b', TS: '#b100c4', CLD: '#4b6b8a', WIND: '#3b4cc0', ETC: '#555' };
    for (const z of (data.sigwx || []).filter((z) => z.kind !== 'FZL' && z.closed !== false && (!z.layer || z.layer === 'low') && z.points.length >= 3)) {
      const c = SIG_COLOR[z.kind] || '#555';
      add(new k.Polygon({ path: z.points.map(ll), strokeWeight: 2, strokeColor: c, strokeOpacity: 0.8, strokeStyle: 'dash', fillColor: c, fillOpacity: 0.08 }));
    }
    for (const l of data.lightning.filter(near)) add(new k.CustomOverlay({ position: ll(l), content: '<div class="bolt" title="낙뢰">✕</div>' }));
  }
  if (!AERIAL.on) state.map.setBounds(b, 60, 60, 60, 60);
  drawAerial(result, pts); redrawFound();
  if (AERIAL.on && pts.length >= 2) AERIAL.map.fitBounds(pts.map((p) => [p.lat, p.lon]), { padding: [60, 60], maxZoom: 15 });
}

init().catch((e) => { $('run-msg').textContent = '초기화 실패: ' + e.message; });

// ---------- ④ 임무브리핑: 출동 정보를 메신저로 미리 알리는 전송문 ----------
const BR_KEY = 'heliwx.brief';
function setupBrief() {
  const saved = {};                                           // 새로고침하면 다른 입력처럼 초기화(저장하지 않음)
  try { localStorage.removeItem(BR_KEY); } catch { /* 무시 */ }
  const find = (kind) => { for (const [ci, c] of CATS.entries()) for (const [n, id] of c.items) if (n === kind) return { ci, kind: n, tpl: TEMPLATES.find((t) => t.id === id) }; return null; };
  const br = { ...(find(saved.kind) || find('산불')), values: {}, etc: new Set(), routes: new Set(), etcText: '', custom: false, places: {} };
  $('br-unit').value = saved.unit || '';
  $('br-fmt').value = ['dd', 'ddm', 'dms'].includes(saved.fmt) ? saved.fmt : (fmtNow() || 'dd');
  const save = () => {};
  const title = () => titleOf($('br-region').value, br.kind);
  const refresh = () => {                                     // 전송문을 다시 만든다(직접 고친 뒤에는 덮어쓰지 않음)
    $('br-title-show').textContent = title();
    if (br.custom) return;
    $('br-out').value = buildBrief({ tpl: br.tpl, unit: $('br-unit').value, title: title(), values: br.values, etcChecks: [...br.etc], etcText: br.etcText, routes: [...br.routes] });
  };
  const drawTypes = () => {
    $('br-cats').innerHTML = CATS.map((c, i) => `<button type="button" class="chip${i === br.ci ? ' on' : ''}" data-c="${i}" aria-expanded="${i === br.ci}">${esc(c.name)} ${i === br.ci ? '▾' : '▸'}</button>`).join('');
    $('br-types').innerHTML = CATS[br.ci].items.map(([n]) => `<button type="button" class="chip${n === br.kind ? ' on' : ''}" data-t="${esc(n)}">${esc(n)}</button>`).join('');
  };
  const build = () => {
    drawTypes(); br.values = {}; br.etc = new Set(); br.routes = new Set(); br.etcText = ''; br.custom = false; br.places = {};
    $('br-fields').innerHTML = br.tpl.fields.map((f) => `<div class="br-row"><label>${esc(f.label)}</label><div class="br-in">`
      + `<input type="text" data-k="${f.k}" placeholder="${esc(f.type === 'place' ? '장소·주소 검색 → 좌표 자동 입력' : f.ph)}" autocomplete="off">`
      + (f.type === 'place' ? `<ul class="results" data-r="${f.k}"></ul><input type="text" class="br-coord" data-ck="${f.k}" placeholder="좌표 입력 → 주소·좌표 자동 (예: 37.5583, 126.7906)" autocomplete="off">` : '')
      + `</div><label class="br-clr" title="이 칸 지우기"><input type="checkbox" data-clr="${f.k}"> 지움</label></div>`).join('');
    $('br-etc').innerHTML = '<b>기타</b> ' + ETC_CHECKS.map((c) => `<label class="inline"><input type="checkbox" data-etc="${esc(c)}"> ${esc(c)}</label>`).join(' ')
      + ' · ' + ROUTE_HOSPS.map((c) => `<label class="inline"><input type="checkbox" data-route="${esc(c)}"> ${esc(c)}</label>`).join(' ')
      + ' <input type="text" id="br-etc-text" placeholder="직접 입력" autocomplete="off">';
    br.tpl.fields.forEach((f) => {
      const inp = $('br-fields').querySelector(`input[data-k="${f.k}"]`);
      inp.addEventListener('input', () => { br.values[f.k] = inp.value; br.custom = false; refresh(); });
      if (f.type === 'req' || f.type === 'time') {              // "충북 1120" → "충북소방본부(11:20)"
        const conv = () => { const v = f.type === 'req' ? parseReq(inp.value) : (parseTime(inp.value) || inp.value.trim()); if (v !== inp.value) { inp.value = v; br.values[f.k] = v; br.custom = false; refresh(); } };
        inp.addEventListener('blur', conv); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') conv(); });
      }
      if (f.type === 'place') {
        const ul = $('br-fields').querySelector(`ul[data-r="${f.k}"]`);
        const put = (pl) => { inp.value = composeLoc(pl, $('br-fmt').value); br.values[f.k] = inp.value; br.places[f.k] = pl; br.custom = false; refresh(); };
        searchBox(inp, ul, put);
        const ci = $('br-fields').querySelector(`input[data-ck="${f.k}"]`);   // 좌표를 직접 입력하면 주소를 찾아 "주소(좌표)"로
        const fromCoord = () => {
          const txt = ci.value.trim(); if (!txt) return;
          let c = parseCoord(txt, $('br-fmt').value);
          if (c.error) for (const m of ['dd', 'ddm', 'dms']) { c = parseCoord(txt, m); if (!c.error) break; }
          ci.classList.toggle('bad', !!c.error);
          if (c.error || !Number.isFinite(c.lat)) return;
          const done = (addr) => put({ name: addr ? '' : '지정 좌표', addr, lat: c.lat, lon: c.lon });
          if (state.geocoder && state.kakao) {
            let fin = false; const t = setTimeout(() => { if (!fin) { fin = true; done(''); } }, 3000);
            try { state.geocoder.coord2Address(c.lon, c.lat, (res, st) => { if (fin) return; fin = true; clearTimeout(t); done(st === state.kakao.services.Status.OK && res[0] ? (res[0].road_address || res[0].address).address_name : ''); }); } catch { fin = true; clearTimeout(t); done(''); }
          } else done('');
        };
        ci.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fromCoord(); } });
        ci.addEventListener('change', fromCoord);
      }
    });
    $('br-fields').querySelectorAll('input[data-clr]').forEach((c) => c.addEventListener('change', () => {   // 네모칸을 누르면 그 칸이 지워짐(체크는 곧 해제)
      const k = c.dataset.clr; br.values[k] = ''; delete br.places[k];
      $('br-fields').querySelectorAll(`input[data-k="${k}"], input[data-ck="${k}"]`).forEach((i) => { i.value = ''; i.classList.remove('bad'); });
      br.custom = false; refresh(); setTimeout(() => { c.checked = false; }, 250);
    }));
    $('br-etc').querySelectorAll('input[data-etc]').forEach((c) => c.addEventListener('change', () => { c.checked ? br.etc.add(c.dataset.etc) : br.etc.delete(c.dataset.etc); br.custom = false; refresh(); }));
    $('br-etc').querySelectorAll('input[data-route]').forEach((c) => c.addEventListener('change', () => { c.checked ? br.routes.add(c.dataset.route) : br.routes.delete(c.dataset.route); br.custom = false; refresh(); }));
    $('br-etc-text').addEventListener('input', (e) => { br.etcText = e.target.value; br.custom = false; refresh(); });
    refresh(); save();
  };
  $('br-cats').addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (!b) return; br.ci = +b.dataset.c; drawTypes(); });
  $('br-types').addEventListener('click', (e) => { const b = e.target.closest('[data-t]'); if (!b) return; Object.assign(br, find(b.dataset.t)); build(); });
  $('br-unit').addEventListener('input', () => { br.custom = false; refresh(); save(); });
  $('br-region').addEventListener('input', () => { br.custom = false; refresh(); });
  $('br-fmt').addEventListener('change', () => {              // 좌표 형식을 바꾸면 이미 고른 장소의 좌표도 새 형식으로
    for (const [k, pl] of Object.entries(br.places)) { const inp = $('br-fields').querySelector(`input[data-k="${k}"]`); if (inp) { inp.value = composeLoc(pl, $('br-fmt').value); br.values[k] = inp.value; } }
    br.custom = false; refresh(); save();
  });
  $('br-out').addEventListener('input', () => { br.custom = true; });
  $('br-copy').addEventListener('click', async () => { await copyText($('br-out').value); logUsage({ time: new Date().toISOString(), from: '임무브리핑', to: br.kind, via: $('br-region').value.trim(), distanceKm: null, overall: '' }); $('br-msg').textContent = '복사했습니다 — 메신저에 붙여넣으세요'; setTimeout(() => { $('br-msg').textContent = ''; }, 3000); });
  $('br-reset').addEventListener('click', () => { $('br-region').value = ''; build(); });
  build();
}
