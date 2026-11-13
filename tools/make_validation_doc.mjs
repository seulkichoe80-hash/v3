// 검증 사례표(docs/검증사례.md) 생성: node tools/make_validation_doc.mjs
import { writeFileSync } from 'node:fs';
import { run } from '../tests/js/validation.cases.mjs';

const T = { RED: '규정상 비행제한', YELLOW: '주의', GREEN: '규정상 운항 가능', NA: '자료없음·직접 확인' };
const ops = { YELLOW: '주의', NA: '확인 필요', GREEN: '-' };
const rows = run();
const ok = rows.filter((r) => r.overall === r.expect && (!r.expectOps || r.ops === r.expectOps)).length;
const md = `# 판정 검증 사례표

규정(119항공대 운영 규정 제21조①) 기준값에서 **사람이 직접 계산한 기대 판정**과 시스템 판정을 비교한 표입니다.
조건을 코드에서 입력해 그대로 돌리며(\`tests/js/validation.cases.mjs\`), 푸시할 때마다 자동 시험(\`tests/js/validation.test.mjs\`)이 같은 비교를 합니다.

- 기준값: 주간·육상 시정 3,200m / 운고 1,000ft, 주간·해상 4,800m / 1,500ft, 야간 4,800m / 2,000ft
- 기준 미만 = 규정상 비행제한(규정). 기준 이상 ~ 기준의 1.5배 미만 = 주의, 1.5배 이상 = 규정상 운항 가능(**1.5배 폭은 규정이 아닌 시스템 설정값** \`cautionFactor\`)
- 자료가 없거나 오래되면 초록으로 표시하지 않고 "자료없음·직접 확인"
- 공역(R-75·P-73·P-518)과 NOTAM은 기상 판정에 넣지 않고 "주의"로 따로 안내

결과: **${ok} / ${rows.length}건 일치**

| 분류 | 조건 | 기대 판정 | 시스템 판정 | 주의(공역·NOTAM) | 설명 |
|---|---|---|---|---|---|
${rows.map((r) => `| ${r.cat} | ${r.cond} | ${T[r.expect]} | ${T[r.overall]}${r.overall === r.expect ? ' ✔' : ' ✘'} | ${r.expectOps ? `${ops[r.ops]}${r.ops === r.expectOps ? ' ✔' : ' ✘'}` : '-'} | ${r.why || ''} |`).join('\n')}

※ 이 표는 입력 조건에 대한 판정 논리의 검증입니다. 기상청 실시간 자료의 정확도는 기상청 원자료에 따르며, 최종 결정은 출동 지휘 담당자(항공 통제관)와 조종사(기장)가 합니다.
`;
writeFileSync(new URL('../docs/검증사례.md', import.meta.url), md);
console.log(`docs/검증사례.md ${ok}/${rows.length}`);
