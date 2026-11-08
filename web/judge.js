// 119항공대 운영 규정 제21조 기준 판정 엔진 (순수 함수). 시스템은 조언만 하며 최종 판단은 통제관·기장.
import { distanceKm, pointToSegmentKm, KM_PER_NM } from './geo.js';
import { assessNotam } from './notam.js';

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
const alongRoute = (items, a, b, maxKm) => items.filter((it) => has(it) && pointToSegmentKm(it, a, b) <= maxKm);

// 관측 하나가 '운고 정보'를 가지고 있는지(구름 적음 = 운고 없음과 결측을 구분)
const hasCeilInfo = (o) => (o.icao ? o.visM !== null && o.visM !== undefined : o.cloudTenths !== null && o.cloudTenths !== undefined);
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
    rows.push(mk('운고', { value: `${w.ceilFt}ft`, grade: gradeValue(w.ceilFt, limits.ceilFt, f), source: srcName(w), obsTime: w.obsTime, note: '' }));
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

function warnRows(warns, regions, status) {
  if (status === 'error') return [{ segment: '경로', item: '기상특보', value: '-', limit: '발효 없음', grade: 'NA', source: '기상청 특보', obsTime: null, note: '특보 자료 수신 실패 — 직접 확인' }];
  const rows = [];
  for (const w of warns) {
    if (/해제/.test(w.cmd || '')) continue;
    const critical = CRITICAL_WARN.includes(w.kind) && /주의보|경보/.test(w.level || '');
    const exact = regions.some((r) => { const k = sggKey(r.sigungu); return k.length >= 2 && String(w.regName || '').includes(k); });
    const sido = regions.some((r) => sidoKey(r.sido) && sidoKey(r.sido) === sidoKey(w.regUpName));
    let grade = null, note = '';
    if (exact) { grade = critical ? 'RED' : 'YELLOW'; note = critical ? '경로·목적지 특보구역 발효(제21조①4)' : '참고 특보 발효'; }
    else if (sido && critical) { grade = 'YELLOW'; note = '같은 시·도 특보 — 특보구역 확인 필요'; }
    if (grade) rows.push({ segment: '경로', item: '기상특보', value: `${w.regName} ${w.kind}${w.level}`, limit: '발효 없음', grade, source: '기상청 특보', obsTime: w.tmEf || null, note });
  }
  if (!rows.length) rows.push({ segment: '경로', item: '기상특보', value: '해당 없음', limit: '발효 없음', grade: 'GREEN', source: '기상청 특보', obsTime: null, note: '' });
  return rows;
}

function lightningRow(items, a, b, input) {
  const { config, now, dataStatus = {} } = input;
  const base = { segment: '경로', item: '낙뢰', limit: `${config.radius.lightningKm}km 이내 없음`, source: '기상청 낙뢰', obsTime: null };
  if (dataStatus.lightning === 'error') return { ...base, value: '-', grade: 'NA', note: '낙뢰 자료 수신 실패 — 레이더 직접 확인' };
  const near = items.filter((l) => ageMin(l.time, now) <= config.freshnessMin.lightning && has(l))
    .map((l) => pointToSegmentKm(l, a, b)).filter((d) => d <= config.radius.lightningKm);
  if (!near.length) return { ...base, value: '없음', grade: 'GREEN', note: '' };
  return { ...base, value: `${near.length}회 (최근접 ${Math.min(...near).toFixed(1)}km)`, grade: 'YELLOW', note: '뇌우 가능 — 경로 변경 검토(제21조②)' };
}

function windInfo(segment, p, aws, metars, now, config) {
  const fresh = aws.filter((x) => ageMin(x.obsTime, now) <= config.freshnessMin.aws);
  const a = nearest(fresh, p, 30);
  if (a) {
    const d = a.windMs10ago === null || a.windMs10ago === undefined || a.windMs === null ? null : a.windMs - a.windMs10ago;
    return { segment, stn: a.stn, name: `AWS ${a.name}`, windDir: a.windDir, windMs: a.windMs, gustMs: a.gustMs,
      trend: d === null ? null : d >= 2 ? '증가' : d <= -2 ? '감소' : '유지', obsTime: a.obsTime };
  }
  const m = nearest(metars.filter((x) => ageMin(x.obsTime, now) <= config.freshnessMin.metar), p, config.radius.metarNm * KM_PER_NM);
  if (m) {
    const kt2ms = (k) => (k === null || k === undefined ? null : Math.round(k * 0.5144 * 10) / 10);
    return { segment, stn: m.icao, name: `METAR ${m.name}`, windDir: m.windDir, windMs: kt2ms(m.windKt), gustMs: kt2ms(m.gustKt), trend: null, obsTime: m.obsTime };
  }
  return { segment, stn: null, name: '주변 관측 없음', windDir: null, windMs: null, gustMs: null, trend: null, obsTime: null };
}

export function evaluate(input) {
  const { from, to, departUtc, cruiseKt, isNight, isSea, data, config, notams = [], notamsProvided = notams.length > 0, routeRegions = [], dataStatus = {}, now } = input;
  const distKm = distanceKm(from, to);
  const durationMin = distKm === 0 ? 0 : (distKm / (cruiseKt * KM_PER_NM)) * 60;
  const arriveUtc = new Date(departUtc.getTime() + durationMin * 60e3);
  const limits = limitsFor(config, isNight, isSea);
  const metarKm = config.radius.metarNm * KM_PER_NM, asosKm = config.radius.asosKm;
  const metars = data.metar || [], asoss = data.asos || [];

  const pick = (p) => [nearest(metars, p, metarKm), nearest(asoss, p, asosKm)].filter(Boolean);
  const routeObs = [...alongRoute(metars, from, to, metarKm), ...alongRoute(asoss, from, to, asosKm)];
  const rows = [
    ...obsRows('출발지', pick(from), limits, input),
    ...obsRows('경로', routeObs, limits, input),
    ...obsRows('목적지', pick(to), limits, input),
    ...tafRows(alongRoute(data.taf || [], from, to, metarKm), limits, departUtc, arriveUtc),
    ...warnRows(data.warn || [], routeRegions, dataStatus.warn),
    lightningRow(data.lightning || [], from, to, input),
  ];

  const assessed = notams.map((n) => assessNotam(n, from, to, departUtc, arriveUtc, config.radius.notamNearNm));
  const relevant = assessed.filter((n) => n.inScope && n.grade !== 'GREEN');
  if (!notamsProvided) rows.push({ segment: '경로', item: 'NOTAM', value: '미입력', limit: '경로 관련 없음', grade: 'NA', source: 'xNotam', obsTime: null, note: 'NOTAM 미입력 — xNotam 조회 후 붙여넣기' });
  else if (!relevant.length) rows.push({ segment: '경로', item: 'NOTAM', value: `경로 관련 D NOTAM 없음 (입력 ${assessed.length}건)`, limit: '경로 관련 없음', grade: 'GREEN', source: 'xNotam', obsTime: null, note: '' });
  for (const n of relevant) {
    const rel = n.relation === 'CROSS' ? '경로 통과' : n.relation === 'NEAR' ? `경로 ${n.distanceNm.toFixed(1)}NM 근접` : '위치 해석 불가';
    rows.push({ segment: '경로', item: 'NOTAM', value: `${n.id} ${n.qcodeText || ''} ${rel}`.trim(), limit: '경로 관련 없음', grade: n.grade, source: 'xNotam', obsTime: null,
      note: n.needsPermission ? `소방헬기 사전허가 필요${n.phones.length ? ' ' + n.phones.join(', ') : ''}` : (n.parseError || '') });
  }

  const wind = [windInfo('출발지', from, data.aws || [], metars, now, config), windInfo('목적지', to, data.aws || [], metars, now, config)];

  const grades = rows.map((r) => r.grade);
  const hasNA = grades.includes('NA');
  const coreNA = rows.some((r) => (r.segment === '출발지' || r.segment === '목적지') && (r.item === '시정' || r.item === '운고') && r.grade === 'NA');
  let overall = grades.includes('RED') ? 'RED' : grades.includes('YELLOW') ? 'YELLOW' : coreNA ? 'NA' : 'GREEN';
  let overallNote = '';
  if (overall === 'RED') overallNote = PROVISO;
  else if (overall === 'NA') overallNote = '핵심 기상자료 없음 — 직접 확인';
  else if (overall === 'GREEN' && hasNA) overallNote = '단, 일부 자료 확인 필요';

  const result = { overall, overallNote, distanceKm: Math.round(distKm * 10) / 10, distanceNm: Math.round((distKm / KM_PER_NM) * 10) / 10,
    durationMin: Math.round(durationMin), arriveUtc, limits, rows, wind, notams: assessed, hasNA };
  result.reportText = buildReport(result, input);
  return result;
}

function buildReport(r, input) {
  const { from, to, isNight, isSea } = input;
  const parts = [`[운항기상 조언] ${from.name}→${to.name} ${r.distanceKm}km/${r.durationMin}분(도착 ${fmtKst(r.arriveUtc)})`,
    `종합: ${GRADE_TEXT[r.overall]}${r.overallNote ? ' (' + r.overallNote + ')' : ''}`,
    `적용기준 ${isNight ? '야간' : '주간'}·${isSea ? '해상' : '육상'} 시정 ${r.limits.visM}m·운고 ${r.limits.ceilFt}ft`];
  const dest = r.rows.filter((x) => x.segment === '목적지');
  if (dest.length) parts.push('목적지 ' + dest.map((x) => `${x.item} ${x.value}(${GRADE_TEXT[x.grade]})`).join('·'));
  for (const x of r.rows.filter((x) => x.segment !== '목적지' && x.grade !== 'GREEN')) {
    parts.push(`${x.item}${x.segment !== '경로' ? '(' + x.segment + ')' : ''} ${x.value}${x.note ? ' — ' + x.note : ''}`);
  }
  const w = r.wind.find((x) => x.segment === '목적지');
  if (w && w.windMs !== null) parts.push(`바람(목적지) ${dirText(w.windDir)} ${w.windMs}m/s${w.gustMs ? ' 순간 ' + w.gustMs + 'm/s' : ''}${w.trend ? ' ' + w.trend : ''}`);
  return parts.join(' | ');
}
