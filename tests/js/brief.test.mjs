import test from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, ETC_CHECKS, CATS, titleOf, parseReq, parseTime, composeLoc, buildBrief } from '../../web/brief.js';

const T = (id) => TEMPLATES.find((t) => t.id === id);
test('양식 6종과 항목 구성이 첨부 양식과 같다', () => {
  assert.deepEqual(TEMPLATES.map((t) => t.id), ['fire', 'fire2', 'mountain', 'ems', 'organ', 'support', 'training']);
  assert.deepEqual(T('fire').fields.map((f) => f.label), ['요청 시·도(요청 시간)', '화재 장소(좌표)', '담수지 정보', '밤비바켓 탈·부착 장소', '현장 출동대', '헬기 출동 현황']);
  assert.deepEqual(T('ems').fields.map((f) => f.label), ['요청 시·도(요청 시간)', '환자정보', '이송병원', '환자 인수', '환자 인계', '이송구급대']);
  assert.equal(T('organ').fields[0].label, '국립장기조직혈액관리원(요청 시간)');
  assert.deepEqual(T('support').fields.map((f) => f.label), ['요청 시·도(요청 시간)', '탑승자', '탑승 장소', '하기 장소', '현장연락관']);
  assert.deepEqual(ETC_CHECKS, ['P-518', 'P-73', 'R-75', '비행장 PPR', '연료보급']);
  for (const t of TEMPLATES) for (const f of t.fields) assert.ok(['text', 'place', 'req', 'time'].includes(f.type));
});
test('composeLoc: 주소/명칭(좌표) 형식, 좌표 3형식', () => {
  const pl = { name: '아주대학교병원', addr: '경기 수원시 영통구 월드컵로 164', lat: 37.279, lon: 127.0466 };
  assert.equal(composeLoc(pl, 'dd'), '경기 수원시 영통구 월드컵로 164 / 아주대학교병원(37.27900, 127.04660)');
  assert.equal(composeLoc(pl, 'ddm'), "경기 수원시 영통구 월드컵로 164 / 아주대학교병원(37°16.740'N 127°02.796'E)");
  assert.match(composeLoc(pl, 'dms'), /아주대학교병원\(37°16'44\.4"N 127°02'47\.8"E\)$/);
  assert.equal(composeLoc({ name: '경기 평택시 평남로 616', addr: '', lat: 37.016, lon: 127.077 }), '경기 평택시 평남로 616(37.01600, 127.07700)');
  assert.equal(composeLoc({ name: '같은 이름', addr: '같은 이름', lat: 37, lon: 127 }), '같은 이름(37.00000, 127.00000)');
  assert.equal(composeLoc(null), ''); assert.equal(composeLoc({ name: 'x', lat: NaN, lon: 1 }), '');
});
test('buildBrief: 머리말·항목·기타, 빈 항목 제외/포함', () => {
  const v = { req: '충북상황실(10:20)', place: '충주시 OO / OO산(36.9, 127.9)', team: '지휘팀(010-1234-5678)' };
  const t = buildBrief({ tpl: T('fire'), unit: '중앙 1호', title: '충북 충주 산불', values: v, etcChecks: ['P-518', '연료보급'], etcText: '풍속 주의' });
  assert.equal(t, ['[중앙 1호] 충북 충주 산불', '- 요청 시·도(요청 시간) : 충북상황실(10:20)', '- 화재 장소(좌표) : 충주시 OO / OO산(36.9, 127.9)', '- 현장 출동대 : 지휘팀(010-1234-5678)', '- 기타 : P-518, 연료보급, 풍속 주의'].join('\n'));
  const full = buildBrief({ tpl: T('fire'), values: v, includeBlank: true });
  assert.match(full, /^\[00호\] 충북 충주 산불\n/); assert.match(full, /- 담수지 정보 : \n/); assert.match(full, /- 기타 : $/);
  assert.equal(buildBrief({ tpl: T('training'), values: { kind: '구조 훈련' }, resultLine: '※ 참고' }), '[00호] 훈련비행, 정비이동\n- 훈련구분 : 구조 훈련\n※ 참고');
});

test('요청 시·도: 앞글자+시간 → 소방본부(HH:MM)', () => {
  assert.equal(parseReq('충북 1120'), '충북소방본부(11:20)');
  assert.equal(parseReq('충북1120'), '충북소방본부(11:20)');
  assert.equal(parseReq('경남 9:05'), '경남소방본부(09:05)');
  assert.equal(parseReq('서울 0830'), '서울소방재난본부(08:30)');
  assert.equal(parseReq('충청북도 1120'), '충북소방본부(11:20)');
  assert.equal(parseReq('경기소방재난본부(10:00)'), '경기소방재난본부(10:00)');
  assert.equal(parseReq('충북 2575'), '충북 2575'); assert.equal(parseReq('충북'), '충북'); assert.equal(parseReq(''), '');
  assert.equal(parseTime('1120'), '11:20'); assert.equal(parseTime('11시 20분'), '11:20'); assert.equal(parseTime('2460'), null);
});
test('갈래·제목', () => {
  assert.deepEqual(CATS.map((c) => c.name), ['화재', '구조', '구급', '기타']);
  assert.deepEqual(CATS.flatMap((c) => c.items.map((i) => i[0])), ['산불', '공장화재', '기타화재', '산악구조', '건물구조', '수난구조', '수색구조', '환자이송', '병원 간 전원', '장기이송', '장비이송', '훈련비행', '정비이동']);
  for (const c of CATS) for (const [, id] of c.items) assert.ok(TEMPLATES.some((x) => x.id === id));
  assert.equal(titleOf('충북 충주', '산불'), '충북 충주 산불'); assert.equal(titleOf('', '산불'), '산불');
});
