import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { limitsFor, gradeValue, worst, evaluate } from '../../web/judge.js';
import { splitNotams, parseNotam } from '../../web/notam.js';

const config = JSON.parse(readFileSync(new URL('../../config.json', import.meta.url)));
const NOW = new Date('2026-11-08T05:30:00Z');
const from = { name: '김포', lat: 37.5583, lon: 126.7906 }, to = { name: '서울역', lat: 37.5547, lon: 126.9707 };
const iso = (minAgo) => new Date(NOW.getTime() - minAgo * 60e3).toISOString();
const metar = (o) => ({ icao: 'RKSS', name: '김포', lat: 37.5583, lon: 126.7906, obsTime: iso(30), visM: 9000, ceilFt: 4000, windDir: 320, windKt: 10, gustKt: null, raw: 'METAR RKSS', ...o });
const asos = (o) => ({ stn: '108', name: '서울', lat: 37.5714, lon: 126.9658, obsTime: iso(30), visM: 9000, ceilFt: null, cloudTenths: 3, windDir: 300, windMs: 3, gustMs: null, ...o });
const fx = readFileSync(new URL('../fixtures/notam_d2840.txt', import.meta.url), 'utf8');
const base = (o = {}) => ({
  from, to, departUtc: NOW, cruiseKt: 110, isNight: false, isSea: false, now: NOW, config,
  data: { metar: [metar()], taf: [], asos: [asos()], aws: [], warn: [], lightning: [] },
  dataStatus: {}, notams: [], notamsProvided: true,
  routeRegions: [{ sido: '서울특별시', sigungu: '강서구' }, { sido: '서울특별시', sigungu: '중구' }], ...o,
});
const row = (r, seg, item) => r.rows.find((x) => x.segment === seg && x.item === item);

test('gradeValue 경계', () => {
  assert.equal(gradeValue(3199, 3200), 'RED'); assert.equal(gradeValue(3200, 3200), 'YELLOW');
  assert.equal(gradeValue(4800, 3200), 'GREEN'); assert.equal(gradeValue(4799, 3200), 'YELLOW');
  assert.equal(gradeValue(null, 3200), 'NA');
  assert.equal(gradeValue(999, 1000), 'RED'); assert.equal(gradeValue(1000, 1000), 'YELLOW');
});
test('limitsFor 4조합', () => {
  assert.deepEqual(limitsFor(config, false, false), { visM: 3200, ceilFt: 1000 });
  assert.deepEqual(limitsFor(config, false, true), { visM: 4800, ceilFt: 1500 });
  assert.deepEqual(limitsFor(config, true, false), { visM: 4800, ceilFt: 2000 });
  assert.deepEqual(limitsFor(config, true, true), { visM: 4800, ceilFt: 2000 });
});
test('worst', () => {
  assert.equal(worst([]), 'NA'); assert.equal(worst(['GREEN', 'NA']), 'NA');
  assert.equal(worst(['NA', 'YELLOW']), 'YELLOW'); assert.equal(worst(['YELLOW', 'RED', 'GREEN']), 'RED');
});
test('(정상) 양호 → GREEN', () => {
  const r = evaluate(base({ notams: [] }));
  assert.equal(r.overall, 'GREEN', JSON.stringify(r.rows.filter((x) => x.grade !== 'GREEN')));
  assert.ok(r.distanceKm > 15 && r.distanceKm < 17); assert.ok(r.durationMin > 4 && r.durationMin < 6);
});
test('(a) 관측소 0개 → 시정·운고 NA, 종합 NA', () => {
  const r = evaluate(base({ data: { metar: [], taf: [], asos: [], aws: [], warn: [], lightning: [] } }));
  assert.equal(row(r, '목적지', '시정').grade, 'NA'); assert.equal(row(r, '목적지', '운고').grade, 'NA');
  assert.equal(r.overall, 'NA');
});
test('(a2) 보조자료(낙뢰)만 NA → GREEN + 확인 문구', () => {
  const r = evaluate(base({ dataStatus: { lightning: 'error' } }));
  assert.equal(r.overall, 'GREEN'); assert.equal(r.hasNA, true); assert.match(r.overallNote, /일부 자료 확인 필요/);
});
test('(b) 목적지 시정 2500 주간육상 → RED + 단서', () => {
  const r = evaluate(base({ data: { ...base().data, asos: [asos({ visM: 2500 })] } }));
  assert.equal(r.overall, 'RED'); assert.match(r.overallNote, /제21조① 단서/);
  assert.equal(row(r, '목적지', '시정').grade, 'RED');
});
test('(c) TAF TEMPO만 미달 → YELLOW', () => {
  const taf = [{ icao: 'RKSS', name: '김포', lat: 37.5583, lon: 126.7906, groups: [
    { type: 'BASE', from: '2026-11-08T00:00:00Z', to: '2026-11-09T00:00:00Z', visM: 9000, ceilFt: 4000 },
    { type: 'TEMPO', from: '2026-11-08T05:00:00Z', to: '2026-11-08T08:00:00Z', visM: 2000, ceilFt: 800 }] }];
  const r = evaluate(base({ data: { ...base().data, taf } }));
  assert.equal(r.overall, 'YELLOW'); assert.ok(r.rows.some((x) => x.item === 'TAF' && x.grade === 'YELLOW'));
  const taf2 = [{ ...taf[0], groups: [{ ...taf[0].groups[0], visM: 2000 }] }];
  assert.equal(evaluate(base({ data: { ...base().data, taf: taf2 } })).overall, 'RED');
});
test('(d) 강풍주의보 시군구 일치 → RED, 시도만 일치 → YELLOW', () => {
  const w = { regUpName: '서울특별시', regName: '강서', kind: '강풍', level: '주의보', cmd: '발표' };
  assert.equal(evaluate(base({ data: { ...base().data, warn: [w] } })).overall, 'RED');
  const r = evaluate(base({ data: { ...base().data, warn: [{ ...w, regName: '서울서남권' }] } }));
  assert.equal(r.overall, 'YELLOW'); assert.ok(r.rows.some((x) => x.item === '기상특보' && /확인 필요/.test(x.note)));
  assert.equal(evaluate(base({ data: { ...base().data, warn: [{ ...w, regUpName: '부산광역시', regName: '부산' }] } })).overall, 'GREEN');
});
test('(e) 오래된 METAR(100분) → NA', () => {
  const r = evaluate(base({ data: { ...base().data, metar: [metar({ obsTime: iso(100) })], asos: [] } }));
  assert.equal(row(r, '출발지', '시정').grade, 'NA'); assert.match(row(r, '출발지', '시정').note, /오래/);
});
test('(f) 바람은 판정에 영향 없음', () => {
  const aws = [{ stn: '400', name: '강남', lat: 37.55, lon: 126.97, obsTime: iso(3), windDir: 300, windMs: 25, gustMs: 35, windMs10ago: 10 }];
  const r = evaluate(base({ data: { ...base().data, aws } }));
  assert.equal(r.overall, 'GREEN'); const w = r.wind.find((x) => x.segment === '목적지');
  assert.equal(w.windMs, 25); assert.equal(w.trend, '증가');
});
test('(g) 출발=목적지 → 거리 0, 예외 없음', () => {
  const r = evaluate(base({ to: from })); assert.equal(r.distanceKm, 0); assert.equal(r.durationMin, 0);
});
test('낙뢰 경로 근처 → YELLOW 경로 변경 검토', () => {
  const r = evaluate(base({ data: { ...base().data, lightning: [{ time: iso(5), lat: 37.56, lon: 126.9 }] } }));
  assert.equal(r.overall, 'YELLOW'); assert.ok(r.rows.some((x) => x.item === '낙뢰' && /경로 변경/.test(x.note)));
  assert.equal(evaluate(base({ data: { ...base().data, lightning: [{ time: iso(50), lat: 37.56, lon: 126.9 }] } })).overall, 'GREEN');
});
test('NOTAM D2840 → YELLOW, 보고문 포함 / 미입력 → NA', () => {
  const r = evaluate(base({ notams: splitNotams(fx).map(parseNotam) }));
  assert.equal(r.overall, 'YELLOW'); assert.match(r.reportText, /D2840\/26/); assert.match(r.reportText, /02-524-0315/);
  const n = evaluate(base({ notamsProvided: false }));
  assert.ok(n.rows.some((x) => x.item === 'NOTAM' && x.grade === 'NA')); assert.equal(n.overall, 'GREEN'); assert.equal(n.hasNA, true);
});
test('운고: METAR 구름 없음은 GREEN, 해상 기준 적용', () => {
  const r = evaluate(base({ isSea: true, data: { ...base().data, metar: [metar({ ceilFt: 1400 })] } }));
  assert.equal(row(r, '출발지', '운고').grade, 'RED');
  const r2 = evaluate(base({ data: { ...base().data, metar: [metar({ ceilFt: null })] } }));
  assert.equal(row(r2, '출발지', '운고').grade, 'GREEN');
});
test('TAF가 비행 시간대를 덮지 않으면 NA', () => {
  const taf = [{ icao: 'RKSS', name: '김포', lat: 37.5583, lon: 126.7906, groups: [
    { type: 'BASE', from: '2026-11-08T07:00:00Z', to: '2026-11-09T12:00:00Z', visM: 9000, ceilFt: 4000 }] }];
  const r = evaluate(base({ data: { ...base().data, taf } }));
  const t = r.rows.find((x) => x.item === 'TAF');
  assert.equal(t.grade, 'NA'); assert.match(t.note, /예보 없음/);
});
// ---- 최종 리뷰 지적사항 ----
test('C2 지도 없음(구역 매칭 불가) + 전국 태풍경보 → GREEN 금지(YELLOW)', () => {
  const w = { regUpName: '서울특별시', regName: '서울서남권', kind: '태풍', level: '경보', cmd: '발표' };
  const r = evaluate(base({ routeRegions: [], regionsAvailable: false, data: { ...base().data, warn: [w] } }));
  const row = r.rows.find((x) => x.item === '기상특보');
  assert.equal(row.grade, 'YELLOW'); assert.match(row.note, /매칭 불가/);
});
test('C3 해석 불가 NOTAM 입력 → NOTAM 행 NA', () => {
  const r = evaluate(base({ notams: [parseNotam('엉망인 NOTAM 텍스트 Q)깨짐')] }));
  const rows = r.rows.filter((x) => x.item === 'NOTAM');
  assert.ok(rows.some((x) => x.grade === 'NA'), JSON.stringify(rows)); assert.ok(!rows.some((x) => x.grade === 'GREEN'));
});
test('C3 한 칸 띄운 헤더(NOTAM N)도 해석', () => {
  const list = splitNotams(fx.replace('NOTAMN', 'NOTAM N'));
  assert.equal(parseNotam(list[0]).id, 'D2840/26');
});
test('C3 첫 NOTAM 앞에 본문이 있으면 버리지 않음', () => {
  const list = splitNotams('Q)RKRR/QRPCA/IV/BO/W/000/600/3735N12659E003 E)잘린 본문\n' + fx);
  assert.equal(list.length, 2);
});
test('I1 운고 높이 미상(ceilUnknown) → 운고 NA', () => {
  const r = evaluate(base({ data: { ...base().data, metar: [], asos: [asos({ cloudTenths: 8, ceilFt: null, ceilUnknown: true })] } }));
  assert.equal(row(r, '목적지', '운고').grade, 'NA');
});
test('I2 순항속도 0/비정상 → 멈추지 않고 기본값 사용, NOTAM 무시 안 함', () => {
  const r = evaluate(base({ cruiseKt: 0, notams: splitNotams(fx).map(parseNotam) }));
  assert.ok(Number.isFinite(r.durationMin)); assert.ok(r.durationMin > 0);
  assert.ok(r.rows.some((x) => x.item === 'NOTAM' && x.grade === 'YELLOW'));
});
test('I4 오래된 낙뢰 자료(stale) → NA', () => {
  const r = evaluate(base({ dataStatus: { lightning: 'stale' } }));
  assert.equal(r.rows.find((x) => x.item === '낙뢰').grade, 'NA');
});
test('I5 해상 구간 + 해상 특보구역 강풍 → YELLOW 해상 특보구역 확인', () => {
  const w = { regUpName: '인천광역시', regName: '서해중부앞바다', kind: '풍랑', level: '주의보', cmd: '발표' };
  const r = evaluate(base({ seaRoute: true, data: { ...base().data, warn: [w] } }));
  const row = r.rows.find((x) => x.item === '기상특보');
  assert.equal(row.grade, 'YELLOW'); assert.match(row.note, /해상/);
});
test('보고문에 값과 설명이 중복되지 않음', () => {
  const r = evaluate(base({ notamsProvided: false }));
  assert.ok(!/NOTAM 미입력 — NOTAM 미입력/.test(r.reportText), r.reportText);
});
// ---- 경유지 ----
const wp = { name: '경유A', lat: 37.62, lon: 126.88, stayMin: 10 };
test('경유지: 거리 합계·체류시간·구간표', () => {
  const r = evaluate(base({ points: [from, wp, to] }));
  assert.equal(r.legs.length, 2);
  const sum = r.legs.reduce((a, l) => a + l.distanceKm, 0);
  assert.ok(Math.abs(r.distanceKm - sum) < 0.2); assert.ok(r.distanceKm > 16);
  assert.equal(r.totalStayMin, 10);
  assert.ok(Math.abs(r.durationMin - (r.legs[0].durationMin + r.legs[1].durationMin + 10)) <= 1);
  assert.ok(r.rows.some((x) => x.segment === '경유지1' && x.item === '시정'));
  assert.match(r.reportText, /경유A/); assert.match(r.reportText, /체류 10분/);
});
test('경유지 0개면 from/to와 결과 동일', () => {
  const a = evaluate(base()), b = evaluate(base({ points: [from, to] }));
  assert.equal(a.overall, b.overall); assert.equal(a.distanceKm, b.distanceKm); assert.equal(a.rows.length, b.rows.length);
});
test('경유지 근처에만 있는 낙뢰·NOTAM도 감지', () => {
  const far = { name: '멀리', lat: 37.9, lon: 127.3, stayMin: 0 };
  const lt = [{ time: new Date(NOW.getTime() - 5 * 60e3).toISOString(), lat: 37.9, lon: 127.25 }];
  assert.equal(evaluate(base({ data: { ...base().data, lightning: lt } })).rows.find((x) => x.item === '낙뢰').grade, 'GREEN');
  assert.equal(evaluate(base({ points: [from, far, to], data: { ...base().data, lightning: lt } })).rows.find((x) => x.item === '낙뢰').grade, 'YELLOW');
});
test('경유지 바람 정보 포함', () => {
  const r = evaluate(base({ points: [from, wp, to] }));
  assert.deepEqual(r.wind.map((w) => w.segment), ['출발지', '경유지1', '목적지']);
});
// ---- 일출·일몰 ----
test('일출·일몰: 지점별 시각과 브리핑 표기', () => {
  const r = evaluate(base());
  assert.deepEqual(r.sun.map((s) => s.segment), ['출발지', '목적지']);
  const d = r.sun[1]; const kmin = (t) => { const k = new Date(t.getTime() + 9 * 3600e3); return k.getUTCHours() * 60 + k.getUTCMinutes(); };
  assert.ok(Math.abs(kmin(d.sunset) - (17 * 60 + 25)) <= 10); assert.ok(Math.abs(kmin(d.sunrise) - (7 * 60)) <= 10);
  assert.match(r.reportText, /일출 \d\d:\d\d/); assert.match(r.reportText, /일몰 \d\d:\d\d/);
});
test('일몰 임박·일몰 후 도착 강조', () => {
  const soon = evaluate(base({ departUtc: new Date('2026-11-08T08:05:00Z'), now: new Date('2026-11-08T08:05:00Z') }));  // KST 17:05
  assert.match(soon.sunNote, /일몰 \d+분 전/);
  const after = evaluate(base({ departUtc: new Date('2026-11-08T08:40:00Z'), now: new Date('2026-11-08T08:40:00Z') }));  // KST 17:40
  assert.match(after.sunNote, /일몰 후/);
  assert.equal(evaluate(base()).sunNote, '');  // 14:30 출발: 강조 없음
});
test('일몰 안내는 가장 급한 지점(목적지 도착)을 표시', () => {
  const r = evaluate(base({ points: [from, { name: '경유A', lat: 37.62, lon: 126.88, stayMin: 10 }, to],
    departUtc: new Date('2026-11-08T07:45:00Z'), now: new Date('2026-11-08T07:45:00Z') }));   // KST 16:45 출발, 17:01 도착
  assert.match(r.sunNote, /^목적지 도착 시 일몰 \d+분 전/, r.sunNote);
});
test('보고문 머리말은 재난하늘119', () => { assert.match(evaluate(base()).reportText, /^\[재난하늘119 출동판단\] /); });
// ---- 저고도 SIGWX ----
const ice = { kind: 'ICE', label: 'MOD_ICE', issued: '2026-11-08T05:00:00Z', points: [{ lat: 37.50, lon: 126.85 }, { lat: 37.62, lon: 126.85 }, { lat: 37.62, lon: 126.95 }, { lat: 37.50, lon: 126.95 }] };
test('SIGWX: 경로가 착빙 구역 통과 → 주의', () => {
  const r = evaluate(base({ data: { ...base().data, sigwx: [ice] } }));
  const row = r.rows.find((x) => x.item === '저고도 중요기상');
  assert.equal(row.grade, 'YELLOW'); assert.match(row.value, /착빙/); assert.match(r.reportText, /착빙/);
});
test('SIGWX: 해당 없음 → 가능 / 자료 수신 실패·해석 0건 → 자료없음', () => {
  const far = { ...ice, points: ice.points.map((p) => ({ lat: p.lat - 2, lon: p.lon })) };
  assert.equal(evaluate(base({ data: { ...base().data, sigwx: [far] } })).rows.find((x) => x.item === '저고도 중요기상').grade, 'GREEN');
  assert.equal(evaluate(base({ data: { ...base().data, sigwx: [] } })).rows.find((x) => x.item === '저고도 중요기상').grade, 'NA');
  assert.equal(evaluate(base({ dataStatus: { sigwx: 'error' }, data: { ...base().data, sigwx: [] } })).rows.find((x) => x.item === '저고도 중요기상').grade, 'NA');
});
// ---- kt 병기, 제22조 안내 ----
test('바람: m/s와 kt 함께', () => {
  const aws = [{ stn: '400', name: '강남', lat: 37.55, lon: 126.97, obsTime: iso(3), windDir: 300, windMs: 6.5, gustMs: 10, windMs10ago: 6 }];
  const r = evaluate(base({ data: { ...base().data, aws } }));
  const w = r.wind.find((x) => x.segment === '목적지');
  assert.equal(w.windKt, 13); assert.equal(w.gustKt, 19);
  assert.match(r.reportText, /6\.5m\/s\(13kt\)/); assert.match(r.reportText, /순간 10m\/s\(19kt\)/);
});
test('보고문에 제22조 확인 안내(야간·해상일 때만)', () => {
  const day = evaluate(base()).reportText; assert.ok(!/제22조/.test(day));
  const night = evaluate(base({ isNight: true })).reportText; assert.match(night, /제22조① 야간 조건 확인/);
  const sea = evaluate(base({ isSea: true })).reportText; assert.match(sea, /제22조④ 해상 조건 확인/);
});
// ---- ASOS 운고 근거(전운량·중하층운량) 표시 ----
test('ASOS 운고 행에 전운량·중하층운량을 보여 준다', () => {
  const r = evaluate(base({ isNight: true, data: { ...base().data, metar: [], asos: [asos({ ceilFt: 1969, cloudTenths: 8, midTenths: 3 })] } }));   // 야간 육상 기준 2000ft
  const row = r.rows.find((x) => x.segment === '목적지' && x.item === '운고');
  assert.equal(row.grade, 'RED'); assert.match(row.note, /전운량 8\/10/); assert.match(row.note, /중하층 3\/10/);
});
test('METAR 운고 행에는 ASOS 구름 설명이 붙지 않음', () => {
  const r = evaluate(base({ data: { ...base().data, asos: [] } }));
  const row = r.rows.find((x) => x.segment === '목적지' && x.item === '운고');
  assert.ok(!/전운량/.test(row.note || ''));
});
test('ASOS 중하층 운량만 있고 전운량이 없어도 운고 정보로 인정', () => {
  const r = evaluate(base({ isNight: true, data: { ...base().data, metar: [], asos: [asos({ cloudTenths: null, midTenths: 7, ceilFt: 1500 })] } }));
  const row = r.rows.find((x) => x.segment === '목적지' && x.item === '운고');
  assert.equal(row.grade, 'RED'); assert.match(row.note, /중하층 7\/10/);
});

// ---- 기상특보 매칭 보정 ----
test('바다 구역 이름에 시군구 이름이 글자로 들어 있어도 육지 경로와 일치시키지 않음(부안 ⊂ 중부안쪽먼바다)', () => {
  const warns = [{ regUpName: '동해중부전해상', regName: '동해중부안쪽먼바다', kind: '풍랑', level: '예비', cmd: '발표' },
                 { regUpName: '서해중부전해상', regName: '서해중부안쪽먼바다', kind: '풍랑', level: '주의', cmd: '발표' }];
  const r = evaluate(base({ routeRegions: [{ sido: '전북특별자치도', sigungu: '부안군' }], regionsAvailable: true, data: { ...base().data, warn: warns } }));
  const rows = r.rows.filter((x) => x.item === '기상특보');
  assert.equal(rows.length, 1); assert.equal(rows[0].grade, 'GREEN'); assert.match(rows[0].value, /해당 없음/);
});
test('특보 등급 표기 "주의"도 주의보로 인식(육지 구역 → RED), "예비"는 참고', () => {
  const mk = (level) => ({ regUpName: '경기도', regName: '수원', kind: '강풍', level, cmd: '발표' });
  const run = (level) => evaluate(base({ routeRegions: [{ sido: '경기도', sigungu: '수원시 영통구' }], regionsAvailable: true, data: { ...base().data, warn: [mk(level)] } })).rows.find((x) => x.item === '기상특보');
  assert.equal(run('주의').grade, 'RED'); assert.equal(run('주의보').grade, 'RED'); assert.equal(run('경보').grade, 'RED');
  const p = run('예비'); assert.equal(p.grade, 'YELLOW'); assert.match(p.note, /참고/);
});
test('해상 경로 + 먼바다 풍랑주의(표기 "주의") → 해상 특보구역 확인(YELLOW)', () => {
  const w = { regUpName: '서해중부전해상', regName: '서해중부안쪽먼바다', kind: '풍랑', level: '주의', cmd: '발표' };
  const row = evaluate(base({ seaRoute: true, routeRegions: [{ sido: '전북특별자치도', sigungu: '부안군' }], regionsAvailable: true, data: { ...base().data, warn: [w] } })).rows.find((x) => x.item === '기상특보');
  assert.equal(row.grade, 'YELLOW'); assert.match(row.note, /해상/);
});
// ---- 저고도 SIGWX: 위치 없는 요소 ----
const sigRow = (items, extra = {}) => evaluate(base({ ...extra, data: { ...base().data, sigwx: items } })).rows.find((x) => x.item === '저고도 중요기상');
test('SIGWX: 위험 요소는 있는데 위치(경위도)가 없으면 NA, 0℃ 고도는 안내', () => {
  const r = sigRow([{ kind: 'FZL', label: 'freezing_level 0°C:050', points: [], geo: false, fzlFt: 5000, issued: '2026-11-08T17:00:00Z' },
                    { kind: 'ICE', label: 'MOD ICE', points: [], geo: false, issued: '2026-11-08T17:00:00Z' }]);
  assert.equal(r.grade, 'NA'); assert.match(r.note, /위치/); assert.match(r.note + r.value, /5000ft/); assert.match(r.value, /착빙/);
});
test('SIGWX: 위치 있는 요소는 교차 판정, 위치 없는 위험 요소가 섞이면 NA', () => {
  const far = { kind: 'ICE', label: 'ICE', issued: '2026-11-08T17:00:00Z', geo: true, points: [{ lat: 36, lon: 126 }, { lat: 36, lon: 127 }, { lat: 35.5, lon: 127 }] };
  assert.equal(sigRow([far]).grade, 'GREEN');
  assert.equal(sigRow([far, { kind: 'TURB', label: 'TURB', points: [], geo: false }]).grade, 'NA');
  assert.equal(sigRow([{ kind: 'FZL', label: '0°C:050', points: [], geo: false, fzlFt: 5000 }]).grade, 'GREEN');   // 위험구역 발표 없음(0℃ 고도만)
});
// ---- 저고도 SIGWX: 실제 응답 구조(층·아이콘·고도·여러 0℃선) ----
const poly = (k, o = {}) => ({ kind: k, label: k, layer: 'low', closed: true, geo: true, points: [{ lat: 37.50, lon: 126.85 }, { lat: 37.62, lon: 126.85 }, { lat: 37.62, lon: 126.95 }, { lat: 37.50, lon: 126.95 }], ...o });
test('SIGWX: 고도 정보가 있으면 안내문에 붙는다', () => {
  const r = sigRow([poly('ICE', { alt: { baseFt: 6000, topFt: null, text: 'FL060 이상' } })]);
  assert.equal(r.grade, 'YELLOW'); assert.match(r.note, /FL060 이상/); assert.match(r.note, /비행고도/);
});
test('SIGWX: 아이콘·선(닫히지 않은 요소)과 중층(mid) 구역은 위험구역으로 세지 않는다', () => {
  const icon = poly('ICE', { closed: false, points: [{ lat: 37.5, lon: 126.9 }, { lat: 37.6, lon: 126.9 }] });
  const mid = poly('TURB', { layer: 'mid' });
  const far = poly('ICE', { points: [{ lat: 36, lon: 126 }, { lat: 36, lon: 127 }, { lat: 35.5, lon: 127 }] });
  const r = sigRow([icon, mid, far]);
  assert.equal(r.grade, 'GREEN', JSON.stringify(r));                          // 경로를 지나는 mid 난류·아이콘은 무시, 멀리 있는 low 착빙만 해당
  assert.equal(sigRow([mid]).grade, 'GREEN'); assert.match(sigRow([mid]).value, /위험구역 발표 없음/);
});
test('SIGWX: 저시정·지상풍 구역도 경로를 지나면 주의, 0℃ 고도선은 여러 개를 모두 안내', () => {
  const r = sigRow([poly('VIS'), poly('WIND'), { kind: 'FZL', label: '0℃:050', layer: 'low', closed: false, points: [], fzlFt: 5000 }, { kind: 'FZL', label: '0℃:100', layer: 'low', closed: false, points: [], fzlFt: 10000 }]);
  assert.equal(r.grade, 'YELLOW'); assert.match(r.value, /저시정/); assert.match(r.value, /지상풍/); assert.match(r.value, /5000ft·10000ft/);
});
