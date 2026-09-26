// 화면. 상태(S)는 서버에서 통째로 받아오고, 모든 변경은 서버 함수를 부른 뒤 다시 받아온다.
// UI는 화면 전용 상태(탭, 입력 중인 폼, 출석 초안 등)다.
import * as L from './logic.js';
import { esc, sgn, md, mdw, live } from './logic.js';
import { configured, rpc, onChange, getSession, setSession } from './api.js';
import { downloadExport } from './excel.js';

let S = { students: [], presets: [], periods: [], att: {}, ledger: [], excuses: [], requests: [], accounts: [], updatedAt: '' };
let loaded = false;
let loadError = null;
let TODAY = L.today();

const stu = (id) => L.stu(S, id);
const noOf = (id) => L.noOf(S, id);
const active = () => L.active(S);
const bal = (sid) => L.bal(S, sid);
const parseNums = (str) => L.parseNums(S, str);
const admins = () => S.accounts.filter((a) => a.admin).map((a) => a.role);
const officers = () => S.accounts.filter((a) => !a.admin).map((a) => a.role);
const roleOf = (u) => (S.accounts.find((a) => a.role === u)?.admin ? 'admin' : 'officer');
const token = () => getSession()?.token;

const blankForm = () => ({ date: TODAY, preset: '', item: '', points: 1, detail: '', nums: '', find: '', reason: '', photo: '' });
const UI = {
  role: 'student', tab: 'board', sid: null, user: null, sort: 'no', q: '',
  attDate: TODAY, attPid: null, attView: 'list', draft: {}, newPeriod: '', attConfirm: false,
  recForm: blankForm(), reqForm: blankForm(), excForm: { no: '', eid: '', reason: '', photo: '' },
  recFilter: '', editId: null, voidId: null, openRev: {}, photos: {},
  noticeFrom: null, noticeTo: null, noticeText: null,
  doneLimit: 20,
  pickGrid: (() => {
    try {
      return localStorage.getItem('jabong-pickgrid') === '1';
    } catch {
      return false;
    }
  })(),
  exp: { range: 'month', from: '', to: '' }, fullBackup: false, purgeCut: '', purgeTyped: '',
  rosterText: '', rosterReplace: false, recover: false, newCode: null,
};

const TABS = {
  student: [['board', '현황판'], ['excuse', '공결 신청']],
  officer: [['request', '요청하기'], ['reqs', '요청 현황'], ['board', '현황판']],
  admin: [['attend', '출석'], ['record', '기록'], ['inbox', '요청함'], ['notice', '공지'], ['manage', '관리'], ['board', '현황판']],
};
// 출석 권한을 받은 총대단(기본: 실습부장)은 맨 앞에 출석 탭이 생긴다
const canAttend = () => Boolean(S.accounts.find((a) => a.role === UI.user)?.attend);
const tabsOf = (role) => (role === 'officer' && UI.user && canAttend() ? [['attend', '출석'], ...TABS.officer] : TABS[role]);
const STATUS = { pending: '대기', approved: '승인', rejected: '반려' };
const pendingCount = () => S.requests.filter((r) => r.status === 'pending').length + S.excuses.filter((x) => x.status === 'pending').length;

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 2600);
  return true;
}

/* ---------- 서버 ---------- */

async function refresh() {
  TODAY = L.today();
  try {
    const sess = getSession();
    S = sess ? await rpc('private_state', { p_token: sess.token }) : await rpc('public_state');
    loaded = true;
    loadError = null;
  } catch (e) {
    if (e.code === '28000') return signOut('로그인이 끊겼어요. 다시 로그인해 주세요');
    loadError = e.message;
  }
}

// 서버 함수를 부르고, 성공하면 최신 상태를 다시 받아 화면을 그린다
async function run(fn, args, msg) {
  const r = await rpc(fn, { p_token: token(), ...args });
  await refresh();
  render();
  if (msg) toast(typeof msg === 'function' ? msg(r) : msg);
  return r;
}

async function signOut(msg) {
  setSession(null);
  UI.user = null;
  UI.role = 'student';
  UI.tab = 'board';
  UI.sid = null;
  await refresh();
  render();
  if (msg) toast(msg);
}

/* ---------- 화면 ---------- */

// 부총대·총대만 (기록자·승인자 같은 관리 정보)
const isAdmin = () => UI.role === 'admin' && UI.user && roleOf(UI.user) === 'admin';
// 로그인한 총대단 전체(부총대·총대 포함). 현황판과 학생 상세에 이름을 함께 보여 준다
const isStaff = () => UI.role !== 'student' && UI.user && roleOf(UI.user) === UI.role;

function vBoard() {
  const named = isStaff();
  let list = active().map((s) => ({ s, b: bal(s.id) }));
  const q = UI.q.trim();
  if (q) list = list.filter((x) => String(x.s.no).startsWith(q) || (named && (x.s.name || '').includes(q)));
  if (UI.sort === 'bal') list.sort((a, b) => b.b - a.b || a.s.no - b.s.no);
  return `<div><h1>자봉 현황</h1><p class="live"><span class="dot"></span>실시간 반영 · 마지막 변경 ${esc(S.updatedAt)}</p></div>
  <div class="toolbar"><input type="search" id="q" ${named ? '' : 'inputmode="numeric" '}placeholder="${named ? '번호·이름 검색' : '번호 검색'}" value="${esc(UI.q)}" data-bind="q" data-region="board-grid">
  <div class="seg"><button class="${UI.sort === 'no' ? 'on' : ''}" data-act="sort" data-v="no">번호순</button><button class="${UI.sort === 'bal' ? 'on' : ''}" data-act="sort" data-v="bal">자봉 많은 순</button></div></div>
  <div class="grid${named ? ' named' : ''}" id="board-grid">${list.map(({ s, b }) => `<button class="tile" data-act="open" data-sid="${s.id}"><span class="no">${s.no}</span>${named ? `<span class="nm">${esc(s.name)}</span>` : ''}<span class="pt">자봉 ${b}</span></button>`).join('') || `<p class="empty">${S.students.length ? '찾는 학생이 없어요.' : '아직 명단이 없어요.'}</p>`}</div>`;
}

function vDetail() {
  const s = stu(UI.sid);
  if (!s) return '<button class="back" data-act="back">← 현황판</button><p class="empty">학생을 찾을 수 없어요.</p>';
  const b = bal(s.id);
  const es = S.ledger.filter((e) => e.sid === s.id).sort((a, c) => c.date.localeCompare(a.date) || c.at.localeCompare(a.at));
  const dates = [...new Set(es.map((e) => e.date))];
  const admin = isAdmin();
  const ev = (e) => {
    const open = UI.openRev[e.id];
    return `<li class="ev ${e.voided ? 'void' : ''}">
    <div class="ev-main"><span class="item">${esc(e.item)}${e.detail ? `<em>${esc(e.detail)}</em>` : ''}</span><span class="pts ${e.points > 0 ? 'p' : 'm'}">${sgn(e.points)}</span></div>
    ${e.voided ? `<div class="note">무효 · ${esc(e.voided.reason)} · ${esc(e.voided.at)}</div>` : ''}
    ${e.revs?.length ? `<button class="revbtn" data-act="rev" data-id="${e.id}">수정됨 ${e.revs.length}회 ${open ? '▾' : '▸'}</button>
      ${open ? e.revs.map((r) => `<div class="rev"><span>${esc(r.at)}</span>${Object.keys(r.after).map((k) => `<b>${L.fieldName(k)}: ${esc(L.fmtVal(k, r.before[k]))} → ${esc(L.fmtVal(k, r.after[k]))}</b>`).join('')}<span>사유: ${esc(r.reason)}</span></div>`).join('') : ''}` : ''}
    ${admin ? `<div class="note">${e.src === 'request' ? `요청: ${esc(e.by)} · 승인: ${esc(e.approvedBy)}` : `기록: ${esc(e.by || '-')}`}${e.voided?.by ? ` · 무효 처리: ${esc(e.voided.by)}` : ''}${e.revs?.length ? ` · 수정: ${esc([...new Set(e.revs.map((r) => r.by))].join(', '))}` : ''} (관리자에게만 보임)</div>` : ''}
  </li>`;
  };
  return `<button class="back" data-act="back">← 현황판</button>
  <div class="hero"><div><h1>${s.no}번${isStaff() && s.name ? ` <span class="sub" style="font-size:15px">${esc(s.name)}</span>` : ''}</h1><p class="sub">기록 ${es.filter(live).length}건${es.some((e) => e.voided) ? ` · 무효 ${es.filter((e) => e.voided).length}건` : ''}</p></div>
  <div style="text-align:right"><div class="sub">자봉</div><div class="big ${b > 0 ? 'p' : b < 0 ? 'm' : ''}">${b}</div></div></div>
  ${UI.role === 'student' ? `<button class="btn ghost" data-act="to-excuse" data-no="${s.no}">이 번호로 공결 신청</button>` : ''}
  ${admin ? `<button class="btn ghost" data-act="to-record" data-no="${s.no}">이 학생 기록 수정·무효 처리</button>` : ''}
  <div>${dates.map((d) => `<div class="day">${mdw(d)}</div><ul class="evs">${es.filter((e) => e.date === d).map(ev).join('')}</ul>`).join('') || '<p class="empty">기록이 없어요.</p>'}</div>`;
}

function liveParts(fk) {
  const f = UI[fk];
  const { sids, bad } = parseNums(f.nums);
  // 추천은 입력칸의 마지막 낱말로 찾는다 (앞의 낱말은 띄어쓰기할 때 이미 선택으로 옮겨진다)
  const fq = (f.find || '').trim().split(/[\s,]+/).pop() || '';
  const sg = fq ? active().filter((s) => (s.name || '').includes(fq) || String(s.no).startsWith(fq)).slice(0, 8) : [];
  const dup = L.dupNums(S, f);
  return {
    sugg: sg.length
      ? `<div class="sugg">${sg.map((s) => `<button data-act="pick" data-fk="${fk}" data-sid="${s.id}"><span class="mono">${s.no}</span> ${esc(s.name)}${sids.includes(s.id) ? ' ✓' : ''}</button>`).join('')}</div>`
      : fq ? '<p class="note">일치하는 학생이 없어요.</p>' : '',
    chips: `${sids.map((id) => `<button class="chip" data-act="unpick" data-fk="${fk}" data-sid="${id}" aria-label="${noOf(id)}번 빼기">${noOf(id)} ${esc(stu(id).name)} ×</button>`).join('')}${bad.map((x) => `<span class="chip bad">${esc(x)} 없음</span>`).join('')}`,
    dup: dup.length ? `<div class="warn">같은 날짜·항목으로 이미 요청됐거나 기록된 번호: ${dup.join(', ')}</div>` : '',
    grid: UI.pickGrid
      ? `<div class="pickgrid">${active().map((s) => `<button class="${sids.includes(s.id) ? 'on' : ''}" data-act="gtoggle" data-fk="${fk}" data-sid="${s.id}" aria-pressed="${sids.includes(s.id)}"><b>${s.no}</b><span>${esc(s.name)}</span></button>`).join('')}</div>`
      : '',
    count: sids.length ? `${sids.length}명 선택` : '',
  };
}
function addStudents(fk, ids) {
  const f = UI[fk];
  const { sids } = parseNums(f.nums);
  ids.forEach((id) => sids.includes(id) || sids.push(id));
  f.nums = sids.map(noOf).join(' ');
}

// 학생 입력칸의 완성된 낱말(번호나 정확한 이름)을 선택으로 옮긴다. 못 찾은 낱말은 칸에 남긴다.
// lastToo가 아니면 아직 치고 있는 마지막 낱말은 건드리지 않는다.
function commitPicker(el, lastToo) {
  const fk = el.dataset.picker;
  const words = el.value.split(/[\s,]+/).filter(Boolean);
  const typing = lastToo || /[\s,]$/.test(el.value) ? '' : words.pop() || '';
  const { sids, bad } = parseNums(words.join(' '));
  addStudents(fk, sids);
  const rest = [...bad, typing].filter(Boolean).join(' ');
  const next = rest && !typing ? rest + ' ' : rest;
  if (el.value !== next) el.value = next;
  UI[fk].find = next;
  updateLive(fk);
  return { added: sids.length, bad };
}

function updateLive(fk) {
  const l = liveParts(fk);
  ['sugg', 'chips', 'dup', 'grid', 'count'].forEach((k) => {
    const el = document.getElementById(`${fk}-${k}`);
    if (el) el.innerHTML = l[k];
  });
}

function entryFields(fk) {
  const f = UI[fk];
  const P = liveParts(fk);
  return `<div class="row2"><label class="fld grow"><span>날짜</span><input type="date" id="${fk}-date" value="${esc(f.date)}" data-bind="${fk}.date" data-rerender="1"></label>
  <label class="fld grow"><span>항목 불러오기</span><select id="${fk}-preset" data-bind="${fk}.preset" data-rerender="1"><option value="">직접 입력</option>${S.presets.map((p) => `<option value="${p.id}" ${f.preset === p.id ? 'selected' : ''}>${esc(p.name)} (${sgn(p.points)})</option>`).join('')}</select></label></div>
  <div class="row2"><label class="fld grow"><span>항목명</span><input id="${fk}-item" value="${esc(f.item)}" placeholder="예: 실습실 뒷정리 미흡" data-bind="${fk}.item" data-live="${fk}"></label>
  <label class="fld pts-fld"><span>점수</span><input type="number" step="0.5" inputmode="decimal" id="${fk}-points" value="${esc(f.points)}" data-bind="${fk}.points"></label></div>
  <p class="hint">+는 자봉, −는 상점이에요. 0.5점 단위로도 적을 수 있어요. 항목명과 점수는 불러온 뒤에도 고칠 수 있어요.</p>
  <label class="fld"><span>세부내용 (선택)</span><input id="${fk}-detail" value="${esc(f.detail)}" placeholder="예: 전원 안끔" data-bind="${fk}.detail"></label>
  <label class="fld"><span>학생</span><input id="${fk}-find" type="search" value="${esc(f.find)}" placeholder="이름이나 번호 (예: 김민, 56 59)" autocomplete="off" enterkeyhint="done" data-bind="${fk}.find" data-picker="${fk}"></label>
  <p class="hint">이름 일부를 치고 목록에서 고르거나, 번호를 띄어 쓰며 연달아 적으세요.</p>
  <div id="${fk}-sugg">${P.sugg}</div>
  <div class="req-top"><button class="btn ghost small" data-act="pickgrid">${UI.pickGrid ? '전체 명단 닫기 ▴' : '전체 명단에서 누르기 ▾'}</button><span class="note" id="${fk}-count">${P.count}</span></div>
  <div id="${fk}-grid">${P.grid}</div>
  <div class="chips" id="${fk}-chips">${P.chips}</div>
  <div id="${fk}-dup">${P.dup}</div>`;
}

function photoField(key, val) {
  return `<label class="fld"><span>사진 (선택)</span><input type="file" accept="image/*" data-photo="${key}"></label><p class="hint" style="margin:0">사진은 자동으로 작게 줄여 올라가고, 처리 180일 뒤 자동으로 지워져요.</p>${val ? `<img class="thumb" src="${esc(val)}" alt="첨부한 사진">` : ''}`;
}

// 증빙 사진은 용량 때문에 눌렀을 때만 불러온다
function photoView(id) {
  if (!id) return '';
  const data = UI.photos[id];
  if (data === undefined) return `<button class="photo-btn" data-act="photo" data-id="${id}">증빙 사진 보기</button>`;
  if (data === null) return '<div class="note">사진이 삭제됐어요 (처리 180일 경과)</div>';
  return `<img class="photo-big" src="${esc(data)}" alt="증빙 사진">`;
}

function vRequest() {
  const f = UI.reqForm;
  return `<div><h1>상점·자봉 요청</h1><p class="sub">부총대나 총대가 승인하면 반영돼요. 요청자 이름은 학생들에게 보이지 않아요.</p></div>
  <div class="card">${entryFields('reqForm')}
  <label class="fld"><span>사유 (선택)</span><textarea id="reqForm-reason" data-bind="reqForm.reason" placeholder="필요하면 적어주세요">${esc(f.reason)}</textarea></label>
  ${photoField('reqForm', f.photo)}
  <button class="btn" data-act="req-add">요청 보내기</button></div>`;
}

function reqCard(r, admin) {
  return `<div class="card"><div class="req-top"><span class="pill ${r.status}">${STATUS[r.status]}</span><span class="note">${esc(r.by)} · ${esc(r.at)}</span></div>
  <div class="req-body"><b>${esc(r.item)}</b>${r.detail ? ` · ${esc(r.detail)}` : ''} <span class="pts ${r.points > 0 ? 'p' : 'm'}">${sgn(r.points)}</span> · ${md(r.date)}</div>
  <div class="chips">${r.sids.map((id) => `<span class="chip">${noOf(id)} ${esc(stu(id)?.name || '')}</span>`).join('')}</div>
  ${r.reason ? `<div class="note">사유: ${esc(r.reason)}</div>` : ''}${photoView(r.photo)}
  ${r.note ? `<div class="note">${esc(r.reviewer || '')}: ${esc(r.note)}</div>` : ''}
  ${admin && r.status === 'pending' ? `<input id="note-${r.id}" placeholder="반려 사유 (반려할 때 필수)"><div class="btns"><button class="btn ok small" data-act="req-ok" data-id="${r.id}">승인</button><button class="btn danger small" data-act="req-no" data-id="${r.id}">반려</button></div>` : ''}</div>`;
}

function vReqs() {
  const list = [...S.requests].sort((a, b) => b.at.localeCompare(a.at));
  return `<div><h1>요청 현황</h1><p class="sub">총대단 전체의 요청과 처리 상태예요. 같은 건을 두 번 요청하지 않게 확인하세요.</p></div>${list.map((r) => reqCard(r, false)).join('') || '<p class="empty">요청이 없어요.</p>'}`;
}

const periodLabel = (e) => S.periods.find((p) => p.id === e.pid)?.label || e.detail;

function vExcuse() {
  const f = UI.excForm;
  const s = S.students.find((x) => x.active && x.no === Number(f.no));
  const cands = s
    ? S.ledger
        .filter((e) => e.sid === s.id && L.excusable(e) && !S.excuses.some((x) => x.eid === e.id && x.status === 'pending'))
        .sort((a, b) => b.date.localeCompare(a.date))
    : [];
  const mine = s ? S.excuses.filter((x) => x.sid === s.id).sort((a, b) => b.at.localeCompare(a.at)) : [];
  return `<div><h1>공결 신청</h1><p class="sub">번호만 입력하면 돼요. 부총대나 총대가 증빙을 확인하고 승인하면 해당 자봉이 무효 처리돼요.</p></div>
  <div class="card"><label class="fld"><span>내 번호</span><input id="exc-no" inputmode="numeric" value="${esc(f.no)}" data-bind="excForm.no" data-rerender="1" placeholder="예: 56"></label>
  ${s ? (cands.length ? `<label class="fld"><span>공결 처리할 출결</span><select id="exc-eid" data-bind="excForm.eid"><option value="">선택하세요</option>${cands.map((e) => `<option value="${e.id}" ${f.eid === e.id ? 'selected' : ''}>${mdw(e.date)} ${esc(periodLabel(e))} ${e.item} ${sgn(e.points)}</option>`).join('')}</select></label>
  <label class="fld"><span>사유 (선택)</span><textarea id="exc-reason" data-bind="excForm.reason" placeholder="예: 예비군 훈련">${esc(f.reason)}</textarea></label>
  ${photoField('excForm', f.photo)}<button class="btn" data-act="exc-add">신청하기</button>` : '<p class="note">공결 신청할 지각·결석 기록이 없어요.</p>') : f.no ? '<p class="note">없는 번호예요.</p>' : ''}</div>
  ${mine.length ? `<h2>${s.no}번 신청 내역</h2>${mine.map((x) => {
    const e = S.ledger.find((l) => l.id === x.eid);
    return `<div class="card"><div class="req-top"><span class="pill ${x.status}">${STATUS[x.status]}</span><span class="note">${esc(x.at)}</span></div><div class="req-body">${e ? `${mdw(e.date)} ${esc(periodLabel(e))} ${e.item}` : ''}${x.reason ? ` · ${esc(x.reason)}` : ''}</div>${x.note ? `<div class="note">반려 사유: ${esc(x.note)}</div>` : ''}</div>`;
  }).join('')}` : ''}`;
}

// 출석: 날짜마다 "아침 출석"은 항상 맨 앞에 있다. 아직 서버에 없는 교시는 v: 로 시작하는 임시 id를 쓴다.
function periodsOf(date) {
  const ps = S.periods.filter((p) => p.date === date);
  if (!ps.some((p) => p.morning)) ps.unshift({ id: `v:${date}:아침 출석`, date, label: '아침 출석', morning: true });
  return ps.sort((a, b) => (b.morning ? 1 : 0) - (a.morning ? 1 : 0));
}
function attDraft(pid) {
  if (!UI.draft[pid]) UI.draft[pid] = { ...(S.att[pid] || {}) };
  return UI.draft[pid];
}
const ST = { present: ['✓', '출석'], late: ['지', '지각'], absent: ['결', '결석'], excused: ['공', '공결'] };

function vAttend() {
  const ps = periodsOf(UI.attDate);
  if (!ps.some((p) => p.id === UI.attPid)) UI.attPid = ps.find((p) => !S.att[p.id])?.id || ps[0]?.id || null;
  const pid = UI.attPid;
  let body = '';
  if (pid) {
    const d = attDraft(pid);
    const c = { late: 0, absent: 0, excused: 0 };
    Object.values(d).forEach((v) => c[v] != null && c[v]++);
    const saved = !!S.att[pid];
    const dirty = JSON.stringify(d) !== JSON.stringify(S.att[pid] || {});
    body =
      (UI.attView === 'grid'
        ? `<div class="att">${active().map((s) => {
            const st = d[s.id] || 'present';
            return `<button class="${st}" data-act="cyc" data-sid="${s.id}" aria-label="${s.no}번 ${esc(s.name)} ${ST[st][1]}">${s.no}<span class="nm">${esc(s.name)}</span><small>${ST[st][0]}</small></button>`;
          }).join('')}</div>`
        : `<div class="calls">${active().map((s) => {
            const st = d[s.id] || 'present';
            return `<div class="call ${st}"><span class="no">${s.no}</span><span class="nm">${esc(s.name || '이름 없음')}</span><div class="st4" role="group" aria-label="${s.no}번 출결">${Object.entries(ST).map(([k, [, l]]) => `<button class="${k} ${st === k ? 'on' : ''}" data-act="setst" data-sid="${s.id}" data-v="${k}">${l}</button>`).join('')}</div></div>`;
          }).join('') || '<p class="empty">관리 탭에서 명단을 먼저 넣어 주세요.</p>'}</div>`) +
      `<div class="att-foot"><span class="note">지각 ${c.late} · 결석 ${c.absent} · 공결 ${c.excused}<br>${saved ? (dirty ? '변경 사항 있음' : '저장됨') : '아직 저장 안 됨'}</span>
    <div class="btns"><button class="btn ghost small" data-act="att-clear">전원 출석으로 되돌리기</button><button class="btn" data-act="att-save">저장</button></div></div>
    ${UI.attConfirm ? `<div class="att-confirm"><span>지금 표시한 지각 ${c.late}명 · 결석 ${c.absent}명 · 공결 ${c.excused}명이 모두 출석으로 바뀌어요. 되돌릴까요?</span>
    <div class="btns"><button class="btn danger small" data-act="att-clear-yes">네, 전원 출석으로</button><button class="btn ghost small" data-act="att-clear-no">그만두기</button></div></div>` : ''}`;
  }
  return `<div><h1>출석 체크</h1><p class="sub">${UI.attView === 'grid' ? '칸을 누를 때마다 출석 → 지각 → 결석 → 공결 순으로 바뀌어요.' : '번호순으로 이름을 부르면서 바로 출결을 고르세요.'} 저장하면 지각 +1, 결석 +2가 교시마다 기록돼요. 이름은 출석 체크하는 사람에게만 보여요.</p></div>
  <div class="seg"><button class="${UI.attView !== 'grid' ? 'on' : ''}" data-act="attview" data-v="list">호명 목록</button><button class="${UI.attView === 'grid' ? 'on' : ''}" data-act="attview" data-v="grid">한눈에 보기</button></div>
  <div class="toolbar"><input type="date" id="attDate" value="${UI.attDate}" data-bind="attDate" data-rerender="1" style="width:auto"></div>
  <div class="seg" style="flex-wrap:wrap">${ps.map((p) => `<button class="${p.id === pid ? 'on' : ''}" data-act="pick-period" data-id="${p.id}">${esc(p.label)}${S.att[p.id] ? ' ·저장됨' : ''}</button>`).join('')}</div>
  <div class="toolbar"><input id="newPeriod" placeholder="교시 추가 (예: 1교시 구강해부학)" value="${esc(UI.newPeriod)}" data-bind="newPeriod"><button class="btn ghost small" data-act="add-period">추가</button></div>
  ${body}`;
}

function vRecord() {
  const q = UI.recFilter.trim();
  let list = [...S.ledger].sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at));
  if (q) list = list.filter((e) => String(noOf(e.sid)) === q || e.item.includes(q) || (e.detail || '').includes(q));
  const shown = list.slice(0, 40);
  const row = (e) => {
    let extra = '';
    if (UI.editId === e.id)
      extra = `<div class="edit"><div class="row2"><label class="fld grow"><span>날짜</span><input type="date" id="ed-date" value="${e.date}"></label><label class="fld pts-fld"><span>점수</span><input type="number" step="0.5" inputmode="decimal" id="ed-points" value="${e.points}"></label></div>
      <label class="fld"><span>항목명</span><input id="ed-item" value="${esc(e.item)}"></label><label class="fld"><span>세부</span><input id="ed-detail" value="${esc(e.detail)}"></label>
      <label class="fld"><span>수정 사유 (필수, 학생들에게 공개)</span><input id="ed-reason"></label><div class="btns"><button class="btn small" data-act="edit-save" data-id="${e.id}">수정 저장</button><button class="btn ghost small" data-act="edit-cancel">닫기</button></div></div>`;
    if (UI.voidId === e.id)
      extra = `<div class="edit"><label class="fld"><span>무효 처리 사유 (필수, 학생들에게 공개)</span><input id="vd-reason"></label><p class="hint" style="margin:0">점수 합계에서 빠지지만, 기록은 줄이 그어진 채로 남아요.</p><div class="btns"><button class="btn danger small" data-act="void-save" data-id="${e.id}">무효 처리</button><button class="btn ghost small" data-act="edit-cancel">닫기</button></div></div>`;
    return `<div class="rec-row"><span class="mono">${noOf(e.sid)}번</span><span class="${e.voided ? 'off' : ''}">${esc(e.item)}${e.detail ? ` · ${esc(e.detail)}` : ''}<br><span class="d">${mdw(e.date)}${e.revs?.length ? ' · 수정됨' : ''}${e.voided ? ' · 무효' : ''}</span></span><span class="pts ${e.points > 0 ? 'p' : 'm'} ${e.voided ? 'off' : ''}">${sgn(e.points)}</span>
    ${e.voided ? '' : `<div class="acts"><button class="btn ghost small" data-act="edit" data-id="${e.id}">수정</button><button class="btn ghost small" data-act="void" data-id="${e.id}">무효 처리</button></div>`}${extra}</div>`;
  };
  return `<div><h1>직접 기록</h1><p class="sub">즉석 부과, 상점 등 모든 항목을 여기서 바로 기록해요.</p></div>
  <div class="card">${entryFields('recForm')}<button class="btn" data-act="rec-add">기록 추가</button></div>
  <h2>기록 수정·무효 처리</h2><p class="sub" style="margin-top:-12px">지우지 않고 이력으로 남아요. 학생 상세 화면에서 누구나 수정 내역을 볼 수 있어요.</p>
  <input type="search" id="recFilter" placeholder="번호 또는 항목으로 찾기" value="${esc(UI.recFilter)}" data-bind="recFilter" data-region="rec-list">
  <div class="card" style="gap:0" id="rec-list">${shown.map(row).join('') || '<p class="empty">기록이 없어요.</p>'}${list.length > 40 ? '<p class="note">최근 40건만 보여요. 번호로 찾아보세요.</p>' : ''}</div>`;
}

function vInbox() {
  const rq = S.requests.filter((r) => r.status === 'pending');
  const ex = S.excuses.filter((x) => x.status === 'pending');
  return `<div><h1>요청함</h1><p class="sub">총대단 요청 ${rq.length}건 · 공결 신청 ${ex.length}건</p></div>
  <h2>총대단 요청</h2>${rq.map((r) => reqCard(r, true)).join('') || '<p class="empty">대기 중인 요청이 없어요.</p>'}
  <h2>공결 신청</h2>${ex.map((x) => {
    const e = S.ledger.find((l) => l.id === x.eid);
    return `<div class="card"><div class="req-top"><span class="pill pending">대기</span><span class="note">${esc(x.at)}</span></div>
    <div class="req-body"><b>${noOf(x.sid)}번 ${esc(stu(x.sid)?.name || '')}</b> · ${e ? `${mdw(e.date)} ${esc(periodLabel(e))} ${e.item} ${sgn(e.points)}` : ''}</div>${x.reason ? `<div class="note">사유: ${esc(x.reason)}</div>` : '<div class="note">사유 없음</div>'}${x.photo ? photoView(x.photo) : '<div class="note">증빙 사진 없음</div>'}
    <input id="note-${x.id}" placeholder="반려 사유 (반려할 때 필수)"><div class="btns"><button class="btn ok small" data-act="exc-ok" data-id="${x.id}">승인 (자봉 무효 처리)</button><button class="btn danger small" data-act="exc-no" data-id="${x.id}">반려</button></div></div>`;
  }).join('') || '<p class="empty">대기 중인 공결 신청이 없어요.</p>'}
  ${vDone()}`;
}

// 승인·반려한 요청과 공결 신청. 증빙 사진은 처리 후 180일 동안 여기서 다시 볼 수 있다.
function vDone() {
  const items = [
    ...S.requests.filter((r) => r.status !== 'pending').map((r) => ({ kind: 'req', at: r.reviewedAt || r.at, r })),
    ...S.excuses.filter((x) => x.status !== 'pending').map((x) => ({ kind: 'exc', at: x.reviewedAt || x.at, x })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const shown = items.slice(0, UI.doneLimit);
  const card = (it) => {
    if (it.kind === 'req') {
      const r = it.r;
      return `<div class="card"><div class="req-top"><span class="pill ${r.status}">총대단 요청 ${STATUS[r.status]}</span><span class="note">${esc(r.reviewer || '')} · ${esc(it.at)}</span></div>
      <div class="req-body"><b>${esc(r.item)}</b>${r.detail ? ` · ${esc(r.detail)}` : ''} <span class="pts ${r.points > 0 ? 'p' : 'm'}">${sgn(r.points)}</span> · ${md(r.date)}</div>
      <div class="chips">${r.sids.map((id) => `<span class="chip">${noOf(id)} ${esc(stu(id)?.name || '')}</span>`).join('')}</div>
      <div class="note">요청: ${esc(r.by)} · ${esc(r.at)}${r.reason ? ` · 사유: ${esc(r.reason)}` : ''}</div>
      ${r.note ? `<div class="note">반려 사유: ${esc(r.note)}</div>` : ''}${photoView(r.photo)}</div>`;
    }
    const x = it.x;
    const e = S.ledger.find((l) => l.id === x.eid);
    return `<div class="card"><div class="req-top"><span class="pill ${x.status}">공결 ${STATUS[x.status]}</span><span class="note">${esc(x.reviewer || '')} · ${esc(it.at)}</span></div>
    <div class="req-body"><b>${noOf(x.sid)}번 ${esc(stu(x.sid)?.name || '')}</b>${e ? ` · ${mdw(e.date)} ${esc(periodLabel(e))} ${e.item} ${sgn(e.points)}` : ''}</div>
    <div class="note">신청: ${esc(x.at)}${x.reason ? ` · 사유: ${esc(x.reason)}` : ''}</div>
    ${x.note ? `<div class="note">반려 사유: ${esc(x.note)}</div>` : ''}${photoView(x.photo)}</div>`;
  };
  return `<h2>처리한 내역</h2><p class="sub" style="margin-top:-12px">승인·반려한 건이에요. 증빙 사진은 처리 후 180일 동안 볼 수 있어요.</p>
  ${shown.map(card).join('') || '<p class="empty">아직 처리한 건이 없어요.</p>'}
  ${items.length > shown.length ? `<button class="btn ghost" data-act="done-more">더 보기 (${items.length - shown.length}건 남음)</button>` : ''}`;
}

const lastDate = () => [...new Set(S.ledger.filter((e) => !['import', 'carry'].includes(e.src)).map((e) => e.date))].sort().pop() || TODAY;

function vNotice() {
  if (!UI.noticeFrom) UI.noticeFrom = UI.noticeTo = lastDate();
  if (UI.noticeText == null) UI.noticeText = L.genNotice(S, UI.noticeFrom, UI.noticeTo);
  return `<div><h1>공지 문구</h1><p class="sub">하루를 고르면 날짜가 들어간 머리말, 여러 날을 고르면 날짜별 소제목으로 만들어져요. 복사하기 전에 직접 고칠 수 있어요.</p></div>
  <div class="toolbar"><input type="date" id="nf" value="${UI.noticeFrom}" data-bind="noticeFrom" style="width:auto"><span class="note">~</span><input type="date" id="nt" value="${UI.noticeTo}" data-bind="noticeTo" style="width:auto"><button class="btn ghost small" data-act="notice-gen">문구 만들기</button></div>
  <div class="btns"><button class="btn ghost small" data-act="notice-preset" data-v="one">최근 하루</button><button class="btn ghost small" data-act="notice-preset" data-v="week">최근 7일</button></div>
  <textarea class="bubble" id="notice-text" data-bind="noticeText" aria-label="공지 문구">${esc(UI.noticeText)}</textarea>
  <button class="btn" data-act="copy">카톡에 붙여넣을 문구 복사</button>
  ${vExport()}`;
}

function vExport() {
  const e = UI.exp;
  const [from, to, label] = L.expRange(S, e, TODAY);
  const { summary, rows } = L.exportSheets(S, from, to);
  const fname = `25학번_자봉_${label}.xlsx`;
  const R = [['month', '이번 달'], ['last', '지난달'], ['sem', '이번 학기'], ['all', '전체'], ['custom', '직접']];
  return `<div style="height:8px"></div><div><h1>내보내기 파일</h1><p class="sub">월·학기 단위로 엑셀 파일을 만들어 카톡방에 올리면, 앱에 들어오지 않아도 누구나 볼 수 있어요.</p></div>
  <div class="card">
  <div class="seg" style="flex-wrap:wrap">${R.map(([k, l]) => `<button class="${e.range === k ? 'on' : ''}" data-act="exp-range" data-v="${k}">${l}</button>`).join('')}</div>
  ${e.range === 'custom' ? `<div class="toolbar"><input type="date" id="exp-from" value="${esc(e.from)}" data-bind="exp.from" data-rerender="1" style="width:auto"><span class="note">~</span><input type="date" id="exp-to" value="${esc(e.to)}" data-bind="exp.to" data-rerender="1" style="width:auto"></div>` : ''}
  <p class="hint" style="margin:0">번호와 자봉 내역, 수정·무효 이력이 들어가요. 이름과 요청한 총대단은 빠져요. 이 파일 하나로 공지하고 보관해요.</p>
  <div class="note">${md(from)} ~ ${md(to)} · 파일 이름 <span class="mono">${esc(fname)}</span></div>
  <h2 style="font-size:14px">시트 1 · 요약 (${summary.length}명)</h2>
  <div class="tblwrap"><table class="tbl"><thead><tr><th>번호</th><th>기간 시작</th><th>기간 변동</th><th>현재 자봉</th></tr></thead>
  <tbody>${summary.slice(0, 6).map((r) => `<tr><td>${r.no}</td><td>${r.start}</td><td>${sgn(r.change)}</td><td><b>${r.end}</b></td></tr>`).join('')}<tr><td colspan="4" class="note">… 총 ${summary.length}명</td></tr></tbody></table></div>
  <h2 style="font-size:14px">시트 2 · 날짜별 내역 (${rows.length}건)</h2>
  <div class="tblwrap"><table class="tbl"><thead><tr><th>날짜</th><th>번호</th><th>항목</th><th>세부</th><th>점수</th><th>비고</th></tr></thead>
  <tbody>${rows.slice(0, 8).map((x) => `<tr class="${x.voided ? 'off' : ''}"><td>${md(x.date)}</td><td>${x.no}</td><td>${esc(x.item)}</td><td>${esc(x.detail)}</td><td>${sgn(x.points)}</td><td>${esc(x.note)}</td></tr>`).join('')}${rows.length > 8 ? `<tr><td colspan="6" class="note">… 총 ${rows.length}건</td></tr>` : ''}${!rows.length ? '<tr><td colspan="6" class="note">이 기간에 기록이 없어요.</td></tr>' : ''}</tbody></table></div>
  <p class="hint" style="margin:0">시트 3 · 수정 이력: 수정 시각, 날짜, 번호, 바뀐 내용, 사유</p>
  <button class="btn" data-act="exp-make">엑셀 파일 만들기</button></div>`;
}

function vPurge() {
  const cut = UI.purgeCut || '';
  const old = cut ? S.ledger.filter((e) => e.date <= cut) : [];
  const n = new Set(old.filter(live).map((e) => e.sid)).size;
  const ready = UI.fullBackup && old.length && UI.purgeTyped.trim() === '정리';
  return `<div class="card"><h2>보관 후 정리</h2>
  <p class="hint" style="margin:0">기준 날짜까지의 기록을 학생마다 <b>"이월" 한 줄</b>로 합쳐서 서버를 가볍게 해요. 현재 자봉 점수는 그대로예요. 지워진 기록은 앱에서 다시 볼 수 없으니, 먼저 전체 기간 파일로 받아두세요.</p>
  <p class="hint" style="margin:0">기록은 글자라서 몇 년을 써도 수 MB라, 보통은 1년에 한 번이면 충분해요.</p>
  <label class="fld"><span>기준 날짜 (이 날까지 정리)</span><input type="date" id="purge-cut" value="${esc(cut)}" data-bind="purgeCut" data-rerender="1" style="width:auto"></label>
  ${cut ? `<div class="note">정리 대상: 기록 ${old.length}건 → 이월 ${n}건${old.some((e) => e.voided) ? ` (무효 ${old.filter((e) => e.voided).length}건 포함)` : ''}</div>` : ''}
  ${UI.fullBackup ? '<div class="note" style="color:var(--merit)">✓ 전체 기간 파일을 받았어요</div>' : '<div class="warn">먼저 공지 탭 → 내보내기에서 <b>전체</b> 기간 파일을 만들어야 정리할 수 있어요.</div>'}
  <input id="purge-typed" placeholder="확인하려면 '정리'라고 입력" value="${esc(UI.purgeTyped)}" data-bind="purgeTyped" data-region="purge-btn" ${UI.fullBackup ? '' : 'disabled'}>
  <div id="purge-btn"><button class="btn danger" data-act="purge" ${ready ? '' : 'disabled'}>${cut ? `${md(cut)}까지 ` : ''}기록 정리하기</button></div></div>`;
}

function vManage() {
  const all = [...S.students].sort((a, b) => b.active - a.active || a.no - b.no);
  const plan = UI.rosterText.trim() ? L.planRoster(S, UI.rosterText, UI.rosterReplace) : null;
  const KIND = { add: ['추가', 'approved'], renum: ['번호 변경', 'pending'], restore: ['복귀', 'approved'], remove: ['제외', 'rejected'] };
  const cnt = (k) => (plan ? plan.changes.filter((c) => c.kind === k).length : 0);
  const total = plan ? plan.changes.length + plan.adjs.length : 0;
  return `<div><h1>관리</h1></div>
  <div class="card"><div class="req-top"><h2>명단 붙여넣기</h2><button class="btn ghost small" data-act="roster-copy">현재 명단 복사</button></div>
  <p class="hint" style="margin:0">엑셀에서 <b>번호·이름·자봉 열</b>을 복사해 붙여넣으세요. 자봉 열은 없어도 되고, 있으면 그 점수에 맞춰 조정돼요. 제목 줄은 있어도 괜찮아요. 학생은 <b>이름으로 알아보기</b> 때문에 번호가 바뀌어도 기록이 그대로 따라가요. 지금 명단을 고치려면 "현재 명단 복사" → 엑셀에서 수정 → 다시 붙여넣기.</p>
  <textarea id="roster-text" data-bind="rosterText" data-region="roster-preview" placeholder="번호&#9;이름&#9;자봉&#10;1&#9;김민서&#9;3&#10;2&#9;이도윤&#9;-1" style="min-height:110px;font-family:var(--mono)">${esc(UI.rosterText)}</textarea>
  <label class="who" style="color:var(--ink)"><input type="checkbox" id="roster-replace" data-bind="rosterReplace" data-rerender="1" ${UI.rosterReplace ? 'checked' : ''} style="width:auto">붙여넣은 명단에 없는 학생은 제외 (학기 전체 명단을 붙여넣을 때)</label>
  <div id="roster-preview" style="display:flex;flex-direction:column;gap:10px">${plan ? `<div class="btns">${Object.entries(KIND).map(([k, [l, c]]) => `<span class="pill ${c}">${l} ${cnt(k)}</span>`).join('')}<span class="pill pending">자봉 조정 ${plan.adjs.length}</span><span class="pill">그대로 ${plan.same}</span></div>
    ${plan.errors.length ? `<div class="warn">${plan.errors.map(esc).join('<br>')}</div>` : ''}
    ${total ? `<div class="mlist" style="max-height:220px">${plan.changes.map((c) => `<div class="mrow"><span class="pill ${KIND[c.kind][1]}">${KIND[c.kind][0]}</span><span class="grow">${esc(c.name)}</span><span class="mono note">${c.kind === 'renum' ? `${c.from} → ${c.no}` : c.kind === 'remove' ? `${c.from}번` : `${c.no}번`}</span></div>`).join('')}${plan.adjs.map((a) => `<div class="mrow"><span class="pill pending">자봉 조정</span><span class="grow">${esc(a.name)}</span><span class="mono note">${a.from} → ${a.to} (${sgn(a.delta)})</span></div>`).join('')}</div>` : '<p class="note">바뀌는 내용이 없어요.</p>'}
    ${plan.adjs.length ? '<p class="hint" style="margin:0">자봉 조정은 점수를 덮어쓰지 않고, 차이만큼 "자봉 조정" 기록을 추가해요. 처음 들어오는 학생은 "기존 누적"으로 기록돼요.</p>' : ''}
    <button class="btn" data-act="roster-apply" ${plan.errors.length || !total ? 'disabled' : ''}>${total}건 적용</button>` : ''}</div></div>

  <details class="card"><summary><b>명단 하나씩 고치기 (${active().length}명)</b></summary>
  <div class="req-top"><span></span><button class="btn ghost small" data-act="stu-add">학생 추가</button></div>
  <p class="hint" style="margin:0">번호를 바꿔도 기록은 그 학생을 따라가요. 제외해도 기록은 남아요. 이름은 출석 체크용이라 관리자에게만 보여요.</p>
  <div class="mlist">${all.map((s) => `<div class="mrow"><input type="number" class="no-in" data-sid="${s.id}" value="${s.no}" aria-label="번호" ${s.active ? '' : 'disabled'}><input class="grow name-in" data-sid="${s.id}" value="${esc(s.name)}" placeholder="이름" aria-label="이름" style="width:auto;min-width:0" ${s.active ? '' : 'disabled'}><span class="note">${s.active ? `자봉 ${bal(s.id)}` : '제외됨'}</span><button class="btn ghost small" data-act="stu-toggle" data-sid="${s.id}">${s.active ? '제외' : '복귀'}</button></div>`).join('')}</div>
  <button class="btn" data-act="nos-save">명단 저장</button></details>

  <div class="card"><div class="req-top"><h2>자주 쓰는 항목</h2><button class="btn ghost small" data-act="preset-add">항목 추가</button></div>
  <p class="hint" style="margin:0">지각·결석은 출석 체크에 쓰여요. 점수를 바꿔도 과거 기록은 그대로예요. 고친 뒤 "항목 저장"을 눌러야 반영돼요.</p>
  ${S.presets.map((p) => `<div class="mrow"><input class="grow pr-name" data-id="${p.id}" value="${esc(p.name)}" style="width:auto" ${['지각', '결석'].includes(p.name) ? 'readonly' : ''}><input type="number" class="pr-pts" data-id="${p.id}" value="${p.points}"><button class="btn ghost small" data-act="preset-del" data-id="${p.id}" ${['지각', '결석'].includes(p.name) ? 'disabled' : ''}>삭제</button></div>`).join('')}
  <button class="btn" data-act="presets-save">항목 저장</button></div>

  <div class="card"><h2>출석 체크 권한</h2>
  <p class="hint" style="margin:0">켜 둔 총대단은 출석 탭에서 출석을 체크하고 저장할 수 있어요. 부총대·총대는 항상 할 수 있어요.</p>
  ${S.accounts.filter((a) => !a.admin).map((a) => `<div class="mrow"><span class="grow">${esc(a.role)}</span><button class="btn small ${a.attend ? 'ok' : 'ghost'}" data-act="attend-perm" data-role="${esc(a.role)}" data-on="${a.attend ? '' : '1'}">${a.attend ? '켜짐' : '꺼짐'}</button></div>`).join('')}</div>

  <div class="card"><h2>비밀번호</h2>
  <p class="hint" style="margin:0">인수인계할 때는 다음 사람에게 지금 비밀번호와 복구 코드를 알려주고, 그 사람이 로그인해서 자기 비밀번호로 바꾸면 끝이에요.</p>
  <h2 style="font-size:14px">내 비밀번호 바꾸기 (${esc(UI.user)})</h2>
  <input type="password" id="pw-cur" placeholder="현재 비밀번호" autocomplete="current-password"><input type="password" id="pw-new" placeholder="새 비밀번호 (4자 이상)" autocomplete="new-password"><input type="password" id="pw-new2" placeholder="새 비밀번호 확인" autocomplete="new-password">
  <button class="btn ghost" data-act="pw-change">바꾸기</button>
  <h2 style="font-size:14px">다른 사람 비밀번호 재설정</h2>
  <p class="hint" style="margin:0">총대단이 비밀번호를 잊었거나 사람이 바뀌었을 때 써요. 그 직책은 로그아웃돼요.</p>
  <div class="row2"><select id="pw-who" class="grow">${S.accounts.map((a) => a.role).filter((r) => r !== UI.user).map((r) => `<option>${esc(r)}</option>`).join('')}</select><input type="password" id="pw-reset" class="grow" placeholder="새 비밀번호" autocomplete="new-password"></div>
  <button class="btn ghost" data-act="pw-reset">재설정</button>
  <h2 style="font-size:14px">복구 코드</h2>
  <p class="hint" style="margin:0">부총대와 총대가 둘 다 비밀번호를 잊었을 때 쓰는 비상 코드예요. 잃어버렸거나 다른 사람이 봤을 것 같으면 새로 만드세요. 이전 코드는 바로 못 쓰게 돼요.</p>
  <input type="password" id="rc-pw" placeholder="내 비밀번호 확인" autocomplete="current-password"><button class="btn ghost" data-act="rc-new">새 복구 코드 만들기</button></div>

  ${vPurge()}`;
}

function vLogin() {
  const list = UI.role === 'admin' ? admins() : officers();
  return `<div><h1>${UI.role === 'admin' ? '부총대·총대' : '총대단'} 로그인</h1><p class="sub">직책을 고르고 비밀번호를 입력하세요.</p></div>
  <div class="card"><label class="fld"><span>직책</span><select id="login-who">${list.map((o) => `<option>${esc(o)}</option>`).join('')}</select></label>
  <label class="fld"><span>비밀번호</span><input type="password" id="login-pw" autocomplete="current-password"></label>
  <button class="btn" data-act="login">로그인</button>
  <p class="hint" style="margin:0">${UI.role === 'admin' ? '비밀번호를 잊었으면 다른 관리자(부총대↔총대)에게 재설정을 부탁하세요. 둘 다 잊었으면 복구 코드를 쓰세요.' : '비밀번호를 잊었으면 부총대나 총대에게 재설정을 부탁하세요.'}</p>
  ${UI.role === 'admin' ? '<button class="btn ghost small" data-act="recover-open" style="align-self:flex-start">복구 코드로 들어가기</button>' : ''}</div>
  ${UI.role === 'admin' && UI.recover ? `<div class="card"><h2>복구 코드로 들어가기</h2>
  <label class="fld"><span>복구 코드</span><input id="rc-code" class="mono" placeholder="XXXX-XXXX-XXXX" autocomplete="off"></label>
  <label class="fld"><span>비밀번호를 새로 정할 사람</span><select id="rc-who">${admins().map((o) => `<option>${esc(o)}</option>`).join('')}</select></label>
  <input type="password" id="rc-new" placeholder="새 비밀번호 (4자 이상)" autocomplete="new-password"><input type="password" id="rc-new2" placeholder="새 비밀번호 확인" autocomplete="new-password">
  <button class="btn" data-act="recover">비밀번호 새로 정하고 로그인</button>
  <p class="hint" style="margin:0">복구 코드는 한 번 쓰면 새 코드로 바뀌어요.</p></div>` : ''}`;
}

/* ---------- 렌더 ---------- */

function render() {
  document.querySelectorAll('#roles button').forEach((b) => b.classList.toggle('on', b.dataset.role === UI.role));
  const sub = document.getElementById('subbar');
  const view = document.getElementById('view');
  const tabs = document.getElementById('tabs');
  if (!configured) {
    view.innerHTML = '<div class="card"><h2>설정이 필요해요</h2><p class="note">VITE_SUPABASE_URL과 VITE_SUPABASE_ANON_KEY 환경 변수를 넣고 다시 배포하세요. README의 "처음 설정"을 참고하세요.</p></div>';
    return;
  }
  if (!loaded) {
    view.innerHTML = loadError
      ? `<div class="card"><h2>불러오지 못했어요</h2><p class="note">${esc(loadError)}</p><button class="btn" data-act="reload">다시 시도</button></div>`
      : '<p class="boot">불러오는 중…</p>';
    return;
  }
  const locked = UI.role !== 'student' && !(UI.user && roleOf(UI.user) === UI.role);
  // 권한이 바뀌어 지금 탭을 더 못 쓰게 되면 첫 탭으로 옮긴다 (현황판은 누구나 볼 수 있다)
  if (!locked && UI.tab !== 'board' && !tabsOf(UI.role).some(([k]) => k === UI.tab)) UI.tab = tabsOf(UI.role)[0][0];
  sub.innerHTML =
    UI.role === 'student'
      ? UI.user ? `<div class="who"><b style="color:var(--ink)">${esc(UI.user)}</b>로 로그인됨 · 학생 화면 보는 중</div>` : ''
      : locked
        ? '<div class="mocknote">총대단과 부총대·총대는 자기 직책의 비밀번호로 로그인해요.</div>'
        : `<div class="who"><b style="color:var(--ink)">${esc(UI.user)}</b>로 로그인됨 <button class="btn ghost small" data-act="logout">로그아웃</button></div>`;
  const V = { board: vBoard, excuse: vExcuse, request: vRequest, reqs: vReqs, attend: vAttend, record: vRecord, inbox: vInbox, notice: vNotice, manage: vManage };
  const codeCard =
    !locked && UI.role === 'admin' && UI.newCode
      ? `<div class="card" style="border-color:var(--warn)"><h2>새 복구 코드</h2><div class="mono" style="font-size:22px;letter-spacing:.06em">${esc(UI.newCode)}</div>
    <p class="hint" style="margin:0">지금 캡처하거나 메모해서 따로 보관하세요. 이 화면을 닫으면 다시 보여주지 않아요. 인수인계할 때 비밀번호와 함께 넘겨주세요.</p>
    <div class="btns"><button class="btn ghost small" data-act="code-copy">복사</button><button class="btn small" data-act="code-ok">보관했어요</button></div></div>`
      : '';
  view.innerHTML = locked ? vLogin() : codeCard + (UI.sid ? vDetail() : (V[UI.tab] || vBoard)());
  const pc = pendingCount();
  tabs.innerHTML = locked
    ? ''
    : tabsOf(UI.role).map(([k, l]) => `<button class="${UI.tab === k && !UI.sid ? 'on' : ''}" data-act="tab" data-tab="${k}">${l}${k === 'inbox' && pc ? `<span class="badge">${pc}</span>` : ''}</button>`).join('');
}

// 다른 사람이 데이터를 바꿔서 다시 그려야 할 때, 입력 중이면 입력이 끝날 때까지 미룬다
let pendingRender = false;
function softRender() {
  const a = document.activeElement;
  if (a && a.closest('#view') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) pendingRender = true;
  else render();
}
document.addEventListener('focusout', () => {
  if (pendingRender) {
    pendingRender = false;
    setTimeout(softRender, 0);
  }
});

function setPath(p, v) {
  const k = p.split('.');
  if (k.length === 1) UI[k[0]] = v;
  else UI[k[0]][k[1]] = v;
}

// 입력칸은 그대로 두고 화면의 한 영역만 새로 그린다 (한글 입력이 끊기지 않게)
function updateRegion(id) {
  const V = { board: vBoard, record: vRecord, manage: vManage, notice: vNotice };
  if (!V[UI.tab] || UI.sid) return;
  const t = document.createElement('div');
  t.innerHTML = V[UI.tab]();
  const src = t.querySelector('#' + id);
  const dst = document.getElementById(id);
  if (src && dst) dst.innerHTML = src.innerHTML;
}
function rerenderKeep(el) {
  const id = el.id;
  let a = null;
  let z = null;
  try {
    a = el.selectionStart;
    z = el.selectionEnd;
  } catch {
    // date 입력 등은 커서 위치가 없다
  }
  render();
  const n = document.getElementById(id);
  if (n) {
    n.focus();
    try {
      if (a != null) n.setSelectionRange(a, z);
    } catch {
      // 위와 같음
    }
  }
}

document.addEventListener('input', (ev) => {
  const el = ev.target;
  const b = el.dataset?.bind;
  if (!b) return;
  setPath(b, el.type === 'checkbox' ? el.checked : el.value);
  if (b.endsWith('.preset')) {
    const fk = b.split('.')[0];
    const p = S.presets.find((x) => x.id === el.value);
    if (p) {
      UI[fk].item = p.name;
      UI[fk].points = p.points;
    }
  }
  if (b === 'noticeFrom' || b === 'noticeTo') UI.noticeText = null;
  if (el.dataset.picker) return ev.isComposing ? updateLive(el.dataset.picker) : commitPicker(el, false);
  if (el.dataset.live) return updateLive(el.dataset.live);
  if (el.dataset.region) return updateRegion(el.dataset.region);
  if (el.dataset.rerender && !ev.isComposing) rerenderKeep(el);
});
// 한글 조합 중에는 다시 그리지 않고, 글자가 완성된 뒤에 반영한다
document.addEventListener('compositionend', (ev) => {
  const el = ev.target;
  if (!el.dataset?.bind) return;
  setPath(el.dataset.bind, el.value);
  if (el.dataset.picker) commitPicker(el, false);
  else if (el.dataset.live) updateLive(el.dataset.live);
  else if (el.dataset.region) updateRegion(el.dataset.region);
  else if (el.dataset.rerender) rerenderKeep(el);
});

// 사진은 긴 변 720px JPEG로 줄여서 보낸다 (약 50~100KB)
document.addEventListener('change', (ev) => {
  const el = ev.target;
  const key = el.dataset?.photo;
  if (!key || !el.files?.[0]) return;
  const r = new FileReader();
  r.onload = () => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 720 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      UI[key].photo = c.toDataURL('image/jpeg', 0.7);
      render();
    };
    img.onerror = () => toast('사진을 읽지 못했어요. 다른 사진으로 해보세요');
    img.src = r.result;
  };
  r.readAsDataURL(el.files[0]);
});

/* ---------- 동작 ---------- */

const val = (id) => document.getElementById(id)?.value ?? '';

async function copyText(text, ok) {
  try {
    await navigator.clipboard.writeText(text);
    toast(ok);
    return true;
  } catch {
    return false;
  }
}

async function saveAttendance() {
  let pid = UI.attPid;
  const draft = attDraft(pid);
  if (pid.startsWith('v:')) {
    const per = periodsOf(UI.attDate).find((p) => p.id === pid);
    const real = await rpc('ensure_period', { p_token: token(), p_date: per.date, p_label: per.label, p_morning: per.morning });
    UI.draft[real] = draft;
    delete UI.draft[pid];
    UI.attPid = pid = real;
  }
  await run('save_attendance', { p_period: pid, p_statuses: draft }, (n) => `저장했어요 · 새 기록 ${n}건`);
  delete UI.draft[pid];
}

async function submitEntry(fk) {
  // 학생 칸에 치다 만 번호·이름이 있으면 먼저 선택으로 옮긴다
  const inp = document.getElementById(fk + '-find');
  if (inp && inp.value.trim()) {
    const { bad } = commitPicker(inp, true);
    if (bad.length) return toast(`학생 칸의 "${bad.join(', ')}"을(를) 목록에서 골라 주세요`);
  }
  const f = UI[fk];
  const { sids, bad } = parseNums(f.nums);
  const pts = Number(f.points);
  if (!f.item.trim()) return toast('항목명을 입력하세요');
  if (!L.isHalfStep(pts) || pts === 0) return toast('점수는 0이 아닌 0.5점 단위로 적어 주세요');
  if (!sids.length || bad.length) return toast('학생을 골라 주세요');
  const common = { p_date: f.date, p_sids: sids, p_item: f.item.trim(), p_detail: f.detail.trim(), p_points: pts };
  if (fk === 'reqForm') {
    await run('create_request', { ...common, p_reason: f.reason.trim(), p_photo: f.photo || null }, '요청을 보냈어요');
    UI.reqForm = { ...blankForm(), date: f.date };
  } else {
    await run('add_entries', common, `${sids.length}명에게 기록했어요`);
    UI.recForm = { ...blankForm(), date: f.date };
    UI.noticeText = null;
  }
  render();
  return true;
}

const A = {
  reload: async () => {
    await refresh();
  },
  role: (d) => {
    UI.role = d.role;
    UI.sid = null;
    UI.tab = tabsOf(d.role)[0][0];
    window.scrollTo(0, 0);
  },
  login: async () => {
    const who = val('login-who');
    const r = await rpc('login', { p_role: who, p_pw: val('login-pw') });
    if (r.error) return toast(r.error);
    setSession({ token: r.token, role: r.role });
    UI.user = r.role;
    UI.tab = tabsOf(UI.role)[0][0];
    await refresh();
  },
  logout: async () => {
    try {
      await rpc('logout', { p_token: token() });
    } catch {
      // 이미 만료된 로그인이어도 이 기기에서는 로그아웃한다
    }
    await signOut('로그아웃했어요');
    return true;
  },
  'recover-open': () => {
    UI.recover = !UI.recover;
  },
  recover: async () => {
    if (val('rc-new') !== val('rc-new2')) return toast('새 비밀번호 두 칸이 달라요');
    const r = await rpc('recover', { p_code: val('rc-code'), p_role: val('rc-who'), p_new: val('rc-new') });
    if (r.error) return toast(r.error);
    setSession({ token: r.token, role: r.role });
    UI.user = r.role;
    UI.newCode = r.code;
    UI.recover = false;
    UI.tab = TABS.admin[0][0];
    await refresh();
    render();
    return toast('비밀번호를 새로 정했어요 · 복구 코드가 바뀌었어요');
  },
  'code-ok': () => {
    UI.newCode = null;
  },
  'code-copy': async () => {
    if (!(await copyText(UI.newCode, '복사했어요'))) toast('길게 눌러 직접 복사하세요');
    return true;
  },
  'rc-new': async () => {
    UI.newCode = await rpc('new_recovery', { p_token: token(), p_pw: val('rc-pw') });
    render();
    window.scrollTo(0, 0);
    return toast('새 복구 코드를 만들었어요 · 이전 코드는 더 이상 안 돼요');
  },
  'pw-change': async () => {
    if (val('pw-new') !== val('pw-new2')) return toast('새 비밀번호 두 칸이 달라요');
    await rpc('change_pw', { p_token: token(), p_cur: val('pw-cur'), p_new: val('pw-new') });
    render();
    return toast('내 비밀번호를 바꿨어요');
  },
  'attend-perm': async (d) => {
    await run('set_attend', { p_role: d.role, p_on: Boolean(d.on) }, `${d.role} 출석 체크 권한을 ${d.on ? '켰어요' : '껐어요'}`);
    return true;
  },
  'pw-reset': async () => {
    const who = val('pw-who');
    await rpc('reset_pw', { p_token: token(), p_role: who, p_new: val('pw-reset') });
    render();
    return toast(`${who} 비밀번호를 재설정했어요. 본인에게 알려주세요`);
  },
  tab: (d) => {
    UI.tab = d.tab;
    UI.sid = null;
    window.scrollTo(0, 0);
  },
  open: (d) => {
    UI.sid = d.sid;
    window.scrollTo(0, 0);
  },
  back: () => {
    UI.sid = null;
  },
  sort: (d) => {
    UI.sort = d.v;
  },
  rev: (d) => {
    UI.openRev[d.id] = !UI.openRev[d.id];
  },
  photo: async (d) => {
    UI.photos[d.id] = (await rpc('get_photo', { p_token: token(), p_id: d.id })) ?? null;
  },
  'to-excuse': (d) => {
    UI.sid = null;
    UI.tab = 'excuse';
    UI.excForm = { no: d.no, eid: '', reason: '', photo: '' };
  },
  'to-record': (d) => {
    UI.sid = null;
    UI.tab = 'record';
    UI.recFilter = d.no;
  },
  pick: (d) => {
    addStudents(d.fk, [d.sid]);
    const inp = document.getElementById(d.fk + '-find');
    UI[d.fk].find = '';
    if (inp) {
      inp.value = '';
      inp.focus();
    }
    updateLive(d.fk);
    return true;
  },
  // 전체 명단에서 누를 때마다 선택·해제
  gtoggle: (d) => {
    const f = UI[d.fk];
    const { sids } = parseNums(f.nums);
    f.nums = (sids.includes(d.sid) ? sids.filter((x) => x !== d.sid) : [...sids, d.sid]).map(noOf).join(' ');
    updateLive(d.fk);
    return true;
  },
  pickgrid: () => {
    UI.pickGrid = !UI.pickGrid;
    try {
      localStorage.setItem('jabong-pickgrid', UI.pickGrid ? '1' : '');
    } catch {
      // 저장소를 못 쓰면 이번에만 적용된다
    }
  },
  unpick: (d) => {
    const f = UI[d.fk];
    f.nums = parseNums(f.nums).sids.filter((x) => x !== d.sid).map(noOf).join(' ');
    updateLive(d.fk);
    return true;
  },
  'roster-apply': async () => {
    const plan = L.planRoster(S, UI.rosterText, UI.rosterReplace);
    if (plan.errors.length) return toast('빨간 안내를 먼저 고쳐 주세요');
    const { ops, adjs } = L.rosterOps(plan);
    await run('roster_apply', { p_ops: ops, p_adjs: adjs, p_date: TODAY }, `명단 ${ops.length + adjs.length}건을 반영했어요`);
    UI.rosterText = '';
    render();
    return true;
  },
  'roster-copy': async () => {
    const t = '번호\t이름\t자봉\n' + active().map((s) => `${s.no}\t${s.name}\t${bal(s.id)}`).join('\n');
    if (!(await copyText(t, '복사했어요. 엑셀에 붙여넣어 고치세요'))) {
      UI.rosterText = t;
      render();
      toast('아래 칸에 넣어뒀어요. 직접 복사하세요');
    }
    return true;
  },
  attview: (d) => {
    UI.attView = d.v;
  },
  setst: (d) => {
    const dr = attDraft(UI.attPid);
    if (d.v === 'present') delete dr[d.sid];
    else dr[d.sid] = d.v;
  },
  cyc: (d) => {
    const dr = attDraft(UI.attPid);
    const order = ['present', 'late', 'absent', 'excused'];
    const n = order[(order.indexOf(dr[d.sid] || 'present') + 1) % 4];
    if (n === 'present') delete dr[d.sid];
    else dr[d.sid] = n;
  },
  'att-clear': () => {
    UI.attConfirm = true;
  },
  'att-clear-yes': () => {
    UI.draft[UI.attPid] = {};
    UI.attConfirm = false;
    toast('전원 출석으로 되돌렸어요 · 저장해야 반영돼요');
  },
  'att-clear-no': () => {
    UI.attConfirm = false;
  },
  'pick-period': (d) => {
    UI.attPid = d.id;
  },
  'add-period': async () => {
    const l = UI.newPeriod.trim();
    if (!l) return toast('교시 이름을 입력하세요');
    const id = await run('ensure_period', { p_date: UI.attDate, p_label: l, p_morning: false }, '교시를 추가했어요');
    UI.attPid = id;
    UI.newPeriod = '';
    render();
    return true;
  },
  'att-save': async () => {
    await saveAttendance();
    return true;
  },
  'rec-add': () => submitEntry('recForm'),
  'req-add': () => submitEntry('reqForm'),
  edit: (d) => {
    UI.editId = d.id;
    UI.voidId = null;
  },
  void: (d) => {
    UI.voidId = d.id;
    UI.editId = null;
  },
  'edit-cancel': () => {
    UI.editId = UI.voidId = null;
  },
  'edit-save': async (d) => {
    const pts = Number(val('ed-points'));
    if (!L.isHalfStep(pts) || pts === 0) return toast('점수는 0이 아닌 0.5점 단위로 적어 주세요');
    await rpc('edit_entry', { p_token: token(), p_id: d.id, p_date: val('ed-date'), p_item: val('ed-item'), p_detail: val('ed-detail'), p_points: pts, p_reason: val('ed-reason') });
    UI.editId = null;
    UI.noticeText = null;
    await refresh();
    render();
    return toast('수정했어요 · 이력에 남았어요');
  },
  'void-save': async (d) => {
    await rpc('void_entry', { p_token: token(), p_id: d.id, p_reason: val('vd-reason') });
    UI.voidId = null;
    UI.noticeText = null;
    await refresh();
    render();
    return toast('무효 처리했어요 · 점수에서 빠졌어요');
  },
  'req-ok': async (d) => {
    await run('review_request', { p_id: d.id, p_approve: true, p_note: null }, (n) => `승인했어요 · ${n}명 반영`);
    UI.noticeText = null;
    return true;
  },
  'req-no': async (d) => {
    await run('review_request', { p_id: d.id, p_approve: false, p_note: val('note-' + d.id) }, '반려했어요');
    return true;
  },
  'exc-ok': async (d) => {
    await run('review_excuse', { p_id: d.id, p_approve: true, p_note: null }, '공결을 승인했어요 · 해당 자봉이 무효 처리됐어요');
    UI.draft = {};
    UI.noticeText = null;
    return true;
  },
  'exc-no': async (d) => {
    await run('review_excuse', { p_id: d.id, p_approve: false, p_note: val('note-' + d.id) }, '반려했어요');
    return true;
  },
  'exc-add': async () => {
    const f = UI.excForm;
    const s = S.students.find((x) => x.active && x.no === Number(f.no));
    if (!s) return toast('번호를 확인하세요');
    if (!f.eid) return toast('공결 처리할 출결을 고르세요');
    await rpc('create_excuse', { p_student: s.id, p_ledger: f.eid, p_reason: f.reason.trim(), p_photo: f.photo || null });
    UI.excForm = { no: f.no, eid: '', reason: '', photo: '' };
    await refresh();
    render();
    return toast('신청했어요 · 부총대·총대 확인을 기다려요');
  },
  'done-more': () => {
    UI.doneLimit += 20;
  },
  'notice-gen': () => {
    UI.noticeText = null;
  },
  'notice-preset': (d) => {
    const last = lastDate();
    UI.noticeTo = last;
    if (d.v === 'week') {
      const t = new Date(last + 'T00:00:00');
      t.setDate(t.getDate() - 6);
      UI.noticeFrom = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    } else UI.noticeFrom = last;
    UI.noticeText = null;
  },
  copy: async () => {
    const t = document.getElementById('notice-text');
    if (!(await copyText(t.value, '복사했어요. 카톡 공지방에 붙여넣으세요'))) {
      t.focus();
      t.select();
      toast('문구를 선택했어요. 길게 눌러 복사하세요');
    }
    return true;
  },
  'exp-range': (d) => {
    UI.exp.range = d.v;
    if (d.v === 'custom' && !UI.exp.from) {
      UI.exp.from = TODAY.slice(0, 8) + '01';
      UI.exp.to = TODAY;
    }
  },
  'exp-make': async () => {
    const [from, to, label] = L.expRange(S, UI.exp, TODAY);
    await downloadExport(S, from, to, `25학번_자봉_${label}.xlsx`);
    if (UI.exp.range === 'all') UI.fullBackup = true;
    render();
    return toast('엑셀 파일을 만들었어요');
  },
  purge: async () => {
    if (!UI.fullBackup || UI.purgeTyped.trim() !== '정리') return toast('전체 기간 파일과 확인 입력이 필요해요');
    const r = await rpc('purge', { p_token: token(), p_cut: UI.purgeCut });
    UI.purgeTyped = '';
    UI.fullBackup = false;
    UI.noticeText = null;
    UI.noticeFrom = null;
    UI.draft = {};
    await refresh();
    render();
    return toast(`기록 ${r.old}건을 이월 ${r.carry}건으로 정리했어요`);
  },
  'stu-add': async () => {
    const no = Math.max(0, ...active().map((s) => s.no)) + 1;
    await run('roster_apply', { p_ops: [{ op: 'add', name: '', no }], p_adjs: [], p_date: TODAY }, `${no}번을 추가했어요. 이름을 적고 명단 저장을 누르세요`);
    return true;
  },
  'stu-toggle': async (d) => {
    const s = stu(d.sid);
    if (s.active) {
      await run('roster_apply', { p_ops: [{ op: 'remove', id: s.id }], p_adjs: [], p_date: TODAY }, '명단에서 제외했어요 (기록은 남아요)');
    } else {
      const no = S.students.some((x) => x.active && x.no === s.no) ? Math.max(0, ...active().map((x) => x.no)) + 1 : s.no;
      await run('roster_apply', { p_ops: [{ op: 'restore', id: s.id, no }], p_adjs: [], p_date: TODAY }, `${no}번으로 복귀했어요`);
    }
    return true;
  },
  'nos-save': async () => {
    const rows = [...document.querySelectorAll('.no-in:not([disabled])')].map((i) => ({
      id: i.dataset.sid,
      no: Number(i.value),
      name: document.querySelector(`.name-in[data-sid="${i.dataset.sid}"]`)?.value.trim() ?? '',
    }));
    if (rows.some((r) => !Number.isInteger(r.no) || r.no < 1)) return toast('번호는 1 이상의 정수여야 해요');
    if (new Set(rows.map((r) => r.no)).size !== rows.length) return toast('겹치는 번호가 있어요');
    const ops = [];
    rows.forEach((r) => {
      const s = stu(r.id);
      if (s.no !== r.no) ops.push({ op: 'renum', id: r.id, no: r.no });
      if (s.name !== r.name) ops.push({ op: 'rename', id: r.id, name: r.name });
    });
    if (!ops.length) return toast('바뀐 내용이 없어요');
    await run('roster_apply', { p_ops: ops, p_adjs: [], p_date: TODAY }, '명단을 저장했어요');
    return true;
  },
  'preset-add': () => {
    S.presets.push({ id: 'new' + Date.now(), name: '새 항목', points: 1 });
  },
  'preset-del': (d) => {
    S.presets = S.presets.filter((p) => p.id !== d.id);
  },
  'presets-save': async () => {
    const list = [...document.querySelectorAll('.pr-name')].map((i) => ({
      name: i.value.trim(),
      points: Number(document.querySelector(`.pr-pts[data-id="${i.dataset.id}"]`)?.value),
    }));
    if (list.some((p) => !Number.isInteger(p.points) || p.points === 0)) return toast('점수는 0이 아닌 정수여야 해요');
    await run('presets_save', { p_list: list }, '항목을 저장했어요');
    return true;
  },
};

let busy = false;
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || busy) return;
  const act = el.dataset.act;
  if (!/^att-clear/.test(act)) UI.attConfirm = false;
  const fn = A[act];
  if (!fn) return;
  busy = true;
  document.body.style.cursor = 'progress';
  try {
    const done = await fn(el.dataset);
    if (done !== true) render();
  } catch (e) {
    if (e.code === '28000') await signOut(e.message);
    else toast(e.message || '문제가 생겼어요. 다시 해보세요');
  } finally {
    busy = false;
    document.body.style.cursor = '';
  }
});

// 로그인 칸에서 Enter, 학생 칸에서 Enter
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.dataset?.picker && !ev.isComposing) {
    ev.preventDefault();
    const el = ev.target;
    const fk = el.dataset.picker;
    const { bad } = commitPicker(el, true);
    if (bad.length === 1) {
      const first = document.querySelector(`#${fk}-sugg [data-act="pick"]`);
      if (first) first.click();
    }
    return;
  }
  if (ev.key === 'Enter' && ev.target.id === 'login-pw') document.querySelector('[data-act="login"]')?.click();
});

async function boot() {
  const sess = getSession();
  if (sess) {
    UI.user = sess.role;
  }
  render();
  if (!configured) return;
  await refresh();
  if (UI.user) {
    UI.role = roleOf(UI.user);
    UI.tab = tabsOf(UI.role)[0][0];
  }
  render();
  let timer;
  onChange(() => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await refresh();
      softRender();
    }, 300);
  });
  // 오래 켜 둔 화면이 날짜를 넘기면 오늘 날짜를 다시 맞춘다
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      await refresh();
      softRender();
    }
  });
}

boot();
