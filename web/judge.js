// 119항공대 운영 규정 제21조 기준 판정 엔진 (순수 함수). 시스템은 조언만 하며 최종 판단은 통제관·기장.
import { distanceKm, pointToRouteKm, sunTimesLocal, routeIntersectsPolygon, routeDistanceToPolygonKm, KM_PER_NM } from './geo.js';
import { assessNotamRoute } from './notam.js';
import { msToKt } from './rules.js';

export const PROVISO = '제21조① 단서 — 긴급운항 시 즉시 통제관 보고, 기종별 교범 운용한계 내에서 조종사 의견 청취 후 통제관 판단';
const RANK = { RED: 3, YELLOW: 2, NA: 1, GREEN: 0 };
const CRITICAL_WARN = ['태풍', '강풍', '풍랑', '대설', '호우'];
export const GRADE_TEXT = { RED: '규정상 비행제한', YELLOW: '주의', GREEN: '규정상 운항 가능', NA: '자료없음·직접 확인' };

export function limitsFor(config, isNight, isSea) {
  const l = config.limits[isNight ? 'night' : 'day'][isSea ? 'sea' : 'land'];
  return { visM: l.visM, ceilFt: l.ceilFt };
}

export function gradeValue(value, limit, factor = 1.5) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'NA';
  if (value < limit) return 'RED';
  if (value < limit * factor) return 'YELLOW';
  return 'GREEN';
}

export function worst(grades) {
  if (!grades.length) return 'NA';
  return grades.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
}

const ageMin = (obsTime, now) => (obsTime ? (now - new Date(obsTime)) / 60e3 : Infinity);
const has = (o) => o && typeof o.lat === 'number' && typeof o.lon === 'number';
const fmtKst = (d) => {
  const k = new Date(d.getTime() + 9 * 3600e3);
  return `${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`;
};
const DIR16 = ['북', '북북동', '북동', '동북동', '동', '동남동', '남동', '남남동', '남', '남남서', '남서', '서남서', '서', '서북서', '북서', '북북서'];
export const dirText = (d) => (d === null || d === undefined ? '-' : DIR16[Math.round(d / 22.5) % 16]);

function nearest(items, p, maxKm) {
  let best = null, bd = Infinity;
  for (const it of items) {
    if (!has(it)) continue;
    const d = distanceKm(p, it);
    if (d <= maxKm && d < bd) { best = it; bd = d; }
  }
  return best;
}
const alongRoute = (items, route, maxKm) => items.filter((it) => has(it) && pointToRouteKm(it, route) <= maxKm);

// 관측 하나가 '운고 정보'를 가지고 있는지(구름 적음 = 운고 없음과 결측을 구분)
const hasCeilInfo = (o) => (o.ceilUnknown ? false : o.icao ? o.visM !== null && o.visM !== undefined : (o.cloudTenths !== null && o.cloudTenths !== undefined) || (o.midTenths !== null && o.midTenths !== undefined));
const srcName = (o) => (o.icao ? `METAR ${o.name}(${o.icao})` : `ASOS ${o.name}(${o.stn})`);

function obsRows(segment, obs, limits, input) {
  const { config, now } = input;
  const f = config.limits.cautionFactor;
  const mk = (item, extra) => ({ segment, item, value: '-', limit: item === '시정' ? `${limits.visM}m` : `${limits.ceilFt}ft`, source: '-', obsTime: null, ...extra });
  if (!obs.length) {
    return ['시정', '운고'].map((it) => mk(it, { grade: 'NA', note: '주변 관측소 없음 — 직접 확인' }));
  }
  const fresh = obs.filter((o) => ageMin(o.obsTime, now) <= config.freshnessMin[o.icao ? 'metar' : 'asos']);
  if (!fresh.length) {
    return ['시정', '운고'].map((it) => mk(it, { grade: 'NA', note: '자료 오래됨 — 직접 확인', source: srcName(obs[0]), obsTime: obs[0].obsTime }));
  }
  const rows = [];
  const vis = fresh.filter((o) => o.visM !== null && o.visM !== undefined);
  if (!vis.length) rows.push(mk('시정', { grade: 'NA', note: '시정 결측 — 직접 확인', source: srcName(fresh[0]) }));
  else {
    const w = vis.reduce((a, b) => (b.visM < a.visM ? b : a));
    rows.push(mk('시정', { value: `${w.visM}m`, grade: gradeValue(w.visM, limits.visM, f), source: srcName(w), obsTime: w.obsTime, note: '' }));
  }
  const ci = fresh.filter(hasCeilInfo);
  const withCeil = ci.filter((o) => o.ceilFt !== null && o.ceilFt !== undefined);
  if (!ci.length) rows.push(mk('운고', { grade: 'NA', note: '운고 결측 — 직접 확인', source: srcName(fresh[0]) }));
  else if (!withCeil.length) rows.push(mk('운고', { value: '운고 없음(구름 적음)', grade: 'GREEN', source: srcName(ci[0]), obsTime: ci[0].obsTime, note: '' }));
  else {
    const w = withCeil.reduce((a, b) => (b.ceilFt < a.ceilFt ? b : a));
    // ASOS는 전운량·중하층운량을 함께 보여 줘서 운고 산정 근거(상층운 포함 여부)를 확인할 수 있게 한다
    const has = (v) => v !== null && v !== undefined;
    const cloudNote = w.stn !== undefined && (has(w.cloudTenths) || has(w.midTenths))
      ? `ASOS ${has(w.cloudTenths) ? `전운량 ${w.cloudTenths}/10` : ''}${has(w.cloudTenths) && has(w.midTenths) ? ' · ' : ''}${has(w.midTenths) ? `중하층 ${w.midTenths}/10` : ''}` : '';
    rows.push(mk('운고', { value: `${w.ceilFt}ft`, grade: gradeValue(w.ceilFt, limits.ceilFt, f), source: srcName(w), obsTime: w.obsTime, note: cloudNote }));
  }
  return rows;
}

function tafRows(tafs, limits, departUtc, arriveUtc) {
  const t0 = departUtc.getTime(), t1 = arriveUtc.getTime() + 30 * 60e3;
  if (!tafs.length) return [{ segment: '경로', item: 'TAF', value: '-', limit: `${limits.visM}m / ${limits.ceilFt}ft`, grade: 'NA', source: '-', obsTime: null, note: '경로 주변 TAF 공항 없음 — 예보 직접 확인' }];
  return tafs.map((t) => {
    let grade = 'GREEN', note = '비행 시간대 예보 기준 충족', value = '-', covered = false;
    for (const g of t.groups || []) {
      if (new Date(g.to).getTime() <= t0 || new Date(g.from).getTime() >= t1) continue;
      if (g.type === 'BASE' || g.type === 'FM' || g.type === 'BECMG') covered = true;
      const below = (g.visM !== null && g.visM !== undefined && g.visM < limits.visM) || (g.ceilFt !== null && g.ceilFt !== undefined && g.ceilFt < limits.ceilFt);
      if (!below) continue;
      const gg = g.type === 'TEMPO' || g.type === 'PROB' ? 'YELLOW' : 'RED';
      if (RANK[gg] > RANK[grade]) {
        grade = gg;
        value = `${g.type} ${g.visM ?? '-'}m / ${g.ceilFt ?? '-'}ft`;
        note = gg === 'RED' ? '비행 시간대 기준 미달 예보(제21조①3)' : '일시적 악화 예보(TEMPO/PROB) — 악화 우려 주의';
      }
    }
    if (!covered && grade === 'GREEN') { grade = 'NA'; note = '비행 시간대 예보 없음 — 예보 직접 확인'; }
    return { segment: '경로', item: 'TAF', value, limit: `${limits.visM}m / ${limits.ceilFt}ft`, grade, source: `TAF ${t.name}(${t.icao})`, obsTime: t.issued || null, note };
  });
}

const sidoKey = (s) => String(s || '').replace(/(특별자치도|특별자치시|특별시|광역시|도)$/, '');
const sggKey = (s) => String(s || '').split(' ')[0].replace(/(시|군|구)$/, '');

function warnRows(warns, regions, status, regionsAvailable, seaRoute) {
  if (status === 'error') return [{ segment: '경로', item: '기상특보', value: '-', limit: '발효 없음', grade: 'NA', source: '기상청 특보', obsTime: null, note: '특보 자료 수신 실패 — 직접 확인' }];
  const active = warns.filter((w) => !/해제/.test(w.cmd || ''));
  // 등급 표기는 "예비 / 주의(보) / 경보". '예비'는 위험 특보가 아니다.
  const isCritical = (w) => CRITICAL_WARN.includes(w.kind) && /주의|경보/.test(w.level || '');
  const isSeaZone = (w) => /바다|해상|연안/.test(`${w.regName || ''}${w.regUpName || ''}`);
  if (!regionsAvailable) {
    const crit = active.filter(isCritical);
    if (!crit.length) return [{ segment: '경로', item: '기상특보', value: '전국 주요 특보 없음', limit: '발효 없음', grade: 'GREEN', source: '기상청 특보', obsTime: null, note: '' }];
    return [{ segment: '경로', item: '기상특보', value: `전국 주요 특보 ${crit.length}건`, limit: '발효 없음', grade: 'YELLOW', source: '기상청 특보', obsTime: null,
      note: '특보구역 매칭 불가(지도 없음) — 경로 해당 여부 직접 확인: ' + crit.slice(0, 5).map((w) => `${w.regName} ${w.kind}${w.level}`).join(', ') }];
  }
  const rows = [];
  for (const w of active) {
    const critical = isCritical(w);
    const sea = isSeaZone(w);
    // 바다 구역 이름에는 시군구 이름이 글자로 섞여 들어갈 수 있다(예: '중부안쪽먼바다' ⊃ '부안'). 육지 구역일 때만 시군구와 맞춘다.
    const exact = !sea && regions.some((r) => { const k = sggKey(r.sigungu); return k.length >= 2 && String(w.regName || '').includes(k); });
    const sido = !sea && regions.some((r) => sidoKey(r.sido) && sidoKey(r.sido) === sidoKey(w.regUpName));
    const seaZone = seaRoute && critical && sea;
    let grade = null, note = '';
    if (exact) { grade = critical ? 'RED' : 'YELLOW'; note = critical ? '경로·목적지 특보구역 발효(제21조①4)' : '참고 특보 발효'; }
    else if (sido && critical) { grade = 'YELLOW'; note = '같은 시·도 특보 — 특보구역 확인 필요'; }
    else if (seaZone) { grade = 'YELLOW'; note = '해상 구간 — 해상 특보구역 확인 필요'; }
    if (grade) rows.push({ segment: '경로', item: '기상특보', value: `${w.regName} ${w.kind}${w.level}`, limit: '발효 없음', grade, source: '기상청 특보', obsTime: w.tmEf || null, note });
  }
  if (!rows.length) rows.push({ segment: '경로', item: '기상특보', value: '해당 없음', limit: '발효 없음', grade: 'GREEN', source: '기상청 특보', obsTime: null, note: '' });
  return rows;
}

// 비행금지·제한구역(AIP): 경로가 구역을 지나거나 가까우면 "주의 + 허가 필요" 안내. areas가 없으면 판정하지 않는다.
export function airspaceRows(areas, route, nearNm = 3) {
  if (!areas || !areas.length) return [];
  const hits = [];
  for (const a of areas) {
    const d = routeDistanceToPolygonKm(route, a.poly);
    if (d === 0) hits.push({ a, rel: 'CROSS', d });
    else if (d / KM_PER_NM <= nearNm) hits.push({ a, rel: 'NEAR', d });
  }
  if (!hits.length) return [{ segment: '경로', item: '비행금지·제한구역', value: `해당 없음 (${areas.map((a) => a.short).join('·')})`, limit: '진입 불가·허가 필요', grade: 'GREEN', source: 'AIP ENR 5.1', obsTime: null, note: '' }];
  return hits.map(({ a, rel, d }) => ({
    segment: '경로', item: `${a.kind === 'P' ? '비행금지구역' : '비행제한구역'} ${a.short}`,
    value: `${a.name} ${rel === 'CROSS' ? '경로 통과' : `경로 ${(d / KM_PER_NM).toFixed(1)}NM 근접`}`, limit: a.kind === 'P' ? '허가 없이 진입 불가' : '비행계획 통보·승인 필요', grade: 'YELLOW', source: 'AIP ENR 5.1', obsTime: null,
    note: `${a.kind === 'P' ? '허가 없이 진입할 수 없으니 우회하거나' : '관할기관 승인을 확인하고'} ${a.authority}에 협조 필요(${a.lower}~${a.upper})${a.approx ? ' · ' + a.approx : ''}`,
  }));
}

function lightningRow(items, route, input) {
  const { config, now, dataStatus = {} } = input;
  const base = { segment: '경로', item: '낙뢰', limit: `${config.radius.lightningKm}km 이내 없음`, source: '기상청 낙뢰', obsTime: null };
  if (dataStatus.lightning === 'stale') return { ...base, value: '-', grade: 'NA', note: '낙뢰 자료 오래됨 — 레이더 직접 확인' };
  if (dataStatus.lightning === 'error') return { ...base, value: '-', grade: 'NA', note: '낙뢰 자료 수신 실패 — 레이더 직접 확인' };
  const near = items.filter((l) => ageMin(l.time, now) <= config.freshnessMin.lightning && has(l))
    .map((l) => pointToRouteKm(l, route)).filter((d) => d <= config.radius.lightningKm);
  if (!near.length) return { ...base, value: '없음', grade: 'GREEN', note: '' };
  return { ...base, value: `${near.length}회 (최근접 ${Math.min(...near).toFixed(1)}km)`, grade: 'YELLOW', note: '뇌우 가능 — 경로 변경 검토(제21조②)' };
}

export const SIGWX_TEXT = { ICE: '착빙', TURB: '난류', MTN: '산악차폐', VIS: '저시정', TS: '뇌우·적란운', CLD: '낮은 구름', WIND: '지상풍 구역', FZL: '0℃ 고도선', ETC: '기타 위험기상' };

function sigwxRow(items, route, input) {
  const base = { segment: '경로', item: '저고도 중요기상', limit: '경로 위험구역 없음', source: '기상청 저고도 SIGWX', obsTime: null };
  const st = (input.dataStatus || {}).sigwx;
  if (st === 'error' || st === 'stale') return { ...base, value: '-', grade: 'NA', note: '저고도 SIGWX 수신 실패 — 항공기상청 직접 확인' };
  if (!items || !items.length) return { ...base, value: '-', grade: 'NA', note: '저고도 SIGWX 해석 불가 또는 자료 없음 — 원문 확인' };
  const issued = items.map((x) => x.issued).filter(Boolean).sort().pop() || null;
  const fzls = [...new Set(items.filter((x) => x.kind === 'FZL' && x.fzlFt).map((x) => x.fzlFt))].sort((p, q) => p - q);
  const fzlText = fzls.length ? ` · 0℃ 고도선 ${fzls.map((v) => v + 'ft').join('·')}` : '';
  // 위험구역 = 닫힌 도형(구역). 선·아이콘(전선, 0℃선, 기호)은 구역이 아니고, 헬기가 비행하지 않는 중·고층(mid, high) 구역은 제외한다.
  const isHazard = (x) => x.kind !== 'FZL' && x.closed !== false && (!x.layer || x.layer === 'low');
  const hazards = items.filter(isHazard);
  const checkable = hazards.filter((x) => (x.points || []).length >= 3);
  const unlocated = hazards.filter((x) => (x.points || []).length < 3);
  const hits = checkable.filter((x) => routeIntersectsPolygon(route, x.points));
  const kinds = (list) => { const c = {}; list.forEach((x) => { const t = SIGWX_TEXT[x.kind] || x.kind; c[t] = (c[t] || 0) + 1; }); return Object.entries(c).map(([k, v]) => `${k} ${v}`).join('·'); };
  if (hits.length) {
    const names = [...new Set(hits.map((x) => SIGWX_TEXT[x.kind] || x.kind))];
    const alts = [...new Set(hits.map((x) => x.alt && x.alt.text).filter(Boolean))];
    const altNote = alts.length ? ` (구역 고도 ${alts.join(', ')} — 비행고도가 이보다 낮으면 해당 없음)` : '';
    const lead = hits.some((x) => x.kind === 'ICE') ? '착빙 예상 구역 — 회피 검토(제21조④)' : hits.some((x) => x.kind === 'TURB') ? '난류 예상 구역 — 조종사 판단(제21조⑥)' : '저고도 위험기상 구역 — 경로 검토';
    return { ...base, value: `경로 통과: ${names.join('·')}${fzlText}`, grade: 'YELLOW', obsTime: issued, note: lead + altNote };
  }
  if (unlocated.length) {
    return { ...base, value: `발표 ${hazards.length}건(${kinds(hazards)})${fzlText}`, grade: 'NA', obsTime: issued,
      note: '위치를 경도·위도로 해석할 수 없어 경로 교차는 판정하지 않음 — 항공기상청 저고도 SIGWX 차트 직접 확인' };
  }
  if (!hazards.length) return { ...base, value: `위험구역 발표 없음${fzlText}`, grade: 'GREEN', obsTime: issued, note: '' };
  return { ...base, value: `경로 해당 없음 (${hazards.length}개 구역)${fzlText}`, grade: 'GREEN', obsTime: issued, note: '' };
}

function windInfo(segment, p, aws, metars, now, config) {
  const fresh = aws.filter((x) => ageMin(x.obsTime, now) <= config.freshnessMin.aws);
  const a = nearest(fresh, p, 30);
  if (a) {
    const d = a.windMs10ago === null || a.windMs10ago === undefined || a.windMs === null ? null : a.windMs - a.windMs10ago;
    return { segment, stn: a.stn, name: `AWS ${a.name}`, windDir: a.windDir, windMs: a.windMs, gustMs: a.gustMs, windKt: msToKt(a.windMs), gustKt: msToKt(a.gustMs),
      trend: d === null ? null : d >= 2 ? '증가' : d <= -2 ? '감소' : '유지', obsTime: a.obsTime };
  }
  const m = nearest(metars.filter((x) => ageMin(x.obsTime, now) <= config.freshnessMin.metar), p, config.radius.metarNm * KM_PER_NM);
  if (m) {
    const kt2ms = (k) => (k === null || k === undefined ? null : Math.round(k * 0.5144 * 10) / 10);
    return { segment, stn: m.icao, name: `METAR ${m.name}`, windDir: m.windDir, windMs: kt2ms(m.windKt), gustMs: kt2ms(m.gustKt), windKt: m.windKt ?? null, gustKt: m.gustKt ?? null, trend: null, obsTime: m.obsTime };
  }
  return { segment, stn: null, name: '주변 관측 없음', windDir: null, windMs: null, gustMs: null, windKt: null, gustKt: null, trend: null, obsTime: null };
}

export function evaluate(input) {
  const { departUtc, isNight, isSea, data, config, notams = [], notamsProvided = notams.length > 0, routeRegions = [], regionsAvailable = routeRegions.length > 0, seaRoute = false, dataStatus = {}, now } = input;
  const cruiseKt = Number.isFinite(input.cruiseKt) && input.cruiseKt >= 40 && input.cruiseKt <= 250 ? input.cruiseKt : config.cruiseKt;
  // 지점: points(출발·경유…·목적) 우선, 없으면 from/to
  const pts = (input.points && input.points.length >= 2 ? input.points : [input.from, input.to]).map((p) => ({ ...p, stayMin: Math.max(0, Number(p.stayMin) || 0) }));
  const segName = (i) => (i === 0 ? '출발지' : i === pts.length - 1 ? '목적지' : `경유지${i}`);
  const legs = [];
  let t = departUtc.getTime(), distKm = 0, totalStayMin = 0;
  for (let i = 1; i < pts.length; i++) {
    if (i > 1) { t += pts[i - 1].stayMin * 60e3; totalStayMin += pts[i - 1].stayMin; }
    const d = distanceKm(pts[i - 1], pts[i]);
    const m = d === 0 ? 0 : (d / (cruiseKt * KM_PER_NM)) * 60;
    legs.push({ from: pts[i - 1].name, to: pts[i].name, distanceKm: Math.round(d * 10) / 10, durationMin: Math.round(m), departUtc: new Date(t), arriveUtc: new Date(t + m * 60e3) });
    t += m * 60e3; distKm += d;
  }
  const arriveUtc = new Date(t);
  const durationMin = (t - departUtc.getTime()) / 60e3;
  const limits = limitsFor(config, isNight, isSea);
  const metarKm = config.radius.metarNm * KM_PER_NM, asosKm = config.radius.asosKm;
  const metars = data.metar || [], asoss = data.asos || [];

  const pick = (p) => [nearest(metars, p, metarKm), nearest(asoss, p, asosKm)].filter(Boolean);
  const routeObs = [...alongRoute(metars, pts, metarKm), ...alongRoute(asoss, pts, asosKm)];
  const pointRows = (i) => obsRows(segName(i), pick(pts[i]), limits, input);
  const rows = [
    ...pointRows(0),
    ...obsRows('경로', routeObs, limits, input),
    ...pts.slice(1, -1).flatMap((_, k) => pointRows(k + 1)),
    ...pointRows(pts.length - 1),
    ...tafRows(alongRoute(data.taf || [], pts, metarKm), limits, departUtc, arriveUtc),
    ...warnRows(data.warn || [], routeRegions, dataStatus.warn, regionsAvailable, seaRoute),
    lightningRow(data.lightning || [], pts, input),
    sigwxRow(data.sigwx, pts, input),
    ...airspaceRows(input.airspaceAreas, pts, (config.radius || {}).airspaceNearNm ?? 3).map((x) => ({ ...x, ops: true })),   // ops = 기상 기준 밖(공역·NOTAM): 판정에 넣지 않고 '주의'로 따로 안내
  ];

  const assessed = notams.map((n) => assessNotamRoute(n, pts, departUtc, arriveUtc, config.radius.notamNearNm));
  const relevant = assessed.filter((n) => n.inScope && n.grade !== 'GREEN');
  if (!notamsProvided) rows.push({ ops: true, segment: '경로', item: 'NOTAM', value: '미입력', limit: '경로 관련 없음', grade: 'NA', source: 'xNotam', obsTime: null, note: 'xNotam 조회 후 붙여넣기' });
  else if (!relevant.length) rows.push({ ops: true, segment: '경로', item: 'NOTAM', value: `경로 관련 D NOTAM 없음 (입력 ${assessed.length}건)`, limit: '경로 관련 없음', grade: 'GREEN', source: 'xNotam', obsTime: null, note: '' });
  for (const n of relevant) {
    const rel = n.relation === 'CROSS' ? (n.prohibited ? '비행금지구역 통과' : '경로 통과') : n.relation === 'BUFFER' ? '완충구역 통과' : n.relation === 'NEAR' ? `경로 ${n.distanceNm.toFixed(1)}NM 근접` : '위치 해석 불가';
    const tel = n.phones.length ? ' ' + n.phones.join(', ') : '';
    const note = n.parseError ? n.parseError + ' — 원문 확인'
      : n.relation === 'CROSS' && n.prohibited ? `비행금지구역 내부 — 진입 불가(원문 예외 확인)${n.needsPermission ? ' · 사전조율·승인' + tel : ''}`
      : n.relation === 'BUFFER' ? `완충구역(금지구역 바깥 ${n.buffer.widthNm}NM) 통과 — 사전조율·승인 필요${tel}`
      : n.needsPermission ? `소방헬기 사전허가 필요${tel}` : '';
    rows.push({ ops: true, segment: '경로', item: 'NOTAM', value: `${n.id || '해석 불가'} ${n.qcodeText || ''} ${rel}`.trim(), limit: '경로 관련 없음', grade: n.grade, source: 'xNotam', obsTime: null, note });
  }

  const wind = pts.map((p, i) => windInfo(segName(i), p, data.aws || [], metars, now, config));

  // 일출·일몰: 각 지점을 지나는 시각(출발지=출발, 나머지=도착) 기준
  const sun = pts.map((p, i) => {
    const at = i === 0 ? departUtc : legs[i - 1].arriveUtc;
    const { sunrise, sunset } = sunTimesLocal(p, at);
    return { segment: segName(i), name: p.name, at, sunrise, sunset };
  });
  // 가장 급한 지점: 야간(일몰 후·일출 전)이 있으면 그것, 없으면 일몰까지 가장 적게 남은 곳(60분 이내만)
  let sunNote = '';
  const when = (s) => (s.segment === '출발지' ? '출발 시' : `${s.segment} 도착 시`);
  const night = sun.find((s) => s.at >= s.sunset || s.at < s.sunrise);
  if (night) {
    sunNote = night.at >= night.sunset ? `${when(night)} 일몰 후 ${Math.round((night.at - night.sunset) / 60e3)}분(야간)`
      : `${when(night)} 일출 ${Math.round((night.sunrise - night.at) / 60e3)}분 전(야간)`;
  } else {
    const soon = sun.map((s) => ({ s, m: (s.sunset - s.at) / 60e3 })).filter((x) => x.m <= 60).sort((x, y) => x.m - y.m)[0];
    if (soon) sunNote = `${when(soon.s)} 일몰 ${Math.round(soon.m)}분 전`;
  }

  // 종합 판정은 기상 기준(시정·운고·TAF·특보·낙뢰·저고도 중요기상)만으로 낸다. 공역·NOTAM은 '주의'로 따로 모은다.
  const wrows = rows.filter((r) => !r.ops), orows = rows.filter((r) => r.ops);
  const grades = wrows.map((r) => r.grade);
  const hasNA = rows.some((r) => r.grade === 'NA');
  const wNA = grades.includes('NA');
  const coreNA = wrows.some((r) => r.segment !== '경로' && (r.item === '시정' || r.item === '운고') && r.grade === 'NA');
  let overall = grades.includes('RED') ? 'RED' : grades.includes('YELLOW') ? 'YELLOW' : coreNA ? 'NA' : 'GREEN';
  let overallNote = '';
  if (overall === 'RED') overallNote = PROVISO;
  else if (overall === 'NA') overallNote = '핵심 기상자료 없음 — 직접 확인';
  else if (overall === 'GREEN' && wNA) overallNote = '단, 일부 자료 확인 필요';
  const cautions = orows.filter((r) => r.grade !== 'GREEN');          // 공역·NOTAM 주의 목록(NA=확인 필요 포함)
  const opsLevel = cautions.some((r) => r.grade === 'RED' || r.grade === 'YELLOW') ? 'YELLOW' : cautions.length ? 'NA' : 'GREEN';

  const result = { overall, overallNote, cautions, opsLevel, distanceKm: Math.round(distKm * 10) / 10, distanceNm: Math.round((distKm / KM_PER_NM) * 10) / 10,
    durationMin: Math.round(durationMin), arriveUtc, limits, rows, wind, notams: assessed, hasNA, legs, totalStayMin, points: pts, sun, sunNote };
  result.reportText = buildReport(result, input);
  return result;
}

function buildReport(r, input) {
  const { isNight, isSea } = input;
  const names = r.points.map((p, i) => (i > 0 && i < r.points.length - 1 ? '(경유)' : '') + p.name).join('→');
  const stay = r.totalStayMin ? `체류 ${r.totalStayMin}분 포함, ` : '';
  const parts = [`[재난하늘119 출동판단] ${names} ${r.distanceKm}km/${r.durationMin}분(${stay}도착 ${fmtKst(r.arriveUtc)})`,
    `기상 기준 판정: ${GRADE_TEXT[r.overall]}${r.overallNote ? ' (' + r.overallNote + ')' : ''}`,
    ...(r.cautions.length ? [`주의(공역·NOTAM): ` + r.cautions.map((x) => `${x.item} ${x.value}${x.note ? ' — ' + x.note : ''}`).join(' / ')] : []),
    `적용기준 ${isNight ? '야간' : '주간'}·${isSea ? '해상' : '육상'} 시정 ${r.limits.visM}m·운고 ${r.limits.ceilFt}ft`];
  const ds = r.sun[r.sun.length - 1];
  parts.push(`일출 ${fmtKst(ds.sunrise)} / 일몰 ${fmtKst(ds.sunset)}(목적지)${r.sunNote ? ' · ' + r.sunNote : ''}`);
  const dest = r.rows.filter((x) => x.segment === '목적지');
  if (dest.length) parts.push('목적지 ' + dest.map((x) => `${x.item} ${x.value}(${GRADE_TEXT[x.grade]})`).join('·'));
  for (const x of r.rows.filter((x) => !x.ops && x.segment !== '목적지' && x.grade !== 'GREEN')) {
    parts.push(`${x.item}${x.segment !== '경로' ? '(' + x.segment + ')' : ''} ${x.value}${x.note ? ' — ' + x.note : ''}`);
  }
  const w = r.wind.find((x) => x.segment === '목적지');
  if (w && w.windMs !== null) parts.push(`바람(목적지) ${dirText(w.windDir)} ${w.windMs}m/s(${w.windKt}kt)${w.gustMs ? ' 순간 ' + w.gustMs + 'm/s(' + w.gustKt + 'kt)' : ''}${w.trend ? ' ' + w.trend : ''}`);
  if (isNight) parts.push('제22조① 야간 조건 확인(착륙장 조명, 수색구조 시 야간투시경 등)');
  if (isSea) parts.push('제22조④ 해상 조건 확인(구명조끼·체온보호슈트·해상생환교육 등)');
  return parts.join(' | ');
}
