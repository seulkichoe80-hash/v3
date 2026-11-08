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
