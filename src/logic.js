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

// 교시 이름 순서: "2교시"가 "10교시"보다 먼저 (숫자는 숫자로 비교)
export const periodCmp = (a, b) => a.localeCompare(b, 'ko', { numeric: true });
const ATT_ORDER = { 지각: 0, 결석: 1 };

// 카톡 공지 문구. 기존에 손으로 쓰던 형식을 따른다.
//   하루: "😿 9/22 자봉, 상점 공지하겠습니다." / 여러 날: 머리말 + 날짜별 소제목
//   출석으로 생긴 지각·결석은 교시마다 따로 "[교시]" 아래에, 나머지는 항목·점수별로 (세부내용이 있으면 번호를 매긴다).
//   점수는 항상 적고, 합치지 않는다 (같은 날 두 교시 지각이면 두 교시에 각각 나온다).
export function genNotice(S, from, to) {
  const es = S.ledger.filter((e) => live(e) && !['import', 'carry'].includes(e.src) && e.date >= from && e.date <= to);
  const dates = [...new Set(es.map((e) => e.date))].sort();
  if (!dates.length) return '해당 기간에 기록이 없어요.';
  const multi = dates.length > 1;
  const no = (id) => noOf(S, id);
  const nums = (l) => l.map((e) => no(e.sid)).sort((a, b) => a - b);
  const out = [multi ? '😿자봉, 상점 공지하겠습니다.' : `😿 ${md(dates[0])} 자봉, 상점 공지하겠습니다.`];
  dates.forEach((d) => {
    const de = es.filter((e) => e.date === d);
    const blk = [];
    // 출석: 교시별 (서버의 교시 순서: 아침 출석 먼저)
    const att = de.filter((e) => e.src === 'att');
    const pers = new Map();
    att.forEach((e) => {
      const k = e.pid || e.detail;
      const per = (S.periods || []).find((p) => p.id === e.pid);
      if (!pers.has(k)) pers.set(k, { label: per?.label || e.detail || '출석', morning: per?.morning ? 1 : 0, es: [] });
      pers.get(k).es.push(e);
    });
    [...pers.values()]
      .sort((a, b) => b.morning - a.morning || periodCmp(a.label, b.label))
      .forEach((p) => {
        blk.push(`[${p.label}]`);
        // 지각·결석 먼저, 그 밖의 항목(출석 기록을 고쳐 바뀐 항목)도 빠짐없이
        const items = [...new Set(p.es.map((e) => e.item))].sort((a, b) => (ATT_ORDER[a] ?? 9) - (ATT_ORDER[b] ?? 9) || a.localeCompare(b, 'ko'));
        items.forEach((item) => {
          const byPts = new Map();
          p.es.filter((e) => e.item === item).forEach((e) => {
            const k = Number(e.points);
            if (!byPts.has(k)) byPts.set(k, []);
            byPts.get(k).push(e);
          });
          byPts.forEach((l, pts) => blk.push(`${item}(${sgn(pts)}): ${nums(l).join(', ')}`));
        });
      });
    // 나머지: 항목·점수별
    const groups = new Map();
    de.filter((e) => e.src !== 'att').forEach((e) => {
      const k = e.item + '|' + e.points;
      if (!groups.has(k)) groups.set(k, { item: e.item, points: Number(e.points), es: [] });
      groups.get(k).es.push(e);
    });
    groups.forEach((g) => {
      blk.push('');
      if (!g.es.some((e) => e.detail)) blk.push(`${g.item}(${sgn(g.points)}): ${nums(g.es).join(', ')}`);
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
    if (blk[0] === '') blk.shift();
    if (multi) out.push('', mdw(d), ...blk);
    else out.push(...blk);
  });
  return out.join('\n');
}

// 엑셀에서 붙여넣은 "번호 이름 [자봉]" 명단을 현재 명단과 비교해 바뀔 내용을 만든다.
// 학생은 이름으로 알아본다. 그래야 번호가 바뀌어도 기록이 따라간다.
export function planRoster(S, text, replace) {
  const rows = [];
  const errors = [];
  text.split('\n').forEach((raw, i) => {
    // 전각 숫자(１), 엑셀의 빼기 기호(−) 같은 것을 보통 글자로
    const line = raw.normalize('NFKC').replace(/[\u2212\u2012-\u2015]/g, '-');
    // 엑셀에서 복사하면 칸이 탭으로 나뉜다. 그때는 탭으로만 나눠야 "김 민서"처럼 띄어 쓴 이름이 그대로다
    const cells = (line.includes('\t') ? line.split('\t') : line.split(/[,]+|\s+/)).map((c) => c.trim()).filter(Boolean);
    if (!cells.length) return;
    const NUM = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;
    const ni = cells.findIndex((c) => /^\d+$/.test(c));
    const num = cells[ni];
    const nameIdx = cells.findIndex((c, j) => j !== ni && !NUM.test(c));
    const name = cells[nameIdx];
    const rest = cells.filter((c, j) => j !== ni && j !== nameIdx);
    const score = rest.find((c) => NUM.test(c));
    if (!num && /번호|이름|성명/.test(line)) return;
    if (!num || !name) {
      errors.push(`${i + 1}번째 줄 "${line.trim()}": 번호와 이름이 모두 있어야 해요`);
      return;
    }
    const odd = rest.find((c) => !NUM.test(c));
    if (odd) {
      errors.push(`${i + 1}번째 줄 "${line.trim()}": 자봉 칸의 "${odd}"은(는) 숫자로만 적어 주세요`);
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
    // 날짜를 앞으로 적은 기록도 빠지지 않게 마지막 기록 날짜까지 (정리 전에 받는 파일이라 하나도 빠지면 안 된다)
    const ds = S.ledger.map((x) => x.date).sort();
    return [ds[0] || todayStr, ds.length && ds.at(-1) > todayStr ? ds.at(-1) : todayStr, '전체'];
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
  // 제외된 학생도 기록이 있으면 요약에 넣는다 (날짜별 내역·정리 뒤 이월과 맞도록). 재학생 먼저, 번호순.
  const withRec = new Set(S.ledger.map((x) => x.sid));
  const summary = S.students
    .filter((st) => st.active || withRec.has(st.id))
    .sort((a, b) => b.active - a.active || a.no - b.no)
    .map((st) => {
      const l = S.ledger.filter((x) => x.sid === st.id && live(x));
      const start = l.filter((x) => x.date < from).reduce((a, x) => a + Number(x.points), 0);
      const ch = l.filter((x) => x.date >= from && x.date <= to).reduce((a, x) => a + Number(x.points), 0);
      return { no: st.active ? st.no : `${st.no} (제외)`, start, change: ch, end: start + ch };
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

// ───────── 입력 추천 ─────────
// 항목명·세부내용·교시·사유 칸을 누르면 띄우는 "최근·자주 쓴 값". 따로 저장하지 않고 지난 기록에서 뽑는다
// (그래서 어느 기기에서든 같고, 작업 내역으로 되돌리면 추천도 함께 돌아간다).
// events: [{ v: 값, pts?: 점수, at: 시각 문자열, mine: 우선할 것인지 }] → [{ v, pts?, g: 묶음 이름 }]
// 시각은 분 단위라 같은 분이 흔하다. 그때는 목록에서 뒤에 있는 것(서버가 오래된 순으로 준다)을 더 최근으로 본다.
function tally(events) {
  const m = new Map();
  events.forEach((e, i) => {
    const v = (e.v || '').trim();
    if (!v) return;
    const k = v + '\u0000' + (e.pts ?? '');
    const s = m.get(k) || { v, pts: e.pts, n: 0, last: '', seq: -1, mineLast: '', mseq: -1 };
    s.n++;
    if (e.at >= s.last) [s.last, s.seq] = [e.at, i];
    if (e.mine && e.at >= s.mineLast) [s.mineLast, s.mseq] = [e.at, i];
    m.set(k, s);
  });
  return [...m.values()];
}
const byLast = (a, b) => b.last.localeCompare(a.last) || b.seq - a.seq;
const byCount = (a, b) => b.n - a.n || byLast(a, b);

// 입력 중이면 그 글자가 들어간 값을 자주 쓴 순으로, 비어 있으면 묶음(groups)대로 보여 준다.
// groups: [[이름, 'mine'|'recent'|'freq', 개수]]. 'mine'은 mine인 것 중 최근 순, 'freq'는 두 번 이상 쓴 것.
function rank(events, typed, groups, same = () => false) {
  const stats = tally(events);
  const t = (typed || '').trim();
  if (t) return stats.filter((s) => s.v.includes(t) && !same(s)).sort(byCount).slice(0, 8).map((s) => ({ v: s.v, pts: s.pts, g: '' }));
  const used = new Set();
  const out = [];
  groups.forEach(([label, how, n]) => {
    let l = stats.filter((s) => !used.has(s));
    if (how === 'mine') l = l.filter((s) => s.mineLast).sort((a, b) => b.mineLast.localeCompare(a.mineLast) || b.mseq - a.mseq);
    else if (how === 'recent') l = l.sort(byLast);
    else l = l.filter((s) => s.n >= 2).sort(byCount);
    l.slice(0, n).forEach((s) => {
      used.add(s);
      out.push({ v: s.v, pts: s.pts, g: label });
    });
  });
  return out;
}

// 직접 기록·요청으로 들어온 항목. 한 번에 여러 학생에게 적은 것은 한 번으로 센다. 무효 처리한 것(대개 잘못 적은 것)은 뺀다.
function entryEvents(S, me) {
  const seen = new Set();
  const ev = [];
  S.ledger.forEach((e) => {
    if (e.voided || !['manual', 'request'].includes(e.src)) return;
    const k = [e.item, e.detail, e.points, e.at, e.by].join('|');
    if (seen.has(k)) return;
    seen.add(k);
    ev.push({ item: e.item, detail: e.detail, pts: Number(e.points), at: e.at, mine: Boolean(me) && e.by === me });
  });
  // 승인된 요청은 위의 기록에 이미 있다
  (S.requests || [])
    .filter((r) => r.status !== 'approved')
    .forEach((r) => ev.push({ item: r.item, detail: r.detail, pts: Number(r.points), at: r.at, mine: Boolean(me) && r.by === me }));
  return ev;
}

// 항목명: 항목과 점수를 함께 추천한다 (누르면 둘 다 들어간다). 최근은 내가 쓴 것 먼저, 없으면 반 전체.
export function suggestItems(S, me, typed, curPoints) {
  const ev = entryEvents(S, me).map((e) => ({ v: e.item, pts: e.pts, at: e.at, mine: e.mine }));
  const mine = ev.some((e) => e.mine);
  return rank(ev, typed, [['최근', mine ? 'mine' : 'recent', 4], ['자주', 'freq', 4]], (s) => s.v === (typed || '').trim() && s.pts === Number(curPoints));
}

// 세부내용: 적어 둔 항목명과 같은 항목에서 쓴 세부내용을 먼저 (없으면 전체)
export function suggestDetails(S, me, item, typed) {
  const ev = entryEvents(S, me).filter((e) => e.detail).map((e) => ({ v: e.detail, at: e.at, mine: e.mine, item: e.item }));
  const it = (item || '').trim();
  const same = ev.filter((e) => e.item === it);
  const mine = (same.length ? same : ev).some((e) => e.mine);
  return rank(same.length ? same : ev, typed, [['최근', mine ? 'mine' : 'recent', 4], ['자주', 'freq', 4]], (s) => s.v === (typed || '').trim());
}

// 교시: 시간표는 주마다 되풀이되니 같은 요일에 쓴 교시를 먼저. 그 날짜에 이미 있는 교시는 뺀다.
export function suggestPeriods(S, date, typed) {
  const taken = new Set(S.periods.filter((p) => p.date === date).map((p) => p.label));
  const dow = new Date(date + 'T00:00:00').getDay();
  const ev = S.periods
    .filter((p) => !p.morning && !taken.has(p.label))
    .map((p) => ({ v: p.label, at: p.date, mine: new Date(p.date + 'T00:00:00').getDay() === dow }))
    // 같은 날짜의 교시는 1교시, 2교시… 순으로 보이게 (같은 시각이면 목록 뒤쪽이 앞에 오므로 이름을 거꾸로 놓는다)
    .sort((a, b) => a.at.localeCompare(b.at) || periodCmp(b.v, a.v));
  return rank(ev, typed, [['같은 요일', 'mine', 4], ['최근', 'recent', 3], ['자주', 'freq', 3]], (s) => s.v === (typed || '').trim());
}

// 사유 칸들: 지난 사유에서. 출석 정정·공결 처리처럼 앱이 붙인 사유는 뺀다.
const AUTO_VOID = /^(출석 정정|공결 처리|공결 승인)/;
export function reasonEvents(S, kind, me) {
  if (kind === 'editReason') return S.ledger.flatMap((e) => (e.revs || []).map((r) => ({ v: r.reason, at: r.at })));
  if (kind === 'voidReason') return S.ledger.filter((e) => e.voided && !AUTO_VOID.test(e.voided.reason || '')).map((e) => ({ v: e.voided.reason, at: e.voided.at }));
  if (kind === 'note') return [...(S.requests || []), ...(S.excuses || []), ...(S.attRequests || [])].filter((x) => x.note).map((x) => ({ v: x.note, at: x.reviewedAt || x.at }));
  if (kind === 'reqReason') return (S.requests || []).filter((r) => r.reason && r.by === me).map((r) => ({ v: r.reason, at: r.at }));
  return [];
}
export function suggestTexts(events, typed) {
  return rank(events, typed, [['최근', 'recent', 3], ['자주', 'freq', 3]], (s) => s.v === (typed || '').trim());
}
