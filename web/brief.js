// 임무브리핑: 출동 정보를 메신저로 미리 알리는 양식(첨부 양식과 같은 구성). 순수 함수만 둔다.
import { formatCoord } from './coords.js';

const REQ = { k: 'req', label: '요청 시·도(요청 시간)', ph: 'OO상황실(HH:MM)', type: 'text' };
const ETC = '기타';
export const TEMPLATES = [
  { id: 'fire', group: '구조', name: '산불', title: '충북 충주 산불', fields: [
    { ...REQ, ph: '상황실(HH:MM)' },
    { k: 'place', label: '화재 장소(좌표)', ph: '주소 / 명칭(좌표)', type: 'place' },
    { k: 'water', label: '담수지 정보', ph: '명칭(좌표)', type: 'place' },
    { k: 'bucket', label: '밤비바켓 탈·부착 장소', ph: '명칭(좌표)', type: 'place' },
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
    { ...REQ, ph: '상황실(HH:MM)' },
    { k: 'patient', label: '환자정보', ph: '나이(남/여), 증상', type: 'text' },
    { k: 'hospital', label: '이송병원', ph: 'OO병원', type: 'text' },
    { k: 'take', label: '환자 인수', ph: '명칭(좌표)', type: 'place' },
    { k: 'give', label: '환자 인계', ph: '명칭(좌표)', type: 'place' },
    { k: 'team', label: '이송구급대', ph: 'OO구급(010-XXXX-XXXX)', type: 'text' },
  ] },
  { id: 'organ', group: '장기이송', name: '장기 이송', title: '장기 이송', fields: [
    { k: 'req', label: '국립장기조직혈액관리원(요청 시간)', ph: 'HH:MM', type: 'text' },
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
  const head = `[${unit.trim() || '소속 호'}] ${title.trim() || tpl.title}`;
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
