// 화면 로직: 입력 → 자료 수집(/api/*) → 판정(judge.js) → 표시. 카카오맵이 없으면 좌표 직접 입력으로 계속 동작.
import { distanceKm, sampleRouteMulti, isNightDuringRoute, routeLengthKm, KM_PER_NM } from './geo.js';
import { parseCoord, formatCoord, COORD_PLACEHOLDER } from './coords.js';
import { splitNotams, parseNotam } from './notam.js';
import { evaluate, GRADE_TEXT, dirText } from './judge.js';

const $ = (id) => document.getElementById(id);
const KINDS = ['metar', 'taf', 'asos', 'aws', 'warn', 'lightning'];
const KIND_TEXT = { metar: 'METAR', taf: 'TAF', asos: 'ASOS 지상관측', aws: 'AWS', warn: '기상특보', lightning: '낙뢰' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kstStr = (d, withDate = false) => {
  if (!d) return '-';
  const k = new Date(new Date(d).getTime() + 9 * 3600e3), p = (n) => String(n).padStart(2, '0');
  return (withDate ? `${k.getUTCMonth() + 1}/${k.getUTCDate()} ` : '') + `${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
};

const CODE_KEY = 'heliwx.code', HIST_KEY = 'heliwx.history', FMT_KEY = 'heliwx.coordfmt', NOTAM_KEY = 'heliwx.notams', COORD_ON_KEY = 'heliwx.coordOn', MAX_VIA = 5, MAX_SLOTS = 10;
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
  if (r.status === 401) { store.set(CODE_KEY, ''); showGate('접속코드가 올바르지 않습니다. 다시 입력하세요.'); throw new Error('접속코드 필요'); }
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
      if (r && r.status !== 401) { $('code-gate').hidden = true; $('code-input').value = ''; resolve(); }
      else { store.set(CODE_KEY, ''); $('code-msg').textContent = '접속코드가 올바르지 않습니다.'; }
    };
  });
}

const state = { config: null, kakao: null, map: null, geocoder: null, places: null, overlays: [], last: null, clickTarget: 'to', notamShared: false, slots: {}, slotCount: 4,
  points: [{ role: 'from', name: '', lat: null, lon: null, text: '', stayMin: 0 }, { role: 'to', name: '', lat: null, lon: null, text: '', stayMin: 0 }] };

// ---------- 시작 ----------
async function init() {
  const tick = () => { $('clock').textContent = 'KST ' + kstStr(new Date(), true); };
  tick(); setInterval(tick, 1000);
  const cc = await (await fetch('/api/client-config')).json();
  state.config = cc.config; state.serverLog = cc.serverLog;
  if (cc.needsCode) {
    const ok = store.get(CODE_KEY, '') && (await fetch('/api/warn', { headers: { 'X-Access-Code': store.get(CODE_KEY, '') } }).then((r) => r.status !== 401).catch(() => false));
    if (!ok) await askCode();
  }
  $('history-csv').addEventListener('click', downloadHistory);
  showHistoryCount();
  $('cruise').value = cc.config.cruiseKt;
  $('depart').value = kstInputNow();
  const fmt = store.get(FMT_KEY, 'dd'); $('coord-fmt').value = ['dd', 'ddm', 'dms'].includes(fmt) ? fmt : 'dd';
  $('coord-fmt').addEventListener('change', () => { store.set(FMT_KEY, $('coord-fmt').value); reformatAll(); });
  setCoordsOn(store.get(COORD_ON_KEY, false), false);
  $('coord-toggle').addEventListener('change', (e) => setCoordsOn(e.target.checked, true));
  $('add-via').addEventListener('click', addVia);
  $('notam-add').addEventListener('click', () => { if (state.slotCount < MAX_SLOTS) { state.slotCount++; renderSlots(); } });
  $('notam-reload').addEventListener('click', loadNotams);
  loadNotams();
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
        state.geocoder = new k.services.Geocoder();
        state.places = new k.services.Places();
        k.event.addListener(state.map, 'click', (e) => {
          const which = state.clickTarget;
          const ll = e.latLng;
          const p = { name: `지도 지점(${ll.getLat().toFixed(4)}, ${ll.getLng().toFixed(4)})`, lat: ll.getLat(), lon: ll.getLng() };
          state.geocoder.coord2Address(p.lon, p.lat, (res, st) => {
            if (st === k.services.Status.OK && res[0]) p.name = (res[0].road_address || res[0].address).address_name;
            setPointByKey(which, p);
          });
        });
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
const roleLabel = (key) => (key === 'from' ? '출발지' : key === 'to' ? '목적지(현장)' : `경유지 ${key.slice(3)}`);

function renderPoints() {
  const keys = pointKeys();
  if (!keys.includes(state.clickTarget)) state.clickTarget = 'to';
  $('points').innerHTML = state.points.map((p, i) => {
    const k = keys[i];
    const base = p.role === 'from' && (state.config.bases || []).length
      ? `<select id="pt-${k}-base" aria-label="출발 기지"><option value="">기지 선택</option>${state.config.bases.map((b, j) => `<option value="${j}">${esc(b.name)}</option>`).join('')}</select>` : '';
    const tools = p.role === 'via' ? `<div class="tools">체류 <input id="pt-${k}-stay" class="stay" type="number" min="0" max="600" step="5" value="${p.stayMin || 0}" aria-label="체류시간(분)">분
        <button type="button" data-act="up" data-i="${i}" aria-label="위로">▲</button><button type="button" data-act="down" data-i="${i}" aria-label="아래로">▼</button><button type="button" data-act="del" data-i="${i}">삭제</button></div>` : '';
    return `<fieldset class="place ${p.role}" data-i="${i}"><legend>${roleLabel(k)}</legend>${base}
      <div class="search"><input id="pt-${k}-q" type="search" placeholder="장소 검색" autocomplete="off"><ul class="results" id="pt-${k}-results"></ul></div>
      <div class="row"><input id="pt-${k}-name" placeholder="이름" value="${esc(p.name)}"></div>
      <div class="loc" id="pt-${k}-loc">${Number.isFinite(p.lat) ? `위치 ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}` : '위치 미지정 — 장소 검색 또는 지도 클릭'}</div>
      <div class="row coord-only"><input id="pt-${k}-coord" placeholder="${esc(COORD_PLACEHOLDER[fmtNow()])}" value="${esc(p.text)}" spellcheck="false" aria-label="${roleLabel(k)} 좌표"></div>
      <div class="coord-msg coord-only" id="pt-${k}-msg"></div>${tools}
      <label class="inline"><input type="radio" name="clickset" value="${k}" ${state.clickTarget === k ? 'checked' : ''}> 지도 클릭 → 이 지점</label></fieldset>`;
  }).join('');
  state.points.forEach((p, i) => wirePoint(p, keys[i]));
  $('add-via').disabled = state.points.filter((p) => p.role === 'via').length >= MAX_VIA;
  updateAuto(); drawRouteOnly();
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
    $(`pt-${k}-loc`).textContent = Number.isFinite(p.lat) ? `위치 ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}` : '위치 미지정 — 장소 검색 또는 지도 클릭';
    updateAuto(); drawRouteOnly();
  };
  coord.addEventListener('change', apply);
  coord.addEventListener('blur', apply);
  if (p.text) apply();
  $(`pt-${k}-name`).addEventListener('input', (e) => { p.name = e.target.value; });
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

function setupSearch(k) {
  const q = $(`pt-${k}-q`), list = $(`pt-${k}-results`);
  let t = null;
  q.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      list.innerHTML = '';
      if (!state.places || q.value.trim().length < 2) return;
      state.places.keywordSearch(q.value.trim(), (data, st) => {
        if (st !== state.kakao.services.Status.OK) return;
        list.innerHTML = data.slice(0, 8).map((d, i) => `<li tabindex="0" data-i="${i}">${esc(d.place_name)}<small>${esc(d.road_address_name || d.address_name)}</small></li>`).join('');
        list.querySelectorAll('li').forEach((li) => {
          const pick = () => { const d = data[+li.dataset.i]; setPointByKey(k, { name: d.place_name, lat: +d.y, lon: +d.x }); };
          li.addEventListener('click', pick);
          li.addEventListener('keydown', (e) => e.key === 'Enter' && pick());
        });
      });
    }, 250);
  });
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
  state.slotCount = Math.min(MAX_SLOTS, Math.max(4, ...Object.keys(state.slots).map(Number)));
  $('notam-mode').textContent = err ? `⚠ 공유 저장소 오류 — 이 브라우저 저장본 사용 (${err})`
    : shared ? '상황실 공유 저장 — 저장하면 모든 사용자에게 보입니다' : '공유 저장소 미연결 — 이 브라우저에만 저장됩니다';
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
    html.push(`<div class="nslot" data-n="${i}"><div class="nh"><span class="no">${CIRCLED[i - 1]}</span><span class="nt" id="notam-${i}-title"></span></div>
      <textarea id="notam-${i}" rows="3" spellcheck="false" placeholder="(D2840/26 NOTAMN …) 붙여넣기" aria-label="NOTAM ${i}번 칸"></textarea>
      <div class="nb"><span class="st" id="notam-${i}-status"></span>
        <button type="button" class="mini" id="notam-${i}-save">저장</button><button type="button" class="mini" id="notam-${i}-del">삭제</button></div></div>`);
  }
  $('notam-slots').innerHTML = html.join('');
  for (let i = 1; i <= state.slotCount; i++) {
    const ta = $(`notam-${i}`), s = state.slots[i] || { text: '', savedText: '', savedAt: null };
    ta.value = s.text || '';
    const refresh = () => {
      const cur = state.slots[i] || { text: '', savedText: '', savedAt: null };
      const sum = slotSummary(ta.value);
      const t = $(`notam-${i}-title`); t.textContent = sum.t; t.className = 'nt ' + sum.cls;
      const dirty = ta.value !== (cur.savedText || '');
      $(`notam-${i}-status`).textContent = dirty ? '저장 안 됨(수정 중)' : cur.savedAt ? `저장됨 ${kstStr(cur.savedAt, true)}` : '';
      ta.closest('.nslot').classList.toggle('dirty', dirty);
    };
    ta.addEventListener('input', () => { state.slots[i] = { ...(state.slots[i] || {}), text: ta.value }; refresh(); });
    $(`notam-${i}-save`).addEventListener('click', () => saveSlot(i, ta.value).then(refresh));
    $(`notam-${i}-del`).addEventListener('click', () => {
      if (!ta.value.trim() && !(state.slots[i] || {}).savedText) return;
      if (!confirm(`${CIRCLED[i - 1]}번 칸을 삭제할까요?${state.notamShared ? ' (모든 사용자에게서 삭제됩니다)' : ''}`)) return;
      deleteSlot(i).then(() => { ta.value = ''; refresh(); });
    });
    refresh();
  }
  $('notam-add').disabled = state.slotCount >= MAX_SLOTS;
}

async function saveSlot(i, text) {
  const st = $(`notam-${i}-status`);
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
    if (!r.ok) { $(`notam-${i}-status`).textContent = '삭제 실패'; throw new Error('delete'); }
  } else { const all = store.get(NOTAM_KEY, {}); delete all[i]; store.set(NOTAM_KEY, all); }
  delete state.slots[i];
}

const notamText = () => Array.from({ length: state.slotCount }, (_, k) => $(`notam-${k + 1}`)?.value || '').filter((t) => t.trim()).join('\n\n');

// 판단에 쓸 지점 목록(모두 좌표가 있어야 함)
function readyPoints() {
  const keys = pointKeys(), out = [], bad = [];
  state.points.forEach((p, i) => {
    if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) out.push({ name: p.name.trim() || roleLabel(keys[i]).replace('(현장)', ''), lat: p.lat, lon: p.lon, stayMin: p.role === 'via' ? p.stayMin : 0 });
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

// ---------- 실행 ----------
async function run() {
  const { pts, bad } = readyPoints();
  if (bad.length) { $('run-msg').textContent = `좌표가 없거나 형식이 틀린 지점: ${bad.join(', ')}`; return; }
  const from = pts[0], to = pts[pts.length - 1];
  $('run').disabled = true; $('run-msg').textContent = '기상자료 수집 중…';
  try {
    const [settled, rr] = await Promise.all([
      Promise.allSettled(KINDS.map((k) => api('/api/' + k).then((r) => r.json()))),
      routeRegions(pts).catch(() => ({ regions: [], seaPoints: 0, available: false })),
    ]);
    const data = {}, dataStatus = {}, warns = [];
    settled.forEach((s, i) => {
      const k = KINDS[i];
      if (s.status === 'rejected') { data[k] = []; dataStatus[k] = 'error'; warns.push(`${KIND_TEXT[k]} 수신 실패`); return; }
      data[k] = s.value.items || [];
      if (s.value.error && !data[k].length) { dataStatus[k] = 'error'; warns.push(`${KIND_TEXT[k]} 수신 실패`); }
      else if (s.value.stale) {
        warns.push(`${KIND_TEXT[k]} ${s.value.ageMin}분 전 자료 사용(재수신 실패)`);
        const lim = state.config.freshnessMin[k];
        if (lim && s.value.ageMin > lim) dataStatus[k] = 'stale';
      }
    });

    const { dep, arr } = flightTimes(pts);
    const dn = $('daynight').value, ls = $('landsea').value;
    const isNight = dn === 'auto' ? isNightDuringRoute(pts, dep, arr) : dn === 'night';
    const seaSuggest = rr.available && rr.seaPoints > 0;
    // 판별 불가 시 더 엄격한 해상 기준을 적용한다
    const isSea = ls === 'auto' ? (rr.available ? seaSuggest : true) : ls === 'sea';
    $('landsea-auto').textContent = rr.available ? `자동: ${seaSuggest ? '해상 구간 포함' : '육상'}` : '자동 판별 불가(지도 없음) → 해상 기준(엄격) 적용, 육상이면 직접 선택';
    if (!rr.available) warns.push('카카오맵 없음 — 특보구역 매칭·해상 자동판별 생략(특보 직접 확인)');

    const text = notamText();
    const result = evaluate({
      points: pts, departUtc: dep, cruiseKt: cruiseKt(), isNight, isSea, data, dataStatus,
      regionsAvailable: rr.available, seaRoute: seaSuggest || (isSea && !rr.available),
      notams: splitNotams(text).map(parseNotam), notamsProvided: text.trim().length > 0,
      routeRegions: rr.regions, now: new Date(), config: state.config,
    });
    state.last = { result, data, pts };
    render(result, { isNight, isSea, warns });
    drawMap(result, data, pts);
    $('run-msg').textContent = `판단 완료 ${kstStr(new Date())}`;
    const entry = { time: new Date().toISOString(), from: from.name, to: to.name, via: pts.slice(1, -1).map((p) => p.name).join(' / '), distanceKm: result.distanceKm, overall: result.overall };
    store.set(HIST_KEY, [entry, ...store.get(HIST_KEY, [])].slice(0, 5000));
    showHistoryCount();
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
  $('data-warn').innerHTML = ctx.warns.map(esc).join('<br>');
  $('sun').innerHTML = (r.sunNote ? `<div class="alert">☀ ${esc(r.sunNote)}</div>` : '')
    + r.sun.map((s) => `<div class="s"><b>${esc(s.segment)}</b><span>${esc(s.name)}</span><span>일출 ${esc(kstStr(s.sunrise))} · 일몰 ${esc(kstStr(s.sunset))}</span></div>`).join('');
  $('legs').innerHTML = r.legs.length > 1 || r.totalStayMin ? r.legs.map((l, i) => `<tr><td>${esc(l.from)} → ${esc(l.to)}</td><td>${l.distanceKm}km</td><td>${l.durationMin}분</td>
    <td>${esc(kstStr(l.departUtc))}${i > 0 && r.points[i].stayMin ? ` <small>(체류 ${r.points[i].stayMin}분)</small>` : ''}</td><td>${esc(kstStr(l.arriveUtc))}</td></tr>`).join('') : '';

  $('rows').innerHTML = r.rows.map((x) => `<tr class="${x.grade}">
    <td>${esc(x.segment)}</td><td>${esc(x.item)}</td><td>${esc(x.value)}</td><td>${esc(x.limit)}</td>
    <td><span class="badge ${x.grade}">${esc(GRADE_TEXT[x.grade])}</span>${x.note ? `<div class="note">${esc(x.note)}</div>` : ''}</td>
    <td class="note">${esc(x.source)}${x.obsTime ? ' · ' + esc(kstStr(x.obsTime)) : ''}</td></tr>`).join('');

  $('wind').innerHTML = r.wind.map((w) => `<div class="card"><small>${esc(w.segment)} · ${esc(w.name)}</small>
    <div class="v">${w.windMs === null ? '-' : `<span class="arrow" style="transform:rotate(${(w.windDir ?? 0) + 180}deg)">↑</span> ${esc(dirText(w.windDir))} ${esc(w.windMs)}m/s`}</div>
    <small>순간최대 ${w.gustMs ?? '-'}m/s${w.trend ? ' · 10분 추세 ' + esc(w.trend) : ''}${w.obsTime ? ' · ' + esc(kstStr(w.obsTime)) : ''}</small></div>`).join('');

  const inScope = r.notams.filter((n) => n.inScope).sort((a, b) => (a.distanceNm ?? 1e9) - (b.distanceNm ?? 1e9));
  const out = r.notams.length - inScope.length;
  const rel = (n) => (n.relation === 'CROSS' ? '경로 통과' : n.relation === 'NEAR' ? `경로 ${n.distanceNm.toFixed(1)}NM 근접` : n.relation === 'CLEAR' ? `경로에서 ${n.distanceNm.toFixed(1)}NM` : '위치 해석 불가');
  $('notam-list').innerHTML = (inScope.length ? inScope.map((n) => `<div class="n ${n.grade}">
      <b>${esc(n.id || '해석 불가')}</b> ${esc(n.qcodeText || '')} · ${esc(rel(n))}
      · ${n.activeDuringFlight === null ? '발효기간 해석 불가' : n.activeDuringFlight ? '<b>비행 시간대 발효</b>' : '비행 시간대 미발효'}
      <div>${esc(kstStr(n.start, true))} ~ ${n.endPerm ? 'PERM' : esc(kstStr(n.end, true))}${n.endEst ? ' (EST)' : ''} KST · ${esc(n.lower)}~${esc(n.upper)}
      ${n.geomSource === 'Q' ? ' · Q-line 기준(근사)' : ''}</div>
      ${n.needsPermission ? `<div class="perm">⚠ 소방헬기 사전허가 필요${n.phones.length ? ': ' + esc(n.phones.join(', ')) : ''}</div>` : ''}
      <details><summary>원문</summary><pre>${esc(n.raw)}</pre></details></div>`).join('')
    : `<p class="hint">${notamText().trim() ? '확인 대상(D 시리즈) NOTAM 없음' : 'NOTAM 미입력 — xNotam 조회 후 붙여넣기'}</p>`)
    + (out ? `<p class="hint">확인 대상 아님(D 시리즈 외) ${out}건</p>` : '');

  $('report-text').value = r.reportText;
}

function showHistoryCount() { $('history-count').textContent = `(이 브라우저 ${store.get(HIST_KEY, []).length}건)`; }
function downloadHistory() {
  const rows = store.get(HIST_KEY, []);
  const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const csv = ['시각(KST),출발,경유지,목적지,거리km,종합판정', ...rows.map((r) => [kstStr(r.time, true), r.from, r.via || '', r.to, r.distanceKm, GRADE_TEXT[r.overall] || r.overall].map(cell).join(','))].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `heli-wx-이력-${new Date().toISOString().slice(0, 10)}.csv`;
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

function drawMap(result, data, pts) {
  const k = state.kakao; if (!k || !state.map) return;
  clearOverlays();
  const ll = (p) => new k.LatLng(p.lat, p.lon);
  add(new k.Polyline({ path: pts.map(ll), strokeWeight: 4, strokeColor: '#0b4f8a', strokeOpacity: 0.9 }));
  pts.forEach((p, i) => add(new k.CustomOverlay({ position: ll(p), yAnchor: 1,
    content: `<div class="pin">${esc((i === 0 ? '출발 ' : i === pts.length - 1 ? '목적 ' : `경유${i} `) + p.name)}</div>` })));
  const b = new k.LatLngBounds(); pts.forEach((p) => b.extend(ll(p)));
  if (result && data) {
    const lim = result.limits, f = state.config.limits.cautionFactor;
    const g = (o) => (o.visM === null || o.visM === undefined ? 'NA' : o.visM < lim.visM || (o.ceilFt !== null && o.ceilFt < lim.ceilFt) ? 'RED' : o.visM < lim.visM * f || (o.ceilFt !== null && o.ceilFt < lim.ceilFt * f) ? 'YELLOW' : 'GREEN');
    const near = (o) => o && typeof o.lat === 'number' && pts.some((p) => distanceKm(o, p) < Math.max(60, routeLengthKm(pts) / 2 + 40));
    for (const o of [...data.metar, ...data.asos].filter(near)) {
      add(new k.CustomOverlay({ position: ll(o), content: `<div class="stn-dot ${g(o)}" title="${esc(o.name)} 시정 ${o.visM ?? '-'}m 운고 ${o.ceilFt ?? '-'}ft"></div>` }));
    }
    for (const n of result.notams.filter((n) => n.inScope && n.center)) {
      add(new k.Circle({ center: ll(n.center), radius: n.radiusNm * 1852, strokeWeight: 2, strokeColor: '#7a3fb0', strokeOpacity: 0.9, fillColor: '#7a3fb0', fillOpacity: 0.12 }));
      b.extend(ll(n.center));
    }
    for (const l of data.lightning.filter(near)) add(new k.CustomOverlay({ position: ll(l), content: '<div class="bolt" title="낙뢰">✕</div>' }));
  }
  state.map.setBounds(b, 60, 60, 60, 60);
}

init().catch((e) => { $('run-msg').textContent = '초기화 실패: ' + e.message; });
