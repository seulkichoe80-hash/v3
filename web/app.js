// 화면 로직: 입력 → 자료 수집(/api/*) → 판정(judge.js) → 표시. 카카오맵이 없으면 좌표 직접 입력으로 계속 동작.
import { distanceKm, sampleRoute, isNightDuring, KM_PER_NM } from './geo.js';
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

const state = { config: null, kakao: null, map: null, geocoder: null, places: null, from: null, to: null, overlays: [], last: null };

// ---------- 시작 ----------
async function init() {
  const tick = () => { $('clock').textContent = 'KST ' + kstStr(new Date(), true); };
  tick(); setInterval(tick, 1000);
  const cc = await (await fetch('/api/client-config')).json();
  state.config = cc.config;
  $('cruise').value = cc.config.cruiseKt;
  $('depart').value = kstInputNow();
  for (const [i, b] of (cc.config.bases || []).entries()) $('from-base').add(new Option(b.name, String(i)));
  $('from-base').addEventListener('change', (e) => {
    const b = state.config.bases[+e.target.value];
    if (b) setPlace('from', { name: b.name, lat: b.lat, lon: b.lon });
  });
  for (const id of ['depart', 'cruise']) $(id).addEventListener('change', updateAuto);
  for (const id of ['from-lat', 'from-lon', 'to-lat', 'to-lon']) $(id).addEventListener('change', updateAuto);
  $('run').addEventListener('click', run);
  $('copy').addEventListener('click', copyReport);
  setupSearch('from'); setupSearch('to');
  loadKakao(cc.kakaoJsKey);
}

function kstInputNow() {
  const k = new Date(Date.now() + 9 * 3600e3);
  return k.toISOString().slice(0, 16);
}
const departUtc = () => new Date(($('depart').value || kstInputNow()) + ':00+09:00');

// ---------- 카카오맵 ----------
function kakaoFailed(msg) {
  $('coord-fallback').hidden = false;
  $('coord-fallback-wrap').open = true;
  $('kakao-msg').textContent = msg;
  $('map-off').hidden = false;
  $('map-off').textContent = msg + ' — 좌표 직접 입력으로 판단은 계속 가능합니다.';
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
        $('coord-fallback').hidden = false;
        k.event.addListener(state.map, 'click', (e) => {
          const which = document.querySelector('input[name=clickset]:checked').value;
          const ll = e.latLng;
          const p = { name: `지도 지점(${ll.getLat().toFixed(4)}, ${ll.getLng().toFixed(4)})`, lat: ll.getLat(), lon: ll.getLng() };
          state.geocoder.coord2Address(p.lon, p.lat, (res, st) => {
            if (st === k.services.Status.OK && res[0]) p.name = (res[0].road_address || res[0].address).address_name;
            setPlace(which, p);
          });
        });
      });
    } catch (e) { clearTimeout(timer); kakaoFailed('카카오맵 초기화 실패: ' + e.message); }
  };
  document.head.appendChild(s);
}

function setupSearch(which) {
  const q = $(`${which}-q`), list = $(`${which}-results`);
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
          const pick = () => { const d = data[+li.dataset.i]; setPlace(which, { name: d.place_name, lat: +d.y, lon: +d.x }); list.innerHTML = ''; q.value = ''; };
          li.addEventListener('click', pick);
          li.addEventListener('keydown', (e) => e.key === 'Enter' && pick());
        });
      });
    }, 250);
  });
}

function setPlace(which, p) {
  state[which] = p;
  const c = $(`${which}-chosen`);
  c.textContent = `${p.name} (${p.lat.toFixed(4)}, ${p.lon.toFixed(4)})`;
  c.classList.add('set');
  $(`${which}-name`).value = p.name; $(`${which}-lat`).value = p.lat.toFixed(5); $(`${which}-lon`).value = p.lon.toFixed(5);
  updateAuto();
  drawRouteOnly();
}

function readPlace(which) {
  const lat = parseFloat($(`${which}-lat`).value), lon = parseFloat($(`${which}-lon`).value);
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    return { name: $(`${which}-name`).value.trim() || (which === 'from' ? '출발지' : '목적지'), lat, lon };
  }
  return state[which];
}

function flightTimes(from, to) {
  const dep = departUtc();
  const min = (distanceKm(from, to) / (Number($('cruise').value || state.config.cruiseKt) * KM_PER_NM)) * 60;
  return { dep, arr: new Date(dep.getTime() + min * 60e3) };
}

function updateAuto() {
  const from = readPlace('from'), to = readPlace('to');
  if (!from || !to) return;
  const { dep, arr } = flightTimes(from, to);
  $('daynight-auto').textContent = '자동: ' + (isNightDuring(from, to, dep, arr) ? '야간' : '주간');
}

// ---------- 경로 행정구역(특보 매칭·해상 판별) ----------
function routeRegions(from, to) {
  if (!state.geocoder) return Promise.resolve({ regions: [], seaPoints: 0, available: false });
  const pts = sampleRoute(from, to, 10);
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
  const from = readPlace('from'), to = readPlace('to');
  if (!from || !to) { $('run-msg').textContent = '출발지와 목적지를 지정하세요.'; return; }
  $('run').disabled = true; $('run-msg').textContent = '기상자료 수집 중…';
  try {
    const [settled, rr] = await Promise.all([
      Promise.allSettled(KINDS.map((k) => fetch('/api/' + k).then((r) => r.json()))),
      routeRegions(from, to).catch(() => ({ regions: [], seaPoints: 0, available: false })),
    ]);
    const data = {}, dataStatus = {}, warns = [];
    settled.forEach((s, i) => {
      const k = KINDS[i];
      if (s.status === 'rejected') { data[k] = []; dataStatus[k] = 'error'; warns.push(`${KIND_TEXT[k]} 수신 실패`); return; }
      data[k] = s.value.items || [];
      if (s.value.error && !data[k].length) { dataStatus[k] = 'error'; warns.push(`${KIND_TEXT[k]} 수신 실패`); }
      else if (s.value.stale) warns.push(`${KIND_TEXT[k]} ${s.value.ageMin}분 전 자료 사용(재수신 실패)`);
    });

    const { dep, arr } = flightTimes(from, to);
    const dn = $('daynight').value, ls = $('landsea').value;
    const isNight = dn === 'auto' ? isNightDuring(from, to, dep, arr) : dn === 'night';
    const seaSuggest = rr.available && rr.seaPoints > 0;
    const isSea = ls === 'auto' ? seaSuggest : ls === 'sea';
    $('landsea-auto').textContent = rr.available ? `자동: ${seaSuggest ? '해상 구간 포함' : '육상'}` : '자동 판별 불가(지도 없음) → 육상';
    if (!rr.available) warns.push('카카오맵 없음 — 특보구역 매칭·해상 자동판별 생략(특보 직접 확인)');

    const text = $('notam-text').value;
    const result = evaluate({
      from, to, departUtc: dep, cruiseKt: Number($('cruise').value || state.config.cruiseKt), isNight, isSea, data, dataStatus,
      notams: splitNotams(text).map(parseNotam), notamsProvided: text.trim().length > 0,
      routeRegions: rr.regions, now: new Date(), config: state.config,
    });
    state.last = { result, data, from, to };
    render(result, { from, to, isNight, isSea, warns });
    drawMap(result, data, from, to);
    $('run-msg').textContent = `판단 완료 ${kstStr(new Date())}`;
    fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: from.name, to: to.name, overall: result.overall, distanceKm: result.distanceKm }) }).catch(() => {});
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
    ['거리', `${r.distanceKm}km / ${r.distanceNm}NM`], ['소요', `${r.durationMin}분`], ['도착 예정', kstStr(r.arriveUtc)],
    ['적용 기준', `${ctx.isNight ? '야간' : '주간'}·${ctx.isSea ? '해상' : '육상'} ${r.limits.visM}m/${r.limits.ceilFt}ft`],
  ].map(([k, v]) => `<div>${esc(k)}<b>${esc(v)}</b></div>`).join('');
  $('data-warn').innerHTML = ctx.warns.map(esc).join('<br>');

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
    : `<p class="hint">${$('notam-text').value.trim() ? '확인 대상(D 시리즈) NOTAM 없음' : 'NOTAM 미입력 — xNotam 조회 후 붙여넣기'}</p>`)
    + (out ? `<p class="hint">확인 대상 아님(D 시리즈 외) ${out}건</p>` : '');

  $('report-text').value = r.reportText;
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
function drawRouteOnly() { if (state.map && state.from && state.to) drawMap(null, null, state.from, state.to); }

function drawMap(result, data, from, to) {
  const k = state.kakao; if (!k || !state.map) return;
  clearOverlays();
  const ll = (p) => new k.LatLng(p.lat, p.lon);
  add(new k.Polyline({ path: [ll(from), ll(to)], strokeWeight: 4, strokeColor: '#0b4f8a', strokeOpacity: 0.9 }));
  for (const [p, label] of [[from, '출발 ' + from.name], [to, '목적 ' + to.name]]) add(new k.CustomOverlay({ position: ll(p), content: `<div class="pin">${esc(label)}</div>`, yAnchor: 1 }));
  const b = new k.LatLngBounds(); b.extend(ll(from)); b.extend(ll(to));
  if (result && data) {
    const lim = result.limits, f = state.config.limits.cautionFactor;
    const g = (o) => (o.visM === null || o.visM === undefined ? 'NA' : o.visM < lim.visM || (o.ceilFt !== null && o.ceilFt < lim.ceilFt) ? 'RED' : o.visM < lim.visM * f || (o.ceilFt !== null && o.ceilFt < lim.ceilFt * f) ? 'YELLOW' : 'GREEN');
    const near = (o) => o && typeof o.lat === 'number' && distanceKm(o, from) + distanceKm(o, to) < distanceKm(from, to) + 80;
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
