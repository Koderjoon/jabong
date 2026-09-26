// 화면과 서버에 의존하지 않는 계산 로직. 유닛 테스트는 이 파일만 대상으로 한다.
// S는 서버의 public_state()/private_state()가 돌려준 상태 객체다.

export const DOW = ['일', '월', '화', '수', '목', '금', '토'];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const sgn = (p) => (p > 0 ? '+' : '') + p;
export const md = (d) => {
  const [, m, dd] = d.split('-');
  return `${+m}/${+dd}`;
};
export const mdw = (d) => `${md(d)}(${DOW[new Date(d + 'T00:00:00').getDay()]})`;

// 서울 기준 오늘 (YYYY-MM-DD)
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());

export const live = (e) => !e.voided;
// 직접 입력하는 점수는 0.5점 단위까지 허용한다 (출석 자동 기록은 정수)
// 공결 신청할 수 있는 기록: 무효가 아닌 지각·결석 (출석 체크든 직접 기록이든)
export const excusable = (e) => !e.voided && (e.item === '지각' || e.item === '결석') && ['att', 'manual', 'request'].includes(e.src);
export const isHalfStep = (p) => Number.isFinite(p) && Number.isInteger(p * 2);
export const stu = (S, id) => S.students.find((s) => s.id === id);
export const noOf = (S, id) => stu(S, id)?.no ?? '?';
export const active = (S) => S.students.filter((s) => s.active).sort((a, b) => a.no - b.no);
export const bal = (S, sid) => S.ledger.filter((e) => e.sid === sid && live(e)).reduce((a, e) => a + Number(e.points), 0);

// "56 59 김민서" 같은 입력을 학생 id 목록으로 바꾼다. 숫자는 번호, 나머지는 이름으로 찾는다.
export function parseNums(S, str) {
  const sids = [];
  const bad = [];
  (str || '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .forEach((t) => {
      const byName = S.students.filter((x) => x.active && x.name === t);
      const s = /^\d+$/.test(t)
        ? S.students.find((x) => x.active && x.no === Number(t))
        : byName.length === 1
          ? byName[0]
          : null;
      if (s) {
        if (!sids.includes(s.id)) sids.push(s.id);
      } else bad.push(t);
    });
  return { sids, bad };
}

// 같은 날짜·항목으로 이미 대기 중인 요청이 있거나 기록된 학생 번호
export function dupNums(S, f) {
  const { sids } = parseNums(S, f.nums);
  const item = f.item.trim();
  if (!item) return [];
  return sids
    .filter(
      (id) =>
        S.requests.some((r) => r.status === 'pending' && r.date === f.date && r.item === item && r.sids.includes(id)) ||
        S.ledger.some((e) => live(e) && e.date === f.date && e.item === item && e.sid === id),
    )
    .map((id) => noOf(S, id));
}

// 카톡 공지 문구. 기존에 손으로 쓰던 형식을 그대로 따른다.
//   하루: "😿 9/22 자봉, 상점 공지하겠습니다." / 여러 날: 머리말 + 날짜별 소제목
//   지각은 번호만(2회 이상이면 (+2)), 결석은 항상 (+2), 나머지는 항목·점수별로 묶고 세부내용이 있으면 번호를 매긴다.
export function genNotice(S, from, to) {
  const es = S.ledger.filter((e) => live(e) && !['import', 'carry'].includes(e.src) && e.date >= from && e.date <= to);
  const dates = [...new Set(es.map((e) => e.date))].sort();
  if (!dates.length) return '해당 기간에 기록이 없어요.';
  const multi = dates.length > 1;
  const no = (id) => noOf(S, id);
  const out = [multi ? '😿자봉, 상점 공지하겠습니다.' : `😿 ${md(dates[0])} 자봉, 상점 공지하겠습니다.`];
  const nums = (l) => [...new Set(l.map((e) => no(e.sid)))].sort((a, b) => a - b);
  dates.forEach((d) => {
    const de = es.filter((e) => e.date === d);
    const blk = [];
    const attLine = (name, always) => {
      const m = new Map();
      de.filter((e) => e.item === name).forEach((e) => m.set(e.sid, (m.get(e.sid) || 0) + Number(e.points)));
      if (!m.size) return;
      blk.push(
        `${name}: ` +
          [...m]
            .sort((a, b) => no(a[0]) - no(b[0]))
            .map(([sid, p]) => (always || p !== 1 ? `${no(sid)}(${sgn(p)})` : `${no(sid)}`))
            .join(' '),
      );
    };
    attLine('지각', false);
    attLine('결석', true);
    const groups = new Map();
    de.filter((e) => e.item !== '지각' && e.item !== '결석').forEach((e) => {
      const k = e.item + '|' + e.points;
      if (!groups.has(k)) groups.set(k, { item: e.item, points: Number(e.points), es: [] });
      groups.get(k).es.push(e);
    });
    groups.forEach((g) => {
      blk.push('');
      if (!g.es.some((e) => e.detail)) blk.push(`${g.item}: ${nums(g.es).join(', ')} (${sgn(g.points)})`);
      else {
        blk.push(`${g.item}(${sgn(g.points)})`);
        const dm = new Map();
        g.es.forEach((e) => {
          const k = e.detail || '기타';
          if (!dm.has(k)) dm.set(k, []);
          dm.get(k).push(e);
        });
        let i = 1;
        dm.forEach((l, k) => blk.push(`${i++}. ${k}: ${nums(l).join(', ')}`));
      }
    });
    if (multi) out.push('', mdw(d), ...blk);
    else {
      if (blk[0] === '') blk.shift();
      out.push(...blk);
    }
  });
  return out.join('\n');
}

// 엑셀에서 붙여넣은 "번호 이름 [자봉]" 명단을 현재 명단과 비교해 바뀔 내용을 만든다.
// 학생은 이름으로 알아본다. 그래야 번호가 바뀌어도 기록이 따라간다.
export function planRoster(S, text, replace) {
  const rows = [];
  const errors = [];
  text.split('\n').forEach((line, i) => {
    const cells = line
      .split(/[\t,]+|\s+/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (!cells.length) return;
    const NUM = /^[+-]?\d+(\.\d+)?$/;
    const ni = cells.findIndex((c) => /^\d+$/.test(c));
    const num = cells[ni];
    const name = cells.find((c) => !NUM.test(c));
    const score = cells.find((c, j) => j !== ni && NUM.test(c));
    if (!num && /번호|이름|성명/.test(line)) return;
    if (!num || !name) {
      errors.push(`${i + 1}번째 줄 "${line.trim()}": 번호와 이름이 모두 있어야 해요`);
      return;
    }
    if (score != null && !isHalfStep(Number(score))) {
      errors.push(`${i + 1}번째 줄 "${line.trim()}": 자봉은 0.5점 단위로 적어 주세요`);
      return;
    }
    rows.push({ no: Number(num), name, score: score == null ? null : Number(score) });
  });
  const dupBy = (k) => rows.filter((r, i) => rows.findIndex((x) => x[k] === r[k]) !== i).map((r) => r[k]);
  [...new Set(dupBy('name'))].forEach((n) => errors.push(`같은 이름이 두 번 이상 있어요: ${n} (동명이인이면 "김민서A"처럼 구분해 주세요)`));
  [...new Set(dupBy('no'))].forEach((n) => errors.push(`${n}번이 두 번 이상 있어요`));
  const changes = [];
  const adjs = [];
  let same = 0;
  rows.forEach((r) => {
    const m = S.students.filter((x) => x.name === r.name);
    if (m.length > 1) {
      errors.push(`기존 명단에 같은 이름이 여러 명 있어요: ${r.name} (하나씩 고치기에서 이름을 구분해 주세요)`);
      return;
    }
    const st = m[0];
    if (!st) changes.push({ kind: 'add', name: r.name, no: r.no });
    else if (!st.active) changes.push({ kind: 'restore', sid: st.id, name: r.name, no: r.no });
    else if (st.no !== r.no) changes.push({ kind: 'renum', sid: st.id, name: r.name, from: st.no, no: r.no });
    else same++;
    if (r.score != null) {
      const cur = st ? bal(S, st.id) : 0;
      if (cur !== r.score) adjs.push({ name: r.name, from: cur, to: r.score, delta: r.score - cur });
    }
  });
  const named = new Set(rows.map((r) => r.name));
  if (replace)
    active(S)
      .filter((x) => !named.has(x.name))
      .forEach((x) => changes.push({ kind: 'remove', sid: x.id, name: x.name || '(이름 없음)', from: x.no }));
  // 적용 후 번호가 겹치는지 확인
  const touched = new Set(changes.map((c) => c.sid).filter(Boolean));
  const final = new Map();
  active(S)
    .filter((x) => !touched.has(x.id) && !named.has(x.name))
    .forEach((x) => final.set(x.no, x.name || '(이름 없음)'));
  changes
    .filter((c) => c.kind !== 'remove')
    .concat(rows.filter((r) => S.students.some((x) => x.active && x.name === r.name && x.no === r.no)).map((r) => ({ no: r.no, name: r.name })))
    .forEach((c) => {
      if (final.has(c.no) && final.get(c.no) !== c.name)
        errors.push(`${c.no}번이 두 명(${final.get(c.no)}, ${c.name})에게 겹쳐요${replace ? '' : ' (전체 명단이면 위 체크박스를 켜세요)'}`);
      final.set(c.no, c.name);
    });
  return { changes, adjs, errors: [...new Set(errors)], same };
}

// 서버 roster_apply()에 보낼 작업 목록
export function rosterOps(plan) {
  const ops = plan.changes.map((c) =>
    c.kind === 'add'
      ? { op: 'add', name: c.name, no: c.no }
      : c.kind === 'remove'
        ? { op: 'remove', id: c.sid }
        : { op: c.kind, id: c.sid, no: c.no },
  );
  const adjs = plan.adjs.map((a) => ({ name: a.name, to: a.to }));
  return { ops, adjs };
}

const monthEnd = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
};

// 내보내기 기간 → [시작일, 종료일, 파일 이름에 쓸 이름]. 1학기는 3~8월, 2학기는 9~다음 해 2월.
export function expRange(S, exp, todayStr) {
  const ym = todayStr.slice(0, 7);
  const [y, m] = ym.split('-').map(Number);
  if (exp.range === 'month') return [ym + '-01', monthEnd(ym), ym];
  if (exp.range === 'last') {
    const d = new Date(y, m - 2, 1);
    const lym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return [lym + '-01', monthEnd(lym), lym];
  }
  if (exp.range === 'sem') {
    const s1 = m >= 3 && m <= 8;
    const sy = m < 3 ? y - 1 : y;
    return s1 ? [`${y}-03-01`, `${y}-08-31`, `${y}-1학기`] : [`${sy}-09-01`, monthEnd(`${sy + 1}-02`), `${sy}-2학기`];
  }
  if (exp.range === 'all') {
    const f = S.ledger.map((x) => x.date).sort()[0] || todayStr;
    return [f, todayStr, '전체'];
  }
  const from = exp.from || todayStr;
  const to = exp.to || todayStr;
  return [from, to, `${from}~${to}`];
}

const FIELD = { date: '날짜', item: '항목', detail: '세부', points: '점수' };
export const fieldName = (k) => FIELD[k] || k;
export const fmtVal = (k, v) => (k === 'points' ? sgn(Number(v)) : k === 'date' ? md(String(v)) : v || '없음');

// 내보내기 파일의 세 시트. 이름과 기록·요청한 사람은 넣지 않는다.
export function exportSheets(S, from, to) {
  const no = (id) => noOf(S, id);
  const summary = active(S).map((st) => {
    const l = S.ledger.filter((x) => x.sid === st.id && live(x));
    const start = l.filter((x) => x.date < from).reduce((a, x) => a + Number(x.points), 0);
    const ch = l.filter((x) => x.date >= from && x.date <= to).reduce((a, x) => a + Number(x.points), 0);
    return { no: st.no, start, change: ch, end: start + ch };
  });
  const rows = S.ledger
    .filter((x) => x.date >= from && x.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date) || no(a.sid) - no(b.sid))
    .map((x) => ({
      date: x.date,
      no: no(x.sid),
      item: x.item,
      detail: x.detail || '',
      points: Number(x.points),
      note: x.voided ? `무효 (${x.voided.reason})` : x.revs?.length ? '수정됨' : '',
      voided: !!x.voided,
    }));
  const revisions = [];
  S.ledger
    .filter((x) => x.date >= from && x.date <= to)
    .forEach((x) =>
      (x.revs || []).forEach((r) =>
        revisions.push({
          at: r.at,
          date: x.date,
          no: no(x.sid),
          change: Object.keys(r.after)
            .map((k) => `${fieldName(k)}: ${fmtVal(k, r.before[k])} → ${fmtVal(k, r.after[k])}`)
            .join(', '),
          reason: r.reason,
        }),
      ),
    );
  revisions.sort((a, b) => a.at.localeCompare(b.at));
  return { summary, rows, revisions };
}
