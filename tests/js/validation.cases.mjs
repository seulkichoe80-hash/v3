// 검증 사례표: 규정 제21조① 기준값에서 사람이 직접 계산한 기대 판정(expect)과 시스템 판정을 비교한다.
// 기준(주간·육상 시정 3200m/운고 1000ft, 해상 4800m/1500ft, 야간 4800m/2000ft)과 주의 폭(기준의 1.5배 미만 = 주의)은 config.json·README 4절.
import { readFileSync } from 'node:fs';
import { evaluate } from '../../web/judge.js';
import { AREAS } from '../../web/airspace.js';
import { splitNotams, parseNotam } from '../../web/notam.js';

export const config = JSON.parse(readFileSync(new URL('../../config.json', import.meta.url)));
const NOW = new Date('2026-11-08T05:30:00Z');
const iso = (m) => new Date(NOW.getTime() - m * 60e3).toISOString();
const from = { name: '김포', lat: 37.5583, lon: 126.7906 }, to = { name: '서울역', lat: 37.5547, lon: 126.9707 };
const metar = (o) => ({ icao: 'RKSS', name: '김포', lat: 37.5583, lon: 126.7906, obsTime: iso(30), visM: 9000, ceilFt: 4000, windDir: 320, windKt: 10, gustKt: null, raw: 'METAR RKSS', ...o });
const asos = (o) => ({ stn: '108', name: '서울', lat: 37.5714, lon: 126.9658, obsTime: iso(30), visM: 9000, ceilFt: null, cloudTenths: 3, windDir: 300, windMs: 3, gustMs: null, ...o });
const empty = { metar: [], taf: [], asos: [], aws: [], warn: [], lightning: [] };
const D = () => ({ metar: [metar()], taf: [], asos: [asos()], aws: [], warn: [], lightning: [] });
const base = (o = {}) => ({ from, to, departUtc: NOW, cruiseKt: 110, isNight: false, isSea: false, now: NOW, config, data: D(), dataStatus: {}, notams: [], notamsProvided: true,
  routeRegions: [{ sido: '서울특별시', sigungu: '강서구' }, { sido: '서울특별시', sigungu: '중구' }], ...o });
const withData = (patch, o = {}) => base({ data: { ...D(), ...patch }, ...o });
const taf = (groups) => [{ icao: 'RKSS', name: '김포', lat: 37.5583, lon: 126.7906, groups }];
const warn = { regUpName: '서울특별시', regName: '강서', kind: '강풍', level: '주의보', cmd: '발표' };
const notamD2840 = splitNotams(readFileSync(new URL('../fixtures/notam_d2840.txt', import.meta.url), 'utf8')).map(parseNotam);
const vis = (m, o) => withData({ metar: [metar({ visM: m })] }, o), ceil = (f, o) => withData({ metar: [metar({ ceilFt: f })] }, o);

// [분류, 조건, 입력, 기대 종합(기상), 기대 주의(공역·NOTAM)=선택, 근거]
export const CASES = [
  ['규정 기준', '주간·육상 시정 3,199m', vis(3199), 'RED', null, '기준 3,200m 미만'],
  ['규정 기준', '주간·육상 시정 3,200m', vis(3200), 'YELLOW', null, '기준 이상 ~ 1.5배(4,800m) 미만은 주의'],
  ['규정 기준', '주간·육상 시정 4,799m', vis(4799), 'YELLOW', null, '1.5배 미만'],
  ['규정 기준', '주간·육상 시정 4,800m', vis(4800), 'GREEN', null, '1.5배 이상'],
  ['규정 기준', '주간·육상 운고 999ft', ceil(999), 'RED', null, '기준 1,000ft 미만'],
  ['규정 기준', '주간·육상 운고 1,000ft', ceil(1000), 'YELLOW', null, '기준 이상 ~ 1,500ft 미만'],
  ['규정 기준', '주간·육상 운고 1,500ft', ceil(1500), 'GREEN', null, '1.5배 이상'],
  ['규정 기준', '주간·해상 시정 4,799m', vis(4799, { isSea: true }), 'RED', null, '해상 기준 4,800m'],
  ['규정 기준', '주간·해상 시정 4,800m', vis(4800, { isSea: true }), 'YELLOW', null, ''],
  ['규정 기준', '주간·해상 운고 1,499ft', ceil(1499, { isSea: true }), 'RED', null, '해상 기준 1,500ft'],
  ['규정 기준', '야간 시정 4,799m', vis(4799, { isNight: true }), 'RED', null, '야간 기준 4,800m'],
  ['규정 기준', '야간 운고 1,999ft', ceil(1999, { isNight: true }), 'RED', null, '야간 기준 2,000ft'],
  ['규정 기준', '야간 운고 2,000ft', ceil(2000, { isNight: true }), 'YELLOW', null, ''],
  ['자료 부족', '관측소 자료 전혀 없음', base({ data: empty }), 'NA', null, '없으면 초록으로 표시하지 않음'],
  ['자료 부족', 'METAR가 100분 전(허용 90분 초과)', withData({ metar: [metar({ obsTime: iso(100) })], asos: [] }), 'NA', null, '오래된 자료는 자료없음'],
  ['자료 부족', '낙뢰 자료만 수신 실패', base({ dataStatus: { lightning: 'error' } }), 'GREEN', null, '보조 자료라 판정은 유지하고 "일부 자료 확인 필요" 안내'],
  ['예보·특보', 'TAF TEMPO 구간 시정 2,000m·운고 800ft', withData({ taf: taf([
    { type: 'BASE', from: '2026-11-08T00:00:00Z', to: '2026-11-09T00:00:00Z', visM: 9000, ceilFt: 4000 },
    { type: 'TEMPO', from: '2026-11-08T05:00:00Z', to: '2026-11-08T08:00:00Z', visM: 2000, ceilFt: 800 }]) }), 'YELLOW', null, '일시적 악화(TEMPO)는 주의'],
  ['예보·특보', 'TAF 기본(BASE) 시정 2,000m', withData({ taf: taf([{ type: 'BASE', from: '2026-11-08T00:00:00Z', to: '2026-11-09T00:00:00Z', visM: 2000, ceilFt: 4000 }]) }), 'RED', null, '지속 악화는 제한'],
  ['예보·특보', '강풍주의보, 경로 시군구(강서구) 일치', withData({ warn: [warn] }), 'RED', null, '경로 구역에 발효'],
  ['예보·특보', '강풍주의보, 시·도만 일치(서울서남권)', withData({ warn: [{ ...warn, regName: '서울서남권' }] }), 'YELLOW', null, '구역이 정확히 안 맞으면 확인 필요(주의)'],
  ['예보·특보', '다른 지역(부산) 강풍주의보', withData({ warn: [{ ...warn, regUpName: '부산광역시', regName: '부산' }] }), 'GREEN', null, '경로 밖'],
  ['예보·특보', '경로 근처 5분 전 낙뢰', withData({ lightning: [{ time: iso(5), lat: 37.56, lon: 126.9 }] }), 'YELLOW', null, '20km 이내'],
  ['예보·특보', '같은 낙뢰가 50분 전', withData({ lightning: [{ time: iso(50), lat: 37.56, lon: 126.9 }] }), 'GREEN', null, '30분 지난 낙뢰는 제외'],
  ['판정 분리', '기상 양호 + 경로에 NOTAM(D2840/26) 근접', base({ notams: notamD2840 }), 'GREEN', 'YELLOW', 'NOTAM은 기상 판정과 별도로 "주의"'],
  ['판정 분리', '기상 양호 + NOTAM 미입력', base({ notamsProvided: false }), 'GREEN', 'NA', '"확인 필요"'],
  ['판정 분리', '기상 양호 + 경로가 P-73(서울 비행금지구역) 통과', base({ airspaceAreas: AREAS, to: { name: '용산', lat: 37.5358, lon: 126.9772 } }), 'GREEN', 'YELLOW', '공역은 기상 판정과 별도로 "주의"'],
  ['판정 분리', '기상 악화(시정 3,199m) + NOTAM 근접', vis(3199, { notams: notamD2840 }), 'RED', 'YELLOW', '두 판단이 서로 가리지 않음'],
];

export const run = () => CASES.map(([cat, cond, input, expect, expectOps, why]) => {
  const r = evaluate(input);
  return { cat, cond, why, expect, expectOps, overall: r.overall, ops: r.opsLevel };
});
