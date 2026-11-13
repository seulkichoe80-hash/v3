// 임무브리핑: 출동 정보를 메신저로 미리 알리는 양식(첨부 양식과 같은 구성). 순수 함수만 둔다.
import { formatCoord } from './coords.js';

const REQ = { k: 'req', label: '요청 시·도(요청 시간)', ph: '예: 충북 1120', type: 'req' };
const ETC = '기타';
export const TEMPLATES = [
  { id: 'fire', group: '구조', name: '산불', title: '충북 충주 산불', fields: [
    REQ,
    { k: 'place', label: '화재 장소(좌표)', ph: '주소 / 명칭(좌표)', type: 'place' },
    { k: 'water', label: '담수지 정보', ph: '명칭(좌표)', type: 'place' },
    { k: 'bucket', label: '밤비바켓 탈·부착 장소', ph: '명칭(좌표)', type: 'place' },
    { k: 'team', label: '현장 출동대', ph: '지휘팀(010-XXXX-XXXX)', type: 'text' },
    { k: 'heli', label: '헬기 출동 현황', ph: '출동 헬기·시각', type: 'text' },
  ] },
  { id: 'fire2', group: '구조', name: '화재', title: '화재', fields: [
    REQ,
    { k: 'place', label: '화재 장소(좌표)', ph: '주소 / 명칭(좌표)', type: 'place' },
    { k: 'team', label: '현장 출동대', ph: '지휘팀(010-XXXX-XXXX)', type: 'text' },
    { k: 'heli', label: '헬기 출동 현황', ph: '출동 헬기·시각', type: 'text' },
  ] },
  { id: 'mountain', group: '구조', name: '산악·수난·수색 등', title: '산악, 수난, 수색 등', fields: [
    REQ,
    { k: 'victim', label: '구조 대상자', ph: '나이(남/여), 부상정도', type: 'text' },
    { k: 'place', label: '구조 장소(좌표)', ph: 'OO산, OO봉(좌표), 수색구역 요도(별첨)', type: 'place' },
    { k: 'handover', label: '구조 후 인계', ph: '명칭(좌표)', type: 'place' },
    { k: 'hospital', label: '이송병원', ph: 'OO병원', type: 'text' },
    { k: 'team', label: '현장 출동대', ph: '구조, 구급대(010-XXXX-XXXX)', type: 'text' },
  ] },
  { id: 'ems', group: '구급', name: '응급환자 이송(전원·HELI-EMS)', title: '전원, HELI-EMS, 응급환자 이송', fields: [
    REQ,
    { k: 'patient', label: '환자정보', ph: '나이(남/여), 증상', type: 'text' },
    { k: 'hospital', label: '이송병원', ph: 'OO병원', type: 'text' },
    { k: 'take', label: '환자 인수', ph: '명칭(좌표)', type: 'place' },
    { k: 'give', label: '환자 인계', ph: '명칭(좌표)', type: 'place' },
    { k: 'team', label: '이송구급대', ph: 'OO구급(010-XXXX-XXXX)', type: 'text' },
  ] },
  { id: 'organ', group: '장기이송', name: '장기 이송', title: '장기 이송', fields: [
    { k: 'req', label: '국립장기조직혈액관리원(요청 시간)', ph: '예: 1120', type: 'time' },
    { k: 'organ', label: '이송장기', ph: '심장(적출 예상시간 MM:SS)', type: 'text' },
    { k: 'hosp', label: '요청병원/이송병원', ph: '명칭', type: 'text' },
    { k: 'take', label: '장기인수', ph: '주소 / 명칭(좌표)', type: 'place' },
    { k: 'give', label: '장기인계', ph: '주소 / 명칭(좌표)', type: 'place' },
    { k: 'crew', label: '탑승인원/의료진연락처', ph: '0명 / 010-XXXX-XXXX', type: 'text' },
    { k: 'coord', label: '코디네이터', ph: 'OOO(010-XXXX-XXXX)', type: 'text' },
  ] },
  { id: 'support', group: '업무지원', name: '인원·구조견·장비 이송', title: '인원, 구조견, 장비 이송', fields: [
    REQ,
    { k: 'crew', label: '탑승자', ph: 'OOO등 O명, 장비 O대', type: 'text' },
    { k: 'board', label: '탑승 장소', ph: '주소 / 명칭(좌표)', type: 'place' },
    { k: 'alight', label: '하기 장소', ph: '주소 / 명칭(좌표)', type: 'place' },
    { k: 'liaison', label: '현장연락관', ph: 'OOO(010-XXXX-XXXX)', type: 'text' },
  ] },
  { id: 'training', group: '훈련비행·정비이동', name: '훈련비행·정비이동', title: '훈련비행, 정비이동', fields: [
    { k: 'kind', label: '훈련구분', ph: '임무유형별 훈련(구조, 구급 등)', type: 'text' },
    { k: 'time', label: '훈련시간', ph: 'HH:MM ~ HH:MM', type: 'text' },
    { k: 'crew', label: '훈련인원', ph: '기장 OOO등 O명', type: 'text' },
    { k: 'place', label: '훈련장소', ph: '주소 / 명칭', type: 'place' },
    { k: 'plan', label: '비행계획 제출', ph: 'O / X', type: 'text' },
  ] },
];
export const ETC_CHECKS = ['P-518', 'P-73', 'R-75', '비행장 PPR', '연료보급'];

// 검색으로 고른 장소를 "주소 / 명칭(좌표)" 형태 한 줄로 만든다. 좌표 형식은 fmt(dd·ddm·dms).
export function composeLoc(pl, fmt = 'dd') {
  if (!pl || !Number.isFinite(pl.lat) || !Number.isFinite(pl.lon)) return '';
  const name = String(pl.name || '').trim(), addr = String(pl.addr || '').trim(), c = formatCoord(pl, fmt);
  if (addr && name && addr !== name && !name.includes(addr)) return `${addr} / ${name}(${c})`;
  return `${name || addr || '지점'}(${c})`;
}

// 메신저로 보낼 브리핑 글. 값이 비어 있는 항목은 기본적으로 뺀다(includeBlank로 포함 가능).
export function buildBrief({ tpl, unit = '', title = '', values = {}, etcChecks = [], etcText = '', resultLine = '', includeBlank = false }) {
  const head = `[${unit.trim() || '00호'}] ${title.trim() || tpl.title}`;
  const lines = [head];
  for (const f of tpl.fields) {
    const v = String(values[f.k] || '').trim();
    if (v || includeBlank) lines.push(`- ${f.label} : ${v}`);
  }
  const etc = [...etcChecks, String(etcText || '').trim()].filter(Boolean).join(', ');
  if (etc || includeBlank) lines.push(`- ${ETC} : ${etc}`);
  if (resultLine) lines.push(resultLine);
  return lines.join('\n');
}

// 큰 갈래 → 세부 종별(양식은 tpl 로 연결). 제목은 "지역 + 종별"로 만든다.
export const CATS = [
  { name: '화재', items: [['산불', 'fire'], ['공장화재', 'fire2'], ['기타화재', 'fire2']] },
  { name: '구조', items: [['산악구조', 'mountain'], ['건물구조', 'mountain'], ['수난구조', 'mountain'], ['수색구조', 'mountain']] },
  { name: '구급', items: [['환자이송', 'ems'], ['병원 간 전원', 'ems'], ['장기이송', 'organ']] },
  { name: '기타', items: [['장비이송', 'support'], ['훈련비행', 'training'], ['정비이동', 'training']] },
];
export const titleOf = (region, kind) => [String(region || '').trim(), kind].filter(Boolean).join(' ');

const SIDO = { 서울: '서울소방재난본부', 부산: '부산소방재난본부', 대구: '대구소방안전본부', 인천: '인천소방본부', 광주: '광주소방안전본부', 대전: '대전소방본부', 울산: '울산소방본부', 세종: '세종소방본부', 경기: '경기소방재난본부', 강원: '강원소방본부', 충북: '충북소방본부', 충남: '충남소방본부', 전북: '전북소방본부', 전남: '전남소방본부', 경북: '경북소방본부', 경남: '경남소방본부', 제주: '제주소방안전본부' };
const SIDO_LONG = { 충청북도: '충북', 충청남도: '충남', 전라북도: '전북', 전라남도: '전남', 경상북도: '경북', 경상남도: '경남', 경기도: '경기', 강원도: '강원', 제주도: '제주', 서울시: '서울', 부산시: '부산', 대구시: '대구', 인천시: '인천', 광주시: '광주', 대전시: '대전', 울산시: '울산', 세종시: '세종' };
// "1120", "11:20", "11시20분" → "11:20" (잘못된 값은 null)
export function parseTime(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\s*[:시]?\s*(\d{2})\s*분?$/);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  return h < 24 && mi < 60 ? `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` : null;
}
// "충북 1120" → "충북소방본부(11:20)". 시·도 앞글자(2자)와 시간만 있으면 된다. 이미 완성된 글(괄호 포함)은 그대로 둔다.
export function parseReq(s) {
  const t = String(s || '').trim();
  if (!t || /[()]/.test(t)) return t;
  const m = t.match(/^(\S+?)\s*(\d{1,2}\s*[:시]?\s*\d{2}\s*분?)$/);
  if (!m) return t;
  const tm = parseTime(m[2]); if (!tm) return t;
  const key = SIDO_LONG[m[1]] || m[1].slice(0, 2);
  return `${SIDO[key] || key + '소방본부'}(${tm})`;
}
