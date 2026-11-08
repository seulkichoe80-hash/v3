import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { criteriaTable, art22Items, msToKt } from '../../web/rules.js';

const config = JSON.parse(readFileSync(new URL('../../config.json', import.meta.url)));

test('msToKt', () => { assert.equal(msToKt(6.5), 13); assert.equal(msToKt(0), 0); assert.equal(msToKt(null), null); assert.equal(msToKt(10), 19); });

test('판정 기준표: 규정 조문값과 시스템 설정값을 구분하고 config 값에서 만든다', () => {
  const t = criteriaTable(config);
  const reg = JSON.stringify(t.regulation), set = JSON.stringify(t.settings);
  for (const v of ['3200', '4800', '1000', '1500', '2000']) assert.ok(reg.includes(v), '규정표에 ' + v);
  assert.ok(reg.includes('제21조'));
  assert.ok(!reg.includes('1.5배'), '1.5배는 규정이 아님');
  assert.ok(set.includes('중하층')); assert.ok(set.includes('1.5')); assert.ok(set.includes('90')); assert.ok(set.includes('20km')); assert.ok(set.includes('TEMPO'));
  // config를 바꾸면 표시도 바뀐다
  const c2 = JSON.parse(JSON.stringify(config)); c2.cautionFactor = undefined; c2.limits.cautionFactor = 1.3; c2.freshnessMin.metar = 60;
  const s2 = JSON.stringify(criteriaTable(c2).settings); assert.ok(s2.includes('1.3')); assert.ok(s2.includes('60'));
});

test('제22조 확인표', () => {
  assert.deepEqual(art22Items({ isNight: false, isSea: false }), []);
  const n = art22Items({ isNight: true, isSea: false });
  assert.equal(n.length, 1); assert.match(n[0].title, /제22조①/); assert.ok(n[0].items.some((x) => x.includes('야간투시경'))); assert.ok(n[0].items.some((x) => x.includes('조명')));
  assert.match(n[0].proviso, /긴급운항/);
  const s = art22Items({ isNight: false, isSea: true });
  assert.deepEqual(s.map((g) => g.title.slice(0, 5)), ['제22조④', '제22조⑤']);
  assert.ok(s[0].items.some((x) => x.includes('구명조끼'))); assert.ok(s[0].items.some((x) => x.includes('체온보호용 슈트'))); assert.ok(s[1].items.some((x) => x.includes('구명보트')));
  assert.equal(art22Items({ isNight: true, isSea: true }).length, 3);
});
