import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genNotice, planRoster, planReactAdj, exportReactions, rosterOps, parseNums, expRange, exportSheets, bal, dupNums, excusable, suggestItems, suggestDetails, suggestPeriods, suggestTexts, reasonEvents, nameMatch, planCarry, planGrades, pwLen, sumPts, addPts, sgn, fmtVal } from '../src/logic.js';

// 학생 70명과 기록을 만드는 도우미
function state() {
  const S = { students: [], ledger: [], requests: [], excuses: [], periods: [], presets: [], att: {}, accounts: [] };
  for (let n = 1; n <= 70; n++) S.students.push({ id: 's' + n, no: n, name: '학생' + n, active: true });
  let seq = 0;
  S.add = (date, item, detail, points, nums, extra = {}) =>
    nums.forEach((n) => S.ledger.push({ id: 'e' + ++seq, at: `${date} 09:00`, date, sid: 's' + n, item, detail, points, src: 'manual', revs: [], ...extra }));
  return S;
}

test('공지 문구: 여러 날은 날짜별 소제목, 출석은 교시별, 점수는 항상, 세부내용이 있으면 번호를 매긴다', () => {
  const S = state();
  S.periods.push({ id: 'p7', date: '2026-09-07', label: '1교시', morning: false }, { id: 'p8m', date: '2026-09-08', label: '아침 출석', morning: true }, { id: 'p8', date: '2026-09-08', label: '1교시', morning: false });
  S.add('2026-09-07', '결석', '1교시', 2, [56], { src: 'att', pid: 'p7' });
  S.add('2026-09-08', '지각', '1교시', 1, [14, 4, 7], { src: 'att', pid: 'p8' });
  S.add('2026-09-08', '결석', '1교시', 2, [52], { src: 'att', pid: 'p8' });
  S.add('2026-09-08', '지각', '아침 출석', 1, [4], { src: 'att', pid: 'p8m' });
  S.add('2026-09-08', '실습실 뒷정리 미흡', '전원 안끔', 1, [59, 56]);
  S.add('2026-09-08', '실습실 뒷정리 미흡', '하이 두고감', 1, [31]);
  S.add('2026-09-15', '매점', '', -1, [7, 9]);
  S.add('2026-09-15', '매점', '', -3, [53]);
  assert.equal(
    genNotice(S, '2026-09-07', '2026-09-15'),
    [
      '😿자봉, 상점 공지하겠습니다.',
      '',
      '9/7(월)',
      '[1교시]',
      '결석(+2): 56',
      '',
      '9/8(화)',
      '[아침 출석]',
      '지각(+1): 4',
      '[1교시]',
      '지각(+1): 4, 7, 14',
      '결석(+2): 52',
      '',
      '실습실 뒷정리 미흡(+1)',
      '1. 전원 안끔: 56, 59',
      '2. 하이 두고감: 31',
      '',
      '9/15(화)',
      '매점(-1): 7, 9',
      '',
      '매점(-3): 53',
    ].join('\n'),
  );
});

test('공지 문구: 하루면 머리말에 날짜, 두 교시 지각은 교시마다 따로(합치지 않음), 무효·이월은 빠진다', () => {
  const S = state();
  S.periods.push({ id: 'm', date: '2026-09-22', label: '아침 출석', morning: true }, { id: 'p1', date: '2026-09-22', label: '1교시', morning: false });
  S.add('2026-09-22', '지각', '아침 출석', 1, [8, 17], { src: 'att', pid: 'm' });
  S.add('2026-09-22', '지각', '1교시', 1, [8], { src: 'att', pid: 'p1' });
  S.add('2026-09-22', '결석', '1교시', 2, [56], { src: 'att', pid: 'p1', voided: { reason: '공결 승인' } });
  S.add('2026-09-22', '이월', '', 5, [3], { src: 'carry' });
  assert.equal(genNotice(S, '2026-09-22', '2026-09-22'), '😿 9/22 자봉, 상점 공지하겠습니다.\n[아침 출석]\n지각(+1): 8, 17\n[1교시]\n지각(+1): 8');
});

test('공지 문구: 직접 기록한 지각·결석은 다른 항목처럼, 출석 다음에', () => {
  const S = state();
  S.periods.push({ id: 'm', date: '2026-09-22', label: '아침 출석', morning: true });
  S.add('2026-09-22', '매점', '', -1, [2]);
  S.add('2026-09-22', '결석', '예비군 누락', 2, [5]);
  S.add('2026-09-22', '지각', '아침 출석', 1, [3], { src: 'att', pid: 'm' });
  assert.equal(genNotice(S, '2026-09-22', '2026-09-22'), '😿 9/22 자봉, 상점 공지하겠습니다.\n[아침 출석]\n지각(+1): 3\n\n매점(-1): 2\n\n결석(+2)\n1. 예비군 누락: 5');
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
  assert.deepEqual(summary[0], { no: 1, start: 3, change: 1, end: 4, now: 4 });
  assert.equal(summary[0].end, bal(S, 's1'));
  // 기간 뒤의 기록은 "기간 끝"에는 없고 "지금"에는 있다
  S.add('2026-10-02', '실습', '', 2, [1]);
  assert.deepEqual(exportSheets(S, '2026-09-01', '2026-09-30').summary[0], { no: 1, start: 3, change: 1, end: 4, now: 6 });
  assert.deepEqual(rows.map((r) => [r.item, r.note]), [['지각', '수정됨'], ['결석', '무효 (공결 승인)']]);
  assert.deepEqual(revisions[0].change, '점수: +2 → +1');
  assert.ok(!JSON.stringify({ summary, rows, revisions }).includes('학생1'));
});

test('내보내기 시트: 보관 후 정리의 이월 줄은 기간 안 날짜여도 기간 시작 점수로 센다', () => {
  const S = state();
  // 9/10에 정리해서 그 전 기록이 이월 5점 한 줄로 합쳐진 상태
  S.add('2026-09-10', '이월', '', 5, [1], { src: 'carry' });
  S.add('2026-09-12', '지각', '1교시', 1, [1]);
  assert.deepEqual(exportSheets(S, '2026-09-01', '2026-09-30').summary[0], { no: 1, start: 5, change: 1, end: 6, now: 6 });
  // 이월 날짜가 기간 뒤면 그 기간에는 없던 것
  assert.deepEqual(exportSheets(S, '2026-08-01', '2026-08-31').summary[0], { no: 1, start: 0, change: 0, end: 0, now: 6 });
  // 기간 끝 = 지금 (기간이 모든 기록을 덮으면)
  const all = exportSheets(S, '2026-03-01', '2026-12-31').summary[0];
  assert.equal(all.end, bal(S, 's1'));
});

test('0.5점: 공지 문구, 합계, 명단 붙여넣기', () => {
  const S = state();
  S.add('2026-09-26', '실습', '', 0.5, [3, 1]);
  S.add('2026-09-26', '실습', '', 0.5, [3]);
  S.add('2026-09-26', '매점', '', -1.5, [2]);
  assert.equal(genNotice(S, '2026-09-26', '2026-09-26'), '😿 9/26 자봉, 상점 공지하겠습니다.\n실습(+0.5): 1, 3, 3\n\n매점(-1.5): 2');
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
  // 같은 날 교시가 여럿이면 교시 순서대로
  const T = state();
  T.periods.push({ date: '2026-09-07', label: '3교시 조직학' }, { date: '2026-09-07', label: '1교시 구강해부학' }, { date: '2026-09-07', label: '2교시 생리학' });
  assert.deepEqual(g(suggestPeriods(T, '2026-09-14', '')), ['같은 요일:1교시 구강해부학', '같은 요일:2교시 생리학', '같은 요일:3교시 조직학']);
});

test('입력 추천 · 사유: 앱이 붙인 사유는 빼고, 요청 사유는 내 것만', () => {
  const S = state();
  S.add('2026-09-01', 'x', '', 1, [1], { voided: { reason: '착오', at: '2026-09-01 10:00' } });
  S.add('2026-09-02', 'x', '', 1, [2], { voided: { reason: '착오', at: '2026-09-02 10:00' } });
  S.add('2026-09-03', '결석', '', 2, [3], { src: 'att', voided: { reason: '출석 정정', at: '2026-09-03 10:00' } });
  S.add('2026-09-03', '결석', '', 2, [4], { src: 'att', voided: { reason: '공결 승인 (병원)', at: '2026-09-03 11:00' } });
  S.add('2026-09-05', '지각', '3교시', 1, [6, 7, 8], { src: 'att', voided: { reason: '교시 삭제', at: '2026-09-05 10:00' } });
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

test('명단 붙여넣기: 엑셀(탭)에서는 띄어 쓴 이름도 그대로, 전각 숫자·엑셀 빼기 기호·.5도 읽는다', () => {
  const S = state();
  S.students = [{ id: 'k', no: 1, name: '김 민서', active: true }, { id: 'l', no: 2, name: '이도윤', active: true }];
  S.ledger = [{ id: 'e', sid: 'k', date: '2026-09-01', points: 4, src: 'import', item: '기존 누적' }];
  const p = planRoster(S, '1\t김 민서\t4\n2\t이도윤', true);
  assert.deepEqual([p.changes, p.adjs, p.errors, p.same], [[], [], [], 2], '띄어 쓴 이름을 잘라 새 학생으로 보지 않는다');
  const q = planRoster(S, '１\t김 민서\t−3\n2\t이도윤\t.5', false);
  assert.deepEqual(q.errors, []);
  assert.deepEqual(q.adjs.map((a) => [a.name, a.to]), [['김 민서', -3], ['이도윤', 0.5]]);
  // 손으로 친 줄은 띄어쓰기로 나눈다
  assert.deepEqual(planRoster(S, '3 박하준 2', false).changes.map((c) => [c.kind, c.name, c.no]), [['add', '박하준', 3]]);
});

test('명단 붙여넣기: 자봉 칸이 숫자가 아니면 조용히 넘어가지 않고 알린다', () => {
  const S = state();
  const p = planRoster(S, '1\t학생1\t3점', false);
  assert.match(p.errors[0], /자봉 칸의 "3점"은\(는\) 숫자로만/);
  assert.deepEqual(p.adjs, []);
});

test('공지 문구: 출석 기록을 다른 항목으로 고쳐도 그 교시에 나오고, 10교시는 2교시 뒤', () => {
  const S = state();
  S.periods.push({ id: 'p10', date: '2026-09-22', label: '10교시', morning: false }, { id: 'p2', date: '2026-09-22', label: '2교시', morning: false });
  S.add('2026-09-22', '지각', '10교시', 1, [2], { src: 'att', pid: 'p10' });
  S.add('2026-09-22', '지각', '2교시', 1, [1], { src: 'att', pid: 'p2' });
  S.add('2026-09-22', '조퇴', '2교시', 1, [3], { src: 'att', pid: 'p2' });
  assert.equal(genNotice(S, '2026-09-22', '2026-09-22'), '😿 9/22 자봉, 상점 공지하겠습니다.\n[2교시]\n지각(+1): 1\n조퇴(+1): 3\n[10교시]\n지각(+1): 2');
  const T = state();
  ['10교시', '1교시', '2교시'].forEach((l) => T.periods.push({ date: '2026-09-21', label: l }));
  assert.deepEqual(suggestPeriods(T, '2026-09-28', '').map((x) => x.v), ['1교시', '2교시', '10교시']);
});

test('내보내기 요약: 제외된 학생도 기간에 기록이 있으면 요약에 (날짜별 내역과 맞게)', () => {
  const S = state();
  S.students[11].active = false;
  S.add('2026-09-22', '실습', '', 2, [12]);
  const { summary, rows } = exportSheets(S, '2026-09-01', '2026-09-30');
  assert.ok(rows.some((r) => r.no === '12 (제외)'));
  const r = summary.find((x) => String(x.no).startsWith('12'));
  assert.deepEqual(r, { no: '12 (제외)', start: 0, change: 2, end: 2, now: 2 });
  assert.equal(summary.at(-1).no, '12 (제외)', '재학생 뒤에');
  assert.equal(summary.length, 70);
});

test('제외된 학생의 번호를 다른 학생이 쓰면 공지·날짜별 내역에 "(제외)"로 구분한다', () => {
  const S = state();
  S.students[2].active = false;
  S.students.push({ id: 'n3', no: 3, name: '새학생', active: true });
  S.add('2026-09-23', '청소', '', 1, [3, 5]);
  S.ledger.push({ id: 'x1', at: '2026-09-23 09:00', date: '2026-09-23', sid: 'n3', item: '청소', detail: '', points: 1, src: 'manual', revs: [] });
  assert.equal(genNotice(S, '2026-09-23', '2026-09-23'), '😿 9/23 자봉, 상점 공지하겠습니다.\n청소(+1): 3 (제외), 3, 5');
  assert.deepEqual(exportSheets(S, '2026-09-01', '2026-09-30').rows.map((r) => r.no), ['3 (제외)', 3, 5]);
  // 수정 이력 시트도 같은 표시
  S.ledger.forEach((x) => (x.revs = [{ at: '2026-09-23 10:00', before: { points: 2 }, after: { points: 1 }, reason: '오기' }]));
  assert.deepEqual(exportSheets(S, '2026-09-01', '2026-09-30').revisions.map((r) => r.no).sort(), [3, '3 (제외)', 5].sort());
});

test('명단 붙여넣기: "현재 명단 복사"로 나온 이름 없는 학생 줄은 그대로 둔다', () => {
  const S = state();
  S.students[1].name = '';
  const text = '번호\t이름\t자봉\n' + S.students.map((x) => `${x.no}\t${x.name}\t0`).join('\n');
  const p = planRoster(S, text, true);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.changes, [], '이름 없는 학생도 제외되지 않는다');
  assert.equal(p.same, 70);
  // 그 번호에 이름 없는 학생이 없으면 전처럼 알린다
  assert.match(planRoster(S, '5\t\t0', false).errors[0], /번호와 이름이 모두 있어야 해요/);
});

test('리액션 이월 붙여넣기: 번호·(이름)·횟수, 제목 줄 건너뛰기, 0~2만, 없는 번호·두 번, 바뀌는 학생만', () => {
  const S = state();
  S.reactProg = { s3: 1, s5: 2 };
  const p = planReactAdj(S, '번호\t이름\t이월\n3\t학생3\t2\n5 2\n７\t１\n\n12,0');
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.items, [{ sid: 's3', no: 3, from: 1, to: 2 }, { sid: 's7', no: 7, from: 0, to: 1 }], '5번은 그대로, 12번은 0→0이라 빠짐');
  const bad = planReactAdj(S, '3\t3\n99\t1\n4\t1\n4\t2\n이상한 줄\n8');
  assert.equal(bad.errors.length, 5);
  assert.match(bad.errors[0], /0~2번/);
  assert.match(bad.errors[1], /99번은 명단에 없어요/);
  assert.match(bad.errors[2], /4번이 두 번 있어요/);
  assert.match(bad.errors[3], /이상한 줄.*번호와 이월 횟수/);
  assert.match(bad.errors[4], /"8".*번호와 이월 횟수/);
  S.students[9].active = false;
  assert.match(planReactAdj(S, '10\t1').errors[0], /10번은 명단에 없어요/, '제외된 학생');
});

test('엑셀 리액션 시트: 결과·상점 반영, 반려 사유는 반려일 때만, 제외된 학생 번호 구분', () => {
  const rows = exportReactions([
    { date: '2026-10-26', no: 3, active: true, period: '1교시', q: '질문', a: '대답', status: 'approved', merit: true, note: null },
    { date: '2026-10-26', no: 4, active: false, period: '2교시', q: 'q', a: 'a', status: 'rejected', merit: false, note: '중복' },
    { date: '2026-10-27', no: 5, active: true, period: '3교시', q: 'q', a: 'a', status: 'pending', merit: false, note: '남은 사유' },
  ]);
  assert.deepEqual(rows.map((r) => [r.no, r.result, r.note]), [[3, '승인 · 상점 반영', ''], ['4 (제외)', '반려', '중복'], [5, '대기', '']]);
});

test('이름 찾기: 한글을 치는 중간 모양으로도 찾는다', () => {
  for (const q of ['ㄱ', '고', '곶', '고ㅈ', '고주', '고준', '고줂', '고준ㅎ', '고준흐', '고준희', '준', '주', 'ㅈ', '준희', '줂', '희', '흐', 'ㅎ'])
    assert.ok(nameMatch('고준희', q), q);
  for (const q of ['ㄴ', '곡', '고준희희', '김', 'ㄱㅈ', '고자', '준고', ''])
    assert.ok(!nameMatch('고준희', q), q);
  // 겹모음·겹받침
  for (const q of ['ㄱ', '고', '과', '곽', '곽ㅁ', '곽미', '곽민']) assert.ok(nameMatch('곽민', q), q);
  assert.ok(!nameMatch('곽민', 'ㅘ'), '모음만으로는 글자 중간에서 시작하지 않는다');
  assert.ok(nameMatch('최의진', '최으'));
  assert.ok(nameMatch('최의진', '최의'));
  assert.ok(nameMatch('최의진', '최읮'));
  assert.ok(nameMatch('박영', '박여'));
  assert.ok(nameMatch('박영', '박영'));
  assert.ok(nameMatch('김닭', '김닭'));
  assert.ok(nameMatch('김닭', '김달'));
  assert.ok(nameMatch('김닭', '김ㄷ'));
  // 띄어쓰기·영문
  assert.ok(nameMatch('John Kim', 'johnk'));
  assert.ok(!nameMatch('', 'ㄱ'));
});

test('공지 문구: 여러 시간 수업은 교시 이름 뒤에 시간, 지각·결석은 점수(횟수)별로 작은 것부터, 1시간 교시는 그대로', () => {
  const S = state();
  S.periods.push(
    { id: 'm', date: '2026-10-05', label: '아침 출석', morning: true, hours: 1 },
    { id: 'p3', date: '2026-10-05', label: '1-3교시 구강해부학', morning: false, hours: 3 },
    { id: 'p4', date: '2026-10-05', label: '4교시', morning: false, hours: 1 },
  );
  // 기록 순서를 섞어 넣어도 점수가 작은 것부터
  S.add('2026-10-05', '결석', '1-3교시 구강해부학', 6, [20, 3], { src: 'att', pid: 'p3' });
  S.add('2026-10-05', '지각', '1-3교시 구강해부학', 3, [9], { src: 'att', pid: 'p3' });
  S.add('2026-10-05', '지각', '1-3교시 구강해부학', 1, [12, 2], { src: 'att', pid: 'p3' });
  S.add('2026-10-05', '결석', '1-3교시 구강해부학', 2, [15], { src: 'att', pid: 'p3' });
  S.add('2026-10-05', '지각', '1-3교시 구강해부학', 2, [7], { src: 'att', pid: 'p3' });
  S.add('2026-10-05', '결석', '1-3교시 구강해부학', 4, [30], { src: 'att', pid: 'p3', voided: { reason: '공결 승인' } });
  S.add('2026-10-05', '지각', '아침 출석', 1, [5], { src: 'att', pid: 'm' });
  S.add('2026-10-05', '결석', '4교시', 2, [1], { src: 'att', pid: 'p4' });
  assert.equal(
    genNotice(S, '2026-10-05', '2026-10-05'),
    [
      '😿 10/5 자봉, 상점 공지하겠습니다.',
      '[아침 출석]',
      '지각(+1): 5',
      '[1-3교시 구강해부학 (3시간)]',
      '지각(+1): 2, 12',
      '지각(+2): 7',
      '지각(+3): 9',
      '결석(+2): 15',
      '결석(+6): 3, 20',
      '[4교시]',
      '결석(+2): 1',
    ].join('\n'),
  );
  // 시간 칸이 없는 옛 교시는 1시간으로
  delete S.periods[1].hours;
  assert.match(genNotice(S, '2026-10-05', '2026-10-05'), /\n\[1-3교시 구강해부학\]\n/);
});

test('공지 문구: 한 학생이 한 교시에 지각과 결석을 함께 받으면 두 줄 모두에 나온다', () => {
  const S = state();
  S.periods.push({ id: 'p3', date: '2026-10-06', label: '1-3교시 생리학', morning: false, hours: 3 });
  S.add('2026-10-06', '지각', '1-3교시 생리학', 1, [9], { src: 'att', pid: 'p3' });
  S.add('2026-10-06', '결석', '1-3교시 생리학', 4, [9], { src: 'att', pid: 'p3' });
  S.add('2026-10-06', '결석', '1-3교시 생리학', 4, [4], { src: 'att', pid: 'p3' });
  S.add('2026-10-06', '지각', '1-3교시 생리학', 1, [4], { src: 'att', pid: 'p3', voided: { reason: '출석 정정' } });
  assert.equal(
    genNotice(S, '2026-10-06', '2026-10-06'),
    ['😿 10/6 자봉, 상점 공지하겠습니다.', '[1-3교시 생리학 (3시간)]', '지각(+1): 9', '결석(+4): 4, 9'].join('\n'),
  );
});

test('엑셀 이월 계획: 그날까지 장부 합계 → 엑셀 값, 지울 기록 수(무효 포함), 지금 자봉 = 엑셀 값 + 그 뒤 기록, 검사', () => {
  const S = state();
  S.add('2026-10-20', '지각', '1교시', 1, [5]);
  S.add('2026-10-21', '결석', '1교시', 2, [5], { voided: { reason: '공결 승인' } });
  S.add('2026-10-26', '실습', '', 2, [5]);
  S.add('2026-10-27', '매점', '', -4, [5]);
  S.add('2026-10-28', '매점', '', -1, [6]);
  const p = planCarry(S, '번호\t자봉\n5\t15.0\n6\t-2.50\n\n7 +3', '2026-10-26');
  assert.deepEqual(p.errors, []);
  // 결과 = 엑셀 값 + 다음 날부터의 기록 (그전 장부 점수 3과 지금 자봉 -1은 결과와 상관없다)
  assert.deepEqual(p.items.map(({ no, n, after, del, next }) => ({ no, n, after, del, next })), [
    { no: 5, n: 15, after: -4, del: 3, next: 11 },
    { no: 6, n: -2.5, after: -1, del: 0, next: -3.5 },
    { no: 7, n: 3, after: 0, del: 0, next: 3 },
  ]);
  // 그전 장부 점수가 달라도 결과는 같다
  S.add('2026-10-10', '실습', '', 100, [5]);
  assert.equal(planCarry(S, '5 15', '2026-10-26').items[0].next, 11);
  assert.equal(p.missing.length, 67);
  assert.ok(!p.missing.includes(5));
  const bad = planCarry(S, '5 열다섯\n99 1\n5 1\n6 2\n6 3\n아무말\n8 1.255', '2026-10-26');
  assert.deepEqual(bad.errors, ['1번째 줄 "5 열다섯": 자봉은 0.5점 단위 숫자여야 해요 (예: 15, -2, 0.5)', '99번은 명단에 없어요', '6번이 두 번 있어요', '6번째 줄 "아무말": 번호와 자봉을 적어 주세요', '7번째 줄 "8 1.255": 자봉은 0.5점 단위 숫자여야 해요 (예: 15, -2, 0.5)']);
});

test('시험 성적 붙여넣기: 번호 점수 또는 번호 이름 점수, 이름이 다르면 막고, 빈 점수는 빼고, 평균', () => {
  const S = state();
  S.students[4].name = '홍 길동';
  S.students[69].active = false;
  const p = planGrades(S, '번호\t이름\t점수\n5\t홍길동\t90\n6\t학생6\t75.50\n7 0\n8\t학생8\t\n\n9,학생9,88.25');
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.items.map(({ no, score }) => ({ no, score })), [{ no: 5, score: 90 }, { no: 6, score: 75.5 }, { no: 7, score: 0 }, { no: 9, score: 88.25 }]);
  assert.deepEqual(p.blank, [8]);
  assert.equal(p.avg, 63.44);
  assert.equal(p.missing.length, 64);
  assert.ok(!p.missing.includes(8) && !p.missing.includes(70));
  const bad = planGrades(S, '5 학생6 90\n99 1\n70 1\n6 1\n6 2\n아무말\n7 -3\n8 1.255\n9 90점\n10 10000');
  assert.deepEqual(bad.errors, [
    '5번 이름 "학생6"이 명단(홍 길동)과 달라요',
    '99번은 명단에 없어요',
    '70번은 명단에 없어요',
    '6번이 두 번 있어요',
    '6번째 줄 "아무말": 번호와 점수를 적어 주세요',
    '7번째 줄 "7 -3": 점수는 0 이상의 숫자여야 해요',
    '8번 점수 1.255: 소수점 아래는 둘째 자리까지예요',
    '9번째 줄 "9 90점": 점수는 0 이상의 숫자여야 해요',
    '10번째 줄 "10 10000": 점수는 0 이상의 숫자여야 해요',
  ]);
  assert.deepEqual(bad.items.map((x) => x.no), [6]);
  assert.equal(planGrades(S, '').avg, null);
});

test('비밀번호 ● 개수: 한글은 자판 누른 횟수(자모)로', () => {
  assert.equal(pwLen('고준희'), 8);
  assert.equal(pwLen('홍길동'), 9);
  assert.equal(pwLen('곽'), 4); // ㄱ ㅗ ㅏ ㄱ
  assert.equal(pwLen('닭'), 4); // ㄷ ㅏ ㄹ ㄱ
  assert.equal(pwLen('까'), 2); // Shift+ㄱ ㅏ
  assert.equal(pwLen('ㄱ'), 1);
  assert.equal(pwLen('ㅢ'), 2);
  assert.equal(pwLen('abc12!'), 6);
  assert.equal(pwLen('김a1'), 5);
  assert.equal(pwLen(''), 0);
  assert.equal(pwLen(null), 0);
  assert.equal(pwLen('😀'), 1);
});

test('소수 둘째 자리 점수: 1.15·4.35처럼 부동소수점으로 어긋나는 값도 받고, 합은 오차 없이', () => {
  const S = state();
  // 0.00 ~ 99.99 전부 받는다 (예전에는 1.15 * 100 = 114.99999999999999라서 13%를 거절했다)
  for (let c = 0; c <= 9999; c++) {
    const t = (c / 100).toFixed(2);
    const g = planGrades(S, `1 ${t}`);
    assert.deepEqual(g.errors, [], t);
    assert.equal(g.items[0].score, Number(t));
    // 이월은 장부처럼 0.5점 단위만 (1.15·2.55는 서버 장부가 담지 못한다)
    assert.equal(planCarry(S, `1 -${t}`, '2026-10-26').errors.length, c % 50 === 0 ? 0 : 1, `-${t}`);
  }
  // 앞의 0, 뒤의 0은 괜찮고 셋째 자리부터는 거절
  assert.equal(planGrades(S, '1 0090').items[0].score, 90);
  assert.equal(planGrades(S, '1 008639.120').items[0].score, 8639.12);
  assert.equal(planGrades(S, '1 10000').errors.length, 1);
  assert.equal(planGrades(S, '1 1.155').errors.length, 1);
  assert.equal(planCarry(S, '1 0015', '2026-10-26').items[0].n, 15);
  assert.equal(planCarry(S, '1 2.50', '2026-10-26').items[0].n, 2.5);
  assert.equal(planCarry(S, '1 1.155', '2026-10-26').errors.length, 1);
  assert.deepEqual(planCarry(S, '1 1.15', '2026-10-26').errors, ['1번째 줄 "1 1.15": 자봉은 0.5점 단위 숫자여야 해요 (예: 15, -2, 0.5)']);
  // 합: 1.15 + (-4) = -2.85 (그냥 더하면 -2.8499999999999996), 0.1 + 0.2 = 0.3
  S.add('2026-10-28', '매점', '', -4, [1]);
  S.add('2026-10-29', '이월', '', 0.1, [1]);
  S.add('2026-10-29', '이월', '', 0.2, [1]);
  const c = planCarry(S, '1 1.5', '2026-10-26').items[0];
  assert.deepEqual([c.n, c.after, c.next], [1.5, -3.7, -2.2]);
  assert.equal(bal(S, 's1'), -3.7);
  assert.equal(sumPts([{ points: 0.1 }, { points: 0.2 }]), 0.3);
  assert.equal(addPts(1.15, -4), -2.85);
  const sm = exportSheets(S, '2026-10-29', '2026-10-31').summary[0];
  assert.deepEqual([sm.start, sm.change, sm.end, sm.now], [-4, 0.3, -3.7, -3.7]);
  // 평균은 서버의 round(avg, 2)와 같게: (0.1 + 0.2) / 2 = 0.15, 82.745 → 82.75
  assert.equal(planGrades(S, '1 0.1\n2 0.2').avg, 0.15);
  assert.equal(planGrades(S, '1 82.74\n2 82.75').avg, 82.75);
});

test('경계값 모음 (돌연변이 검사에서 비어 있던 곳)', () => {
  const S = state();
  // 내보내기: 기간 마지막 날의 기록도 요약 변동·날짜별 내역에 들어간다
  S.add('2026-09-30', '실습', '', 2, [1]);
  S.add('2026-10-01', '실습', '', 5, [1]);
  const ex = exportSheets(S, '2026-09-01', '2026-09-30');
  assert.deepEqual([ex.summary[0].change, ex.rows.length], [2, 1]);
  // 학기: 8월은 1학기, 2월은 2학기
  assert.deepEqual(expRange(S, { range: 'sem' }, '2026-08-31'), ['2026-03-01', '2026-08-31', '2026-1학기']);
  assert.deepEqual(expRange(S, { range: 'sem' }, '2027-02-10'), ['2026-09-01', '2027-02-28', '2026-2학기']);
  assert.deepEqual(expRange(S, { range: 'sem' }, '2026-03-01'), ['2026-03-01', '2026-08-31', '2026-1학기']);
  // 엑셀 이월: 공백만 있는 줄은 빈 줄처럼 넘어간다
  assert.deepEqual(planCarry(S, '1 5\n   \n\t\n2 3', '2026-10-26').errors, []);
  // 성적: 번호만 있는 줄은 점수 없음 (번호를 점수로 읽지 않는다)
  const g = planGrades(S, '9\n10 80');
  assert.deepEqual([g.blank, g.items.map((x) => [x.no, x.score])], [[9], [[10, 80]]]);
  // '가'(한글 음절의 맨 처음 글자)도 자모로 나눈다
  assert.equal(pwLen('가'), 2);
  assert.equal(pwLen('힣'), 3); // ㅎ ㅣ ㅎ (U+D7A3, 한글 음절의 맨 끝 글자)
  assert.ok(nameMatch('가윤', 'ㄱ') && nameMatch('가윤', '갸') === false && nameMatch('가윤', '가ㅇ'));
  // 점수 표시: 0은 부호 없이
  assert.deepEqual([sgn(0), sgn(2), sgn(-1.5)], ['0', '+2', '-1.5']);
  // 같은 날 같은 항목 확인: 항목명이 비어 있으면 빈 목록
  assert.deepEqual(dupNums(S, { nums: '1 2', item: '  ', date: '2026-09-30' }), []);
});

test('명단 붙여넣기: 전체 명단 모드에서 이름 없는 학생·번호 맞바꾸기·겹침', () => {
  const S = state();
  // 이름 없는 학생도 붙여넣지 않으면 제외 대상
  S.students[69].name = '';
  const text = S.students.slice(0, 69).map((s) => `${s.no}\t${s.name}`).join('\n');
  const p = planRoster(S, text, true);
  assert.deepEqual(p.changes.map((c) => [c.kind, c.from, c.name]), [['remove', 70, '(이름 없음)']]);
  // 두 학생의 번호를 맞바꾸면 겹침 오류가 없다 (전체 명단·일부 둘 다)
  const swap = S.students.slice(0, 70).map((s) => `${s.no === 1 ? 2 : s.no === 2 ? 1 : s.no}\t${s.name}`).join('\n');
  const q = planRoster(S, swap, true);
  assert.deepEqual(q.errors, []);
  assert.deepEqual(q.changes.map((c) => [c.kind, c.name, c.from, c.no]), [['renum', '학생1', 1, 2], ['renum', '학생2', 2, 1]]);
  assert.deepEqual(planRoster(S, '2\t학생1\n1\t학생2', false).errors, []);
  // 일부만 붙여넣어 남의 번호로 옮기면 겹침 (그 번호의 학생은 그대로라서)
  assert.match(planRoster(S, '2\t학생1', false).errors[0], /2번이 두 명\(학생2, 학생1\)에게 겹쳐요/);
  // 전체 명단에서 빠진 학생의 번호는 새 학생이 써도 된다
  const r = planRoster(S, S.students.slice(1, 69).map((s) => `${s.no}\t${s.name}`).join('\n') + '\n1\t새학생', true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.changes.map((c) => c.kind).sort(), ['add', 'remove', 'remove']);
  // 같은 이름·같은 번호로 다시 붙여넣은 학생은 변경 없음 (겹침 검사에서 자기 자신과 겹치지 않는다)
  assert.deepEqual(planRoster(S, '3\t학생3\n4\t학생4', false), { changes: [], adjs: [], errors: [], same: 2 });
});

test('경계값 모음 2: 수정 이력 표시, 직접 고른 기간, 기간 마지막 날의 이월·수정 이력, 이월 미리보기 이름', () => {
  const S = state();
  // 수정 이력: 비어 있으면 "없음", 있으면 그 글자, 점수는 부호
  assert.deepEqual([fmtVal('detail', ''), fmtVal('detail', '전원 안 끔'), fmtVal('points', 2), fmtVal('date', '2026-09-30')], ['없음', '전원 안 끔', '+2', '9/30']);
  // 직접 고른 기간
  assert.deepEqual(expRange(S, { range: 'custom', from: '2026-09-01', to: '2026-09-15' }, '2026-10-01'), ['2026-09-01', '2026-09-15', '2026-09-01~2026-09-15']);
  assert.deepEqual(expRange(S, { range: 'custom', from: '', to: '' }, '2026-10-01'), ['2026-10-01', '2026-10-01', '2026-10-01~2026-10-01']);
  // 기간 마지막 날의 보관 이월은 기간 시작 점수로, 그날의 수정 이력도 시트에 들어간다
  S.add('2026-09-30', '이월', '9/30까지 합계', 7, [1], { src: 'carry' });
  S.add('2026-09-30', '실습', '', 1, [2], { revs: [{ at: '2026-10-01 09:00', before: { points: 2 }, after: { points: 1 }, reason: '착오' }] });
  const ex = exportSheets(S, '2026-09-01', '2026-09-30');
  assert.deepEqual([ex.summary[0].start, ex.summary[0].change], [7, 0]);
  assert.deepEqual(ex.revisions.map((r) => [r.date, r.no, r.change, r.reason]), [['2026-09-30', 2, '점수: +2 → +1', '착오']]);
  // 이월 미리보기에 그 학생 이름
  assert.equal(planCarry(S, '3 5', '2026-10-26').items[0].name, '학생3');
});

test('경계값 모음 3: 기간 첫날, 명단 제외 작업, 빈 공지, 번호 없는 줄, 앞에 쉼표', () => {
  const S = state();
  // 내보내기: 기간 첫날의 기록도 날짜별 내역에 들어간다
  S.add('2026-09-01', '실습', '', 1, [1]);
  S.add('2026-08-31', '실습', '', 1, [1]);
  assert.deepEqual(exportSheets(S, '2026-09-01', '2026-09-30').rows.map((r) => r.date), ['2026-09-01']);
  // 명단 적용 작업: 제외는 remove로, 번호 바꾸기는 그 번호로, 추가는 이름과 번호로
  const plan = planRoster(S, S.students.slice(1, 70).map((x) => `${x.no === 2 ? 71 : x.no}\t${x.name}`).join('\n') + '\n72\t새학생', true);
  const ops = rosterOps(plan).ops;
  assert.deepEqual(ops.filter((o) => o.op === 'remove'), [{ op: 'remove', id: 's1' }]);
  assert.deepEqual(ops.filter((o) => o.op !== 'remove').map((o) => [o.op, o.no]).sort(), [['add', 72], ['renum', 71]]);
  // 공지: 기간에 기록이 없으면 안내 문구
  assert.equal(genNotice(state(), '2026-09-01', '2026-09-02'), '해당 기간에 기록이 없어요.');
  // 명단: 이름만 있고 번호가 없는 줄은 조용히 넘기지 않고 알린다 (머리줄만 넘긴다)
  assert.match(planRoster(S, '새학생', false).errors[0], /번호와 이름이 모두 있어야 해요/);
  assert.deepEqual(planRoster(S, '번호\t이름', false).errors, []);
  // 학생 찾기: 앞뒤 쉼표·공백이 있어도
  assert.deepEqual(parseNums(S, ' ,1, 2 ,'), { sids: ['s1', 's2'], bad: [] });
});
