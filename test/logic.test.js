import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genNotice, planRoster, rosterOps, parseNums, expRange, exportSheets, bal, dupNums, excusable } from '../src/logic.js';

// 학생 70명과 기록을 만드는 도우미
function state() {
  const S = { students: [], ledger: [], requests: [], excuses: [], periods: [], presets: [], att: {}, accounts: [] };
  for (let n = 1; n <= 70; n++) S.students.push({ id: 's' + n, no: n, name: '학생' + n, active: true });
  let seq = 0;
  S.add = (date, item, detail, points, nums, extra = {}) =>
    nums.forEach((n) => S.ledger.push({ id: 'e' + ++seq, at: `${date} 09:00`, date, sid: 's' + n, item, detail, points, src: 'manual', revs: [], ...extra }));
  return S;
}

test('공지 문구: 여러 날은 날짜별 소제목, 세부내용이 있으면 번호를 매긴다', () => {
  const S = state();
  S.add('2026-09-07', '결석', '1교시', 2, [56], { src: 'att' });
  S.add('2026-09-08', '지각', '1교시', 1, [4, 7, 14], { src: 'att' });
  S.add('2026-09-08', '결석', '1교시', 2, [52], { src: 'att' });
  S.add('2026-09-08', '실습실 뒷정리 미흡', '전원 안끔', 1, [56, 59]);
  S.add('2026-09-08', '실습실 뒷정리 미흡', '하이 두고감', 1, [31]);
  S.add('2026-09-15', '매점', '', -1, [7, 9]);
  S.add('2026-09-15', '매점', '', -3, [53]);
  assert.equal(
    genNotice(S, '2026-09-07', '2026-09-15'),
    [
      '😿자봉, 상점 공지하겠습니다.',
      '',
      '9/7(월)',
      '결석: 56(+2)',
      '',
      '9/8(화)',
      '지각: 4 7 14',
      '결석: 52(+2)',
      '',
      '실습실 뒷정리 미흡(+1)',
      '1. 전원 안끔: 56, 59',
      '2. 하이 두고감: 31',
      '',
      '9/15(화)',
      '',
      '매점: 7, 9 (-1)',
      '',
      '매점: 53 (-3)',
    ].join('\n'),
  );
});

test('공지 문구: 하루면 머리말에 날짜, 같은 날 두 교시 지각은 (+2), 무효·이월은 빠진다', () => {
  const S = state();
  S.add('2026-09-22', '지각', '아침 출석', 1, [8, 17], { src: 'att' });
  S.add('2026-09-22', '지각', '1교시', 1, [8], { src: 'att' });
  S.add('2026-09-22', '결석', '1교시', 2, [56], { src: 'att', voided: { reason: '공결 승인' } });
  S.add('2026-09-22', '이월', '', 5, [3], { src: 'carry' });
  assert.equal(genNotice(S, '2026-09-22', '2026-09-22'), '😿 9/22 자봉, 상점 공지하겠습니다.\n지각: 8(+2) 17');
});

test('번호·이름으로 학생 찾기', () => {
  const S = state();
  const r = parseNums(S, '56, 학생3 999 없는사람 56');
  assert.deepEqual(r.sids, ['s56', 's3']);
  assert.deepEqual(r.bad, ['999', '없는사람']);
});

test('중복 요청 경고', () => {
  const S = state();
  S.add('2026-09-25', '매점', '', -1, [5]);
  S.requests.push({ status: 'pending', date: '2026-09-25', item: '매점', sids: ['s6'] });
  assert.deepEqual(dupNums(S, { nums: '5 6 7', item: '매점', date: '2026-09-25' }), [5, 6]);
});

test('명단 붙여넣기: 번호 맞바꾸기, 추가, 자봉 조정', () => {
  const S = state();
  S.add('2026-09-01', '기존 누적', '', 2, [1]);
  const plan = planRoster(S, '번호\t이름\t자봉\n1\t학생2\n2\t학생1\t5\n71\t새학생\t-1', false);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(
    plan.changes.map((c) => [c.kind, c.name, c.no]),
    [['renum', '학생2', 1], ['renum', '학생1', 2], ['add', '새학생', 71]],
  );
  assert.deepEqual(plan.adjs.map((a) => [a.name, a.from, a.to]), [['학생1', 2, 5], ['새학생', 0, -1]]);
  const { ops, adjs } = rosterOps(plan);
  assert.deepEqual(ops[2], { op: 'add', name: '새학생', no: 71 });
  assert.deepEqual(adjs, [{ name: '학생1', to: 5 }, { name: '새학생', to: -1 }]);
});

test('명단 붙여넣기: 번호가 겹치거나 이름이 두 번이면 막는다', () => {
  const S = state();
  assert.match(planRoster(S, '5\t새학생', false).errors[0], /5번이 두 명/);
  assert.match(planRoster(S, '71\t가\n72\t가', false).errors[0], /같은 이름/);
  assert.match(planRoster(S, '71', false).errors[0], /번호와 이름/);
});

test('명단 붙여넣기: 전체 명단 모드는 빠진 학생을 제외한다', () => {
  const S = state();
  const text = S.students.slice(0, 68).map((s) => `${s.no}\t${s.name}`).join('\n');
  const plan = planRoster(S, text, true);
  assert.deepEqual(plan.changes.map((c) => [c.kind, c.from]), [['remove', 69], ['remove', 70]]);
  assert.equal(plan.same, 68);
});

test('내보내기 기간', () => {
  const S = state();
  S.add('2026-03-04', 'x', '', 1, [1]);
  assert.deepEqual(expRange(S, { range: 'month' }, '2026-09-25'), ['2026-09-01', '2026-09-30', '2026-09']);
  assert.deepEqual(expRange(S, { range: 'last' }, '2026-01-10'), ['2025-12-01', '2025-12-31', '2025-12']);
  assert.deepEqual(expRange(S, { range: 'sem' }, '2026-09-25'), ['2026-09-01', '2027-02-28', '2026-2학기']);
  assert.deepEqual(expRange(S, { range: 'sem' }, '2027-01-05'), ['2026-09-01', '2027-02-28', '2026-2학기']);
  assert.deepEqual(expRange(S, { range: 'sem' }, '2026-04-01'), ['2026-03-01', '2026-08-31', '2026-1학기']);
  assert.deepEqual(expRange(S, { range: 'all' }, '2026-09-25'), ['2026-03-04', '2026-09-25', '전체']);
});

test('내보내기 시트: 기간 시작·변동·현재 자봉, 이름은 넣지 않는다', () => {
  const S = state();
  S.add('2026-08-30', '기존 누적', '', 3, [1]);
  S.add('2026-09-02', '지각', '1교시', 1, [1]);
  S.add('2026-09-03', '결석', '1교시', 2, [1], { voided: { reason: '공결 승인' } });
  S.ledger[1].revs = [{ at: '2026-09-02 21:00', before: { points: 2 }, after: { points: 1 }, reason: '오기' }];
  const { summary, rows, revisions } = exportSheets(S, '2026-09-01', '2026-09-30');
  assert.deepEqual(summary[0], { no: 1, start: 3, change: 1, end: 4 });
  assert.equal(summary[0].end, bal(S, 's1'));
  assert.deepEqual(rows.map((r) => [r.item, r.note]), [['지각', '수정됨'], ['결석', '무효 (공결 승인)']]);
  assert.deepEqual(revisions[0].change, '점수: +2 → +1');
  assert.ok(!JSON.stringify({ summary, rows, revisions }).includes('학생1'));
});

test('0.5점: 공지 문구, 합계, 명단 붙여넣기', () => {
  const S = state();
  S.add('2026-09-26', '실습', '', 0.5, [3, 1]);
  S.add('2026-09-26', '실습', '', 0.5, [3]);
  S.add('2026-09-26', '매점', '', -1.5, [2]);
  assert.equal(genNotice(S, '2026-09-26', '2026-09-26'), '😿 9/26 자봉, 상점 공지하겠습니다.\n실습: 1, 3 (+0.5)\n\n매점: 2 (-1.5)');
  assert.equal(bal(S, 's3'), 1);
  const ok = planRoster(S, '1\t학생1\t2.5', false);
  assert.deepEqual(ok.adjs.map((a) => [a.from, a.to, a.delta]), [[0.5, 2.5, 2]]);
  assert.match(planRoster(S, '1\t학생1\t2.3', false).errors[0], /0\.5점 단위/);
});

test('공결 신청 대상: 출석 체크든 직접 기록이든 무효가 아닌 지각·결석', () => {
  const S = state();
  S.add('2026-09-26', '결석', '1교시', 2, [1], { src: 'att' });
  S.add('2026-09-26', '결석', '', 2, [1]);
  S.add('2026-09-26', '지각', '', 1, [1], { src: 'request' });
  S.add('2026-09-26', '지각', '', 1, [1], { voided: { reason: 'x' } });
  S.add('2026-09-26', '실습', '', 1, [1]);
  S.add('2026-09-01', '결석', '', 2, [1], { src: 'import' });
  assert.deepEqual(S.ledger.filter(excusable).map((e) => e.id), ['e1', 'e2', 'e3']);
});

test('백업 암호화: 같은 암호로만 풀린다', async () => {
  const { encryptBackup, decryptBackup } = await import('../src/backupcrypt.js');
  const dump = { format: 'jabong-backup', version: 1, createdAt: '2026-09-27 03:00', tables: { students: [{ no: 1, name: '김민서' }] } };
  const file = await encryptBackup(dump, '백업암호1234');
  assert.ok(!JSON.stringify(file).includes('김민서'));
  assert.deepEqual(await decryptBackup(JSON.parse(JSON.stringify(file)), '백업암호1234'), dump);
  await assert.rejects(decryptBackup(file, '틀린암호'), /암호가 맞지 않아요/);
});
