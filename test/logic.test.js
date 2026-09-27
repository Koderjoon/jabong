import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genNotice, planRoster, rosterOps, parseNums, expRange, exportSheets, bal, dupNums, excusable, suggestItems, suggestDetails, suggestPeriods, suggestTexts, reasonEvents } from '../src/logic.js';

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
  // 날짜를 앞으로 적은 기록이 있으면 그 날짜까지 (정리 전에 받는 전체 파일에서 빠지면 안 된다)
  S.add('2026-10-02', 'x', '', 1, [1]);
  assert.deepEqual(expRange(S, { range: 'all' }, '2026-09-25'), ['2026-03-04', '2026-10-02', '전체']);
  assert.deepEqual(expRange(state(), { range: 'all' }, '2026-09-25'), ['2026-09-25', '2026-09-25', '전체']);
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

test('입력 추천 · 항목: 내가 최근에 쓴 것 → 자주 쓴 것, 항목과 점수를 함께, 여러 명에게 한 번 적은 것은 한 번', () => {
  const S = state();
  S.add('2026-09-01', '매점', '', -1, [1], { at: '2026-09-01 10:00', by: '부총대' });
  S.add('2026-09-02', '매점', '', -1, [2], { at: '2026-09-02 10:00', by: '부총대' });
  S.add('2026-09-03', '실습실 뒷정리 미흡', '전원 안끔', 1, [3, 4, 5, 6, 7], { at: '2026-09-03 10:00', by: '부총대' });
  S.add('2026-09-04', '청소 불참', '', 2, [8], { at: '2026-09-04 10:00', src: 'request', by: '학습부장' });
  S.add('2026-09-05', '오타항목', '', 1, [9], { at: '2026-09-05 10:00', by: '부총대', voided: { reason: '착오' } });
  S.add('2026-09-05', '지각', '1교시', 1, [10], { at: '2026-09-05 11:00', src: 'att', by: '부총대' });
  S.requests.push({ item: '봉사', detail: '', points: -2, at: '2026-09-06 10:00', by: '학습부장', status: 'pending' });
  S.requests.push({ item: '청소 불참', detail: '', points: 2, at: '2026-09-04 10:00', by: '학습부장', status: 'approved' });
  const show = (l) => l.map((x) => `${x.g}:${x.v}${x.pts}`);
  // 부총대: 최근은 내가 적은 것 (무효·출석 자동 기록 제외), 자주는 반 전체에서 두 번 이상
  const admin = suggestItems(S, '부총대', '', 1);
  assert.deepEqual(show(admin.filter((x) => x.g === '최근')), ['최근:실습실 뒷정리 미흡1', '최근:매점-1']);
  assert.deepEqual(show(admin.filter((x) => x.g === '자주')), [], '두 번 이상 쓴 매점은 이미 최근에 있다');
  // 학습부장: 최근은 내 요청 (대기 중 포함, 승인된 요청은 기록과 겹치지 않게 한 번)
  assert.deepEqual(show(suggestItems(S, '학습부장', '', 1).filter((x) => x.g === '최근')), ['최근:봉사-2', '최근:청소 불참2']);
  assert.deepEqual(show(suggestItems(S, '학습부장', '', 1).filter((x) => x.g === '자주')), ['자주:매점-1']);
  // 처음 쓰는 사람: 최근은 반 전체
  assert.equal(suggestItems(S, '총무', '', 1)[0].v, '봉사');
  assert.ok(!suggestItems(S, '부총대', '', 1).some((x) => ['오타항목', '지각'].includes(x.v)));
  // 치는 중: 글자가 들어간 것만, 지금 적힌 값(항목+점수)과 똑같은 것은 빼고
  assert.deepEqual(show(suggestItems(S, '부총대', '청소', 1)), [':청소 불참2']);
  assert.deepEqual(show(suggestItems(S, '부총대', '매점', -1)), []);
  assert.deepEqual(show(suggestItems(S, '부총대', '매점', 1)), [':매점-1'], '점수가 다르면 눌러서 점수를 맞출 수 있게');
});

test('입력 추천: 같은 분에 적은 것은 나중에 적은 것이 더 최근', () => {
  const S = state();
  S.add('2026-09-01', '가', '', 1, [1], { at: '2026-09-01 10:00', by: '부총대' });
  S.add('2026-09-01', '나', '', 1, [2], { at: '2026-09-01 10:00', by: '부총대' });
  assert.deepEqual(suggestItems(S, '부총대', '', 1).map((x) => x.v), ['나', '가']);
});

test('입력 추천 · 세부내용: 같은 항목의 세부내용 먼저', () => {
  const S = state();
  S.add('2026-09-01', '실습실 뒷정리 미흡', '전원 안끔', 1, [1], { at: '2026-09-01 10:00', by: '부총대' });
  S.add('2026-09-02', '실습실 뒷정리 미흡', '기구 방치', 1, [2], { at: '2026-09-02 10:00', by: '부총대' });
  S.add('2026-09-03', '매점', '음료', -1, [3], { at: '2026-09-03 10:00', by: '부총대' });
  assert.deepEqual(suggestDetails(S, '부총대', '실습실 뒷정리 미흡', '').map((x) => x.v), ['기구 방치', '전원 안끔']);
  assert.deepEqual(suggestDetails(S, '부총대', '', '').map((x) => x.v), ['음료', '기구 방치', '전원 안끔']);
  assert.deepEqual(suggestDetails(S, '부총대', '새 항목', '').map((x) => x.v), ['음료', '기구 방치', '전원 안끔'], '처음 쓰는 항목이면 전체에서');
  assert.deepEqual(suggestDetails(S, '부총대', '', '전원').map((x) => x.v), ['전원 안끔']);
});

test('입력 추천 · 교시: 같은 요일 → 최근 → 자주, 그 날짜에 이미 있는 교시는 뺀다', () => {
  const S = state();
  const p = (date, label, morning = false) => S.periods.push({ id: date + label, date, label, morning });
  p('2026-09-07', '아침 출석', true); // 월
  p('2026-09-07', '1교시 구강해부학');
  p('2026-09-08', '1교시 생리학'); // 화
  p('2026-09-14', '1교시 구강해부학'); // 월
  p('2026-09-14', '3교시 조직학'); // 월
  p('2026-09-15', '1교시 생리학'); // 화
  p('2026-09-16', '2교시 약리학'); // 수
  p('2026-09-21', '3교시 조직학'); // 월 (그날 이미 있음)
  const g = (l) => l.map((x) => `${x.g}:${x.v}`);
  assert.deepEqual(g(suggestPeriods(S, '2026-09-21', '')), ['같은 요일:1교시 구강해부학', '최근:2교시 약리학', '최근:1교시 생리학']);
  assert.deepEqual(g(suggestPeriods(S, '2026-09-22', '')), ['같은 요일:1교시 생리학', '최근:3교시 조직학', '최근:2교시 약리학', '최근:1교시 구강해부학']);
  assert.deepEqual(g(suggestPeriods(S, '2026-09-22', '교시 조')), [':3교시 조직학']);
  assert.ok(!suggestPeriods(S, '2026-09-22', '').some((x) => x.v === '아침 출석'));
});

test('입력 추천 · 사유: 앱이 붙인 사유는 빼고, 요청 사유는 내 것만', () => {
  const S = state();
  S.add('2026-09-01', 'x', '', 1, [1], { voided: { reason: '착오', at: '2026-09-01 10:00' } });
  S.add('2026-09-02', 'x', '', 1, [2], { voided: { reason: '착오', at: '2026-09-02 10:00' } });
  S.add('2026-09-03', '결석', '', 2, [3], { src: 'att', voided: { reason: '출석 정정', at: '2026-09-03 10:00' } });
  S.add('2026-09-03', '결석', '', 2, [4], { src: 'att', voided: { reason: '공결 승인 (병원)', at: '2026-09-03 11:00' } });
  S.add('2026-09-04', 'x', '', 1, [5], { revs: [{ reason: '오기', at: '2026-09-04 10:00' }, { reason: '점수 정정', at: '2026-09-04 11:00' }] });
  S.requests.push({ reason: '청소 안 함', by: '학습부장', at: '2026-09-01 10:00', note: '중복', reviewedAt: '2026-09-02 10:00' }, { reason: '남의 사유', by: '총무', at: '2026-09-01 10:00' });
  S.excuses.push({ note: '증빙 필요', at: '2026-09-01 10:00', reviewedAt: '2026-09-03 10:00' });
  const v = (kind, me) => suggestTexts(reasonEvents(S, kind, me), '').map((x) => `${x.g}:${x.v}`);
  assert.deepEqual(v('voidReason'), ['최근:착오']);
  assert.deepEqual(v('editReason'), ['최근:점수 정정', '최근:오기']);
  assert.deepEqual(v('note'), ['최근:증빙 필요', '최근:중복']);
  assert.deepEqual(v('reqReason', '학습부장'), ['최근:청소 안 함']);
  assert.deepEqual(suggestTexts(reasonEvents(S, 'voidReason'), '착오'), [], '이미 적은 값과 같으면 띄우지 않는다');
});
