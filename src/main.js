// 화면. 상태(S)는 서버에서 통째로 받아오고, 모든 변경은 서버 함수를 부른 뒤 다시 받아온다.
// UI는 화면 전용 상태(탭, 입력 중인 폼, 출석 초안 등)다.
import * as L from './logic.js';
import { esc, sgn, md, mdw, live } from './logic.js';
import { configured, rpc, onChange, getSession, setSession } from './api.js';
import { downloadExport } from './excel.js';
import { decryptBackup } from './backupcrypt.js';

let S = { students: [], presets: [], periods: [], att: {}, ledger: [], excuses: [], requests: [], attRequests: [], accounts: [], updatedAt: '' };
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
  attDate: TODAY, attPid: null, attView: 'list', draft: {}, touched: {}, newPeriod: '', recallPrev: {}, ddForm: null, ddDel: null, attConfirm: false, perDel: null, perEdit: null, perName: '', recalled: {},
  recForm: blankForm(), reqForm: blankForm(), exForm: blankForm(), excForm: { no: '', eid: '', reason: '', photo: '' }, reactForm: { no: '', period: '', q: '', a: '' },
  recFilter: '', editId: null, voidId: null, openRev: {}, photos: {},
  noticeFrom: null, noticeTo: null, noticeText: null,
  doneLimit: 20,
  hist: { list: null, limit: 50, preview: null, loading: false },
  bk: { pw: '', file: null, fileName: '', dump: null, typed: '' },
  pickGrid: (() => {
    try {
      return localStorage.getItem('jabong-pickgrid') === '1';
    } catch {
      return false;
    }
  })(),
  exp: { range: 'month', from: '', to: '' }, fullBackup: false, purgeCut: '', purgeTyped: '',
  rosterText: '', rosterReplace: false, rxAdjText: '', rxFeedN: 30, recover: false, newCode: null,
  // 학생이 정해 둔 "내 번호" (이 기기에만 기억한다)
  myNo: (() => {
    try {
      return Number(localStorage.getItem('jabong-myno')) || null;
    } catch {
      return null;
    }
  })(),
};
function setMyNo(no) {
  UI.myNo = no || null;
  try {
    if (no) localStorage.setItem('jabong-myno', String(no));
    else localStorage.removeItem('jabong-myno');
  } catch {
    // 저장소를 못 쓰면 이번에만 기억한다
  }
}
const myStudent = () => (UI.myNo ? S.students.find((x) => x.active && x.no === UI.myNo) : null);

const TABS = {
  student: [['board', '자봉 현황'], ['excuse', '공결 신청'], ['react', '리액션']],
  officer: [['request', '요청하기'], ['reqs', '요청 현황'], ['board', '자봉 현황']],
  admin: [['attend', '출석'], ['record', '자봉'], ['inbox', '요청함'], ['notice', '공지'], ['history', '작업 내역'], ['manage', '관리'], ['board', '자봉 현황']],
};
// 출석 권한을 받은 총대단(기본: 실습부장)은 맨 앞에 출석 탭이 생긴다
const canAttend = () => Boolean(S.accounts.find((a) => a.role === UI.user)?.attend);
// 학생 화면은 디데이 링크가 있으면 맨 앞(처음 여는 탭)이 디데이다
// 총대단·부총대는 디데이 관리자 링크가 있으면 맨 앞(처음 여는 탭)이 디데이다 (여기서 바로 추가·수정·삭제)
const tabsOf = (role) => {
  if (role === 'student') return ddayUrl() ? [['dday', '디데이'], ...TABS.student] : TABS.student;
  const base = role === 'officer' && UI.user && canAttend() ? [['attend', '출석'], ...TABS.officer] : TABS[role];
  return ddayAdminUrl() ? [['dday', '디데이'], ...base] : base;
};
const STATUS = { pending: '대기', approved: '승인', rejected: '반려' };
// 하루 전체 공결 신청은 여러 줄이어도 한 건으로 센다
const pendingCount = () =>
  [S.requests, S.attRequests || [], S.reactions || []].reduce((n, l) => n + l.filter((x) => x.status === 'pending').length, 0) + excGroups(S.excuses.filter((x) => x.status === 'pending')).length;

// 안내 문구. undo(작업 id)를 주면 "되돌리기" 버튼을 붙이고 조금 더 오래 보여 준다.
function toast(msg, undo) {
  const t = document.getElementById('toast');
  const span = document.createElement('span');
  span.textContent = msg;
  t.replaceChildren(span);
  if (undo) {
    const b = document.createElement('button');
    b.dataset.act = 'undo-last';
    b.dataset.id = undo;
    b.textContent = '되돌리기';
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), undo ? 7000 : 2600);
  return true;
}
// 부총대가 방금 한 작업이면 되돌리기 버튼을 붙인다 (되돌리기는 "이 작업만 되돌리기"와 같고 기록이 남지 않는다).
// before는 요청 전의 맨 위 작업 id. 요청이 새 작업을 만들지 않았으면(예: 이미 있는 교시 추가) 붙이지 않는다.
function doneToast(msg, before) {
  const o = S.lastOp;
  const undo = isAdmin() && o && o.id !== before && o.actor === UI.user && o.undoable && !o.undone && !o.dropped ? o.id : null;
  return toast(msg, undo);
}

/* ---------- 서버 ---------- */

async function refresh() {
  TODAY = L.today();
  try {
    const sess = getSession();
    S = sess ? await rpc('private_state', { p_token: sess.token }) : await rpc('public_state');
    loaded = true;
    loadError = null;
    // 학생 화면은 처음 열 때 디데이 탭부터 (디데이 링크가 있으면)
    if (!UI.firstTab) {
      UI.firstTab = true;
      if (UI.role === 'student' && UI.tab === 'board' && ddayUrl()) UI.tab = 'dday';
    }
    if (!UI.roleSet && UI.user) {
      UI.role = roleOf(UI.user);
      UI.tab = tabsOf(UI.role)[0][0];
      UI.roleSet = true;
    }
  } catch (e) {
    if (e.code === '28000') return signOut('로그인이 끊겼어요. 다시 로그인해 주세요');
    loadError = e.message;
  }
}

// 다른 기기의 변경으로 다시 불러온다. 그사이 새 작업이 생겼으면 열어 둔 작업 내역도 새로 불러온다
// (지난 목록을 보고 "맨 끝으로" 등을 누르면 남이 방금 한 작업을 되돌리게 된다. 실행 직전에도 hist-run이 한 번 더 확인한다)
async function refreshBg() {
  const before = JSON.stringify(S?.lastOp ?? null);
  await refresh();
  if (!busy && UI.hist.list && JSON.stringify(S?.lastOp ?? null) !== before) UI.hist = { ...UI.hist, list: null, loading: false };
  softRender();
}

// 서버 함수를 부르고, 성공하면 최신 상태를 다시 받아 화면을 그린다
async function run(fn, args, msg) {
  const before = S.lastOp?.id ?? null;
  const r = await rpc(fn, { p_token: token(), ...args });
  await refresh();
  // 다른 카드에 적던 반려 사유 같은 글자는 남긴다
  renderKeep();
  // 부총대가 데이터를 바꿨으면 공지 문구도 새로 만든다
  if (isAdmin()) UI.noticeText = null;
  if (msg) doneToast(typeof msg === 'function' ? msg(r) : msg, before);
  return r;
}

// 사람이 바뀌면 입력 중이던 내용(출석 초안, 폼)을 비운다
function resetDrafts() {
  clearDrafts();
  UI.recForm = blankForm();
  UI.reqForm = blankForm();
  UI.exForm = blankForm();
  UI.attPid = null;
  UI.photos = {};
  UI.prOpen = null;
  UI.prAdding = null;
  UI.newPeriod = '';
  UI.perDel = null;
  UI.perEdit = null;
  UI.attConfirm = false;
  UI.prOpen = null;
  UI.rosterOpen = false;
  UI.pwOpen = false;
  UI.hist = { list: null, limit: 50, preview: null, loading: false };
  UI.bk = { pw: '', file: null, fileName: '', dump: null, typed: '' };
}

async function signOut(msg) {
  setSession(null);
  resetDrafts();
  UI.user = null;
  UI.role = 'student';
  UI.tab = 'board';
  UI.sid = null;
  await refresh();
  UI.tab = tabsOf('student')[0][0];
  render();
  if (msg) toast(msg);
}

/* ---------- 화면 ---------- */

// 부총대만 (기록자·승인자 같은 관리 정보)
const isAdmin = () => UI.role === 'admin' && UI.user && roleOf(UI.user) === 'admin';
// 로그인한 총대단 전체(부총대 포함). 현황판과 학생 상세에 이름을 함께 보여 준다
const isStaff = () => UI.role !== 'student' && UI.user && roleOf(UI.user) === UI.role;

function vBoard() {
  const named = isStaff();
  let list = active().map((s) => ({ s, b: bal(s.id) }));
  const q = UI.q.trim();
  if (q) list = list.filter((x) => String(x.s.no).startsWith(q) || (named && L.nameMatch(x.s.name, q)));
  // 자봉 많은 순 정렬과 면제 표시는 총대단 화면에만
  if (named && UI.sort === 'bal') list.sort((a, b) => b.b - a.b || a.s.no - b.s.no);
  const me = UI.role === 'student' ? myStudent() : null;
  return `<div><h1>자봉 현황</h1><p class="live"><span class="dot"></span>실시간 반영 · 마지막 변경 ${esc(S.updatedAt)}</p></div>
  ${vInstall()}
  ${UI.role === 'student' && S.students.length ? vMyCard(me) : ''}
  ${vStoreLink()}
  <div class="toolbar"><input type="search" id="q" aria-label="학생 찾기" ${named ? '' : 'inputmode="numeric" '}placeholder="${named ? '번호·이름 검색' : '번호 검색'}" value="${esc(UI.q)}" data-bind="q" data-region="board-grid">
  ${named ? `<div class="seg"><button class="${UI.sort === 'no' ? 'on' : ''}" data-act="sort" data-v="no">번호순</button><button class="${UI.sort === 'bal' ? 'on' : ''}" data-act="sort" data-v="bal">자봉 많은 순</button></div>` : ''}</div>
  <div class="grid${named ? ' named' : ''}" id="board-grid">${list.map(({ s, b }) => `<button class="tile${me && me.id === s.id ? ' me' : ''}" data-act="open" data-sid="${s.id}"><span class="no">${s.no}</span>${named ? `<span class="nm">${esc(s.name)}</span>` : ''}<span class="pt">자봉 ${b}</span>${named && s.exempt ? '<span class="ex">면제</span>' : ''}</button>`).join('') || `<p class="empty">${S.students.length ? '찾는 학생이 없어요.' : '아직 명단이 없어요.'}</p>`}</div>`;
}

// 학급 매점 바로가기 (부총대가 관리 탭에서 넣은 링크). 새 창(폰은 구글 시트 앱)으로 열고 이 앱은 그대로 둔다.
// 서버도 https:// 주소만 받지만, 화면에서도 한 번 더 거른다 (javascript: 같은 주소가 링크가 되지 않게)
const storeUrl = () => (/^https:\/\/[^\s"<>]+$/.test(S.links?.store || '') ? S.links.store : null);
function vStoreLink() {
  const url = storeUrl();
  return url ? `<a class="btn store-btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">🛒 학급 매점 열기 <span aria-hidden="true">↗</span></a>` : '';
}

// ───────── 디데이 (학생 첫 탭) ─────────
// 관리 탭의 디데이 링크(디데이 사이트 주소 + #k=보기 키)로 그 사이트와 같은 마감 목록을 받아 그린다.
// 사이트 HTML에서 Apps Script 주소(var API = '…/exec')를 찾고, 거기서 목록(JSON)을 받는다. 사이트의 API 주소가 바뀌어도 따라간다.
// 마지막으로 받은 목록은 이 폰에 기억해 두어(jabong-dday) 다음에 열 때 바로 보이고, 뒤에서 새로 받는다.
// 목록의 칸은 title·due("YYYY-MM-DD" 또는 "YYYY-MM-DD HH:MM")·detail·room만 쓴다. 모르는 칸은 무시한다.
const ddayUrl = () => (/^https:\/\/[^\s"<>]+[#&]k=[^&\s]+/.test(S?.links?.dday || '') ? S.links.dday : null);
// 디데이 관리자 링크(관리자 키): 서버가 로그인한 총대단·부총대의 상태에만 싣는다. 총대단·부총대의 디데이 탭은 이 키로 받아 바로 추가·수정·삭제한다
const ddayAdminUrl = () => (UI.user && /^https:\/\/[^\s"<>]+[#&]k=[^&\s]+/.test(S?.links?.dday_admin || '') ? S.links.dday_admin : null);
const DDAY_KEY = 'jabong-dday';
let dday = null; // { src, data, at, err, loading }
function ddayCache(src) {
  try {
    const c = JSON.parse(localStorage.getItem(DDAY_KEY) || 'null');
    return c && c.src === src && c.data ? c : null;
  } catch {
    return null;
  }
}
async function ddayFetch(src) {
  const key = decodeURIComponent(/[#&]k=([^&]+)/.exec(src)[1]);
  const page = src.split('#')[0];
  const html = await (await fetch(page, { credentials: 'omit', cache: 'no-cache' })).text();
  const api = /var\s+API\s*=\s*['"](https:\/\/script\.google\.com\/[^'"\s]+)['"]/.exec(html)?.[1];
  if (!api) throw Object.assign(new Error('디데이 사이트에서 목록 주소를 찾지 못했어요'), { kind: 'api' });
  // 디데이 사이트와 같은 방식으로 부른다 (t는 캐시를 피하려는 값)
  const d = await (await fetch(`${api}?k=${encodeURIComponent(key)}&t=${Date.now()}`, { credentials: 'omit' })).json();
  if (!d || !d.ok) throw Object.assign(new Error('디데이 보기 키가 맞지 않아요. 부총대에게 알려 주세요'), { kind: 'key' });
  // lastSync: 마지막으로 정리한 때 (예전 사이트는 now·lastMessage). admin: 관리자 키면 true (추가·수정·삭제 가능), rooms: 분류(단톡방) 목록
  return { tasks: Array.isArray(d.tasks) ? d.tasks : [], lastSync: String(d.lastSync || d.now || ''), admin: !!d.admin, rooms: Array.isArray(d.rooms) ? d.rooms.map(String) : [], api };
}
// 디데이 사이트와 같은 방식으로 고친다: 관리자 키를 token에 넣어 text/plain으로 POST ({type: add|edit|delete, id, title, due, room, detail})
async function ddayPost(src, api, body) {
  const token = decodeURIComponent(/[#&]k=([^&]+)/.exec(src)[1]);
  let d;
  try {
    d = await (await fetch(api, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...body, token }) })).json();
  } catch {
    throw new Error('디데이 서버에 닿지 못했어요. 잠시 뒤 다시 해 보세요');
  }
  if (!d || !d.ok) throw new Error(d?.error ? `디데이: ${d.error}` : '디데이에 저장하지 못했어요');
}
function ddayLoad(src, force) {
  const admin = src === ddayAdminUrl();
  if (dday?.src !== src) dday = { src, ...((!admin && ddayCache(src)) || {}), err: null, loading: false };
  // 고친 뒤에는 바로 다시 받는다 (그 전에 보낸 요청의 결과는 버린다)
  else if (force) dday = { src, data: dday.data, err: null, loading: false };
  // 1분 안에 받았으면 다시 받지 않는다 (탭을 오갈 때마다 구글을 부르지 않게)
  if (dday.loading || (!force && dday.at && Date.now() - dday.at < 60000)) return dday;
  const cur = dday;
  cur.loading = true;
  ddayFetch(src)
    .then((data) => {
      Object.assign(cur, { data, at: Date.now(), err: null });
      // 관리자 목록은 폰에 기억하지 않는다 (주소에 관리자 키가 들어 있다)
      if (!admin)
        try {
          localStorage.setItem(DDAY_KEY, JSON.stringify({ src, data, at: cur.at }));
        } catch {}
    })
    .catch((e) => {
      cur.err = e.kind ? e.message : '디데이를 불러오지 못했어요';
      cur.at = Date.now();
    })
    .finally(() => {
      cur.loading = false;
      if (dday === cur && UI.tab === 'dday') softRender();
    });
  return cur;
}
const WD = ['일', '월', '화', '수', '목', '금', '토'];
function ddayDue(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(String(s || ''));
  if (!m) return null;
  return { day: new Date(+m[1], m[2] - 1, +m[3]), end: new Date(+m[1], m[2] - 1, +m[3], m[4] ? +m[4] : 23, m[5] ? +m[5] : 59), hm: m[4] ? `${m[4]}:${m[5]}` : '' };
}
function vDday() {
  // 총대단·부총대는 관리자 키로 (추가·수정·삭제), 학생은 보기 키로
  const src = UI.role !== 'student' ? ddayAdminUrl() : ddayUrl();
  if (!src) return vBoard();
  const D = ddayLoad(src);
  const adm = !!D.data?.admin && UI.role !== 'student';
  const open = `<a class="btn ghost small" href="${esc(src)}" target="_blank" rel="noopener noreferrer">원본 사이트 열기 ↗</a>`;
  const head = `<div><h1>디데이</h1><p class="sub">카톡 공지를 AI가 자동으로 정리한 목록입니다. 빠지거나 틀릴 수 있으니 중요한 건 꼭 원문 공지를 확인하세요.</p>${D.data ? `<p class="note">마지막 정리 ${esc(String(D.data.lastSync || '').slice(5) || '-')}</p>` : ''}</div>`;
  if (!D.data) return `${head}${D.err ? `<div class="warn">${esc(D.err)}</div><div class="btns">${open}</div>` : '<p class="boot">불러오는 중…</p>'}`;
  // 지난 마감과 날짜가 없는 것은 숨기고 오늘·내일·7일 이내·그 이후로 나눈다 (원본 사이트와 같다)
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const groups = { today: [], tomorrow: [], week: [], later: [] };
  D.data.tasks.forEach((t) => {
    const d = ddayDue(t?.due);
    if (!d || d.end < now) return;
    const diff = Math.round((d.day - today) / 864e5);
    groups[diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : diff <= 7 ? 'week' : 'later'].push({ t, d, diff });
  });
  const item = ({ t, d, diff }) => `<div class="card dd-item"><div class="dd-when"><div class="dd-md">${d.day.getMonth() + 1}/${d.day.getDate()}</div><div class="note">${WD[d.day.getDay()]}요일</div>
    <div class="dd-d ${diff === 0 ? 'hot' : diff <= 2 ? 'warm' : ''}">${diff === 0 ? 'D-day' : `D-${diff}`}</div></div>
    <div class="dd-body"><b>${esc(t.title)}</b><div class="note">${d.hm ? `<b>${d.hm}</b>${diff === 0 ? ' 까지' : ''}` : '시각 미정 (당일 중)'}</div>
    ${t.detail ? `<div class="dd-detail">${esc(t.detail)}</div>` : ''}${t.room || (adm && t.manual) ? `<div class="btns">${t.room ? `<span class="pill">${esc(t.room)}</span>` : ''}${adm && t.manual ? '<span class="pill pending">직접 입력</span>' : ''}</div>` : ''}
    ${adm && t.id != null ? ddayActs(t) : ''}</div></div>${adm && UI.ddForm?.id === String(t.id) ? ddayFormCard(D) : ''}`;
  const list = [['today', '오늘'], ['tomorrow', '내일'], ['week', '7일 이내'], ['later', '그 이후']]
    .filter(([k]) => groups[k].length)
    .map(([k, l]) => `<h2>${l} · ${groups[k].length}</h2>${groups[k].sort((a, b) => a.d.end - b.d.end).map(item).join('')}`)
    .join('');
  const adminBar = adm
    ? `<div class="card dd-admin"><div class="req-top"><b>관리자 모드</b>${UI.ddForm?.id === '' ? '' : '<button class="btn small" data-act="dd-new">＋ 일정 추가</button>'}</div>
    <p class="hint" style="margin:0">여기서 고치거나 지운 일정은 다음 정리 때도 그대로예요. 학생 화면에도 반영돼요.</p></div>${UI.ddForm?.id === '' ? ddayFormCard(D) : ''}`
    : D.data && UI.role !== 'student' ? '<div class="warn">이 링크의 키로는 일정을 고칠 수 없어요. 관리 탭의 "디데이 관리자 링크"에 관리자 키가 든 주소를 넣어 주세요.</div>' : '';
  return `${head}${D.err ? `<div class="warn">${esc(D.err)}${D.data ? ' (전에 받아 둔 목록을 보여 줘요)' : ''}</div>` : ''}
  ${adminBar}
  ${UI.role === 'student' ? vStoreLink() : ''}
  ${list || '<p class="empty">다가오는 마감이 없어요.</p>'}
  <div class="btns">${open}</div>`;
}
// 일정의 수정·삭제 버튼 (삭제는 한 번 더 묻는다)
function ddayActs(t) {
  const id = String(t.id);
  if (UI.ddDel === id)
    return `<div class="att-confirm"><span>"${esc(t.title)}" 일정을 지울까요? 다음 정리 때도 다시 나타나지 않아요.</span>
    <div class="btns"><button class="btn danger small" data-act="dd-del-yes" data-id="${esc(id)}">네, 지우기</button><button class="btn ghost small" data-act="dd-del-no">그만두기</button></div></div>`;
  return `<div class="btns"><button class="btn ghost small" data-act="dd-edit" data-id="${esc(id)}">수정</button><button class="btn ghost small" data-act="dd-del" data-id="${esc(id)}">삭제</button></div>`;
}
// 일정 추가·수정 칸 (UI.ddForm: id가 ''면 새 일정)
function ddayFormCard(D) {
  const f = UI.ddForm;
  const rooms = [...(D.data.rooms || [])];
  if (f.room && !rooms.includes(f.room)) rooms.push(f.room);
  return `<div class="card dd-form" id="dd-form"><h2>${f.id ? '일정 수정' : '일정 추가'}</h2>
  <label class="fld"><span>제목</span><input id="dd-title" maxlength="100" value="${esc(f.title)}" data-bind="ddForm.title" autocomplete="off" placeholder="예: 구강해부학 과제 제출"></label>
  <div class="row2"><label class="fld grow"><span>날짜</span><input type="date" id="dd-date" value="${esc(f.date)}" data-bind="ddForm.date"></label>
  <label class="fld grow"><span>시각 (모르면 비워 두기)</span><input type="time" id="dd-time" value="${esc(f.time)}" data-bind="ddForm.time"></label></div>
  <label class="fld"><span>분류</span><select id="dd-room" data-bind="ddForm.room">${[...rooms, ''].map((r) => `<option value="${esc(r)}" ${f.room === r ? 'selected' : ''}>${r ? esc(r) : '기타'}</option>`).join('')}</select></label>
  <label class="fld"><span>세부 내용 (선택)</span><textarea id="dd-detail" maxlength="500" data-bind="ddForm.detail">${esc(f.detail)}</textarea></label>
  <div class="btns"><button class="btn" data-act="dd-save">저장</button><button class="btn ghost" data-act="dd-cancel">취소</button></div></div>`;
}

// 홈 화면에 앱으로 추가 (manifest.webmanifest). 안드로이드 크롬은 버튼, 아이폰은 Safari 공유 메뉴 안내.
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  if (loaded) softRender();
});
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
function vInstall() {
  if (standalone()) return '';
  if (installEvt) return '<button class="btn ghost small" data-act="install" style="align-self:flex-start">홈 화면에 앱으로 추가</button>';
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) return '<p class="hint" style="margin:0">Safari 아래쪽 공유 버튼 → "홈 화면에 추가"를 누르면 앱처럼 쓸 수 있어요.</p>';
  return '';
}

// 학생 화면 맨 위: 내 번호의 자봉과 최근 기록. 정하지 않았으면 정하는 칸.
function vMyCard(me) {
  if (!me)
    return `<div class="card mycard"><div class="toolbar"><input id="myno" inputmode="numeric" aria-label="내 번호" placeholder="내 번호" style="width:110px" autocomplete="off"><button class="btn ghost small" data-act="myno-set">내 번호로 정하기</button></div>
    <p class="hint" style="margin:0">이 폰에만 기억해요. 정해 두면 여기서 내 자봉과 최근 내역을 바로 보고, 공결 신청에도 번호가 미리 들어가요.</p></div>`;
  const es = S.ledger.filter((e) => e.sid === me.id).reverse().sort((a, c) => c.date.localeCompare(a.date) || c.at.localeCompare(a.at)).slice(0, 3);
  const b = bal(me.id);
  return `<div class="card mycard"><div class="req-top"><b>내 번호 ${me.no}</b><span class="mybal">자봉 ${b}</span></div>
  ${es.map((e) => `<div class="rec-row"><span class="note mono">${md(e.date)}</span><span class="${e.voided ? 'off' : ''}">${esc(e.item)}${e.voided ? ' · 무효' : ''}</span><span class="pts ${e.points > 0 ? 'p' : 'm'} ${e.voided ? 'off' : ''}">${sgn(e.points)}</span></div>`).join('') || '<p class="note" style="margin:0">아직 기록이 없어요.</p>'}
  <div class="btns"><button class="btn ghost small" data-act="open" data-sid="${me.id}">전체 보기</button><button class="btn ghost small" data-act="to-excuse" data-no="${me.no}">공결 신청</button><button class="btn ghost small" data-act="myno-clear">번호 바꾸기</button></div></div>`;
}

function vDetail() {
  const s = stu(UI.sid);
  if (!s) return '<button class="back" data-act="back">← 자봉 현황</button><p class="empty">학생을 찾을 수 없어요.</p>';
  const b = bal(s.id);
  // 서버 목록은 오래된 순이라 뒤집은 뒤 정렬한다: 화면 시각이 분 단위여서 같은 분에 생긴 기록도 최신이 위로 온다
  const es = S.ledger.filter((e) => e.sid === s.id).reverse().sort((a, c) => c.date.localeCompare(a.date) || c.at.localeCompare(a.at));
  const dates = [...new Set(es.map((e) => e.date))];
  const admin = isAdmin();
  const ev = (e) => {
    const open = UI.openRev[e.id];
    return `<li class="ev ${e.voided ? 'void' : ''}">
    <div class="ev-main"><span class="item">${esc(e.item)}${e.detail ? `<em>${esc(e.detail)}</em>` : ''}</span><span class="pts ${e.points > 0 ? 'p' : 'm'}">${sgn(e.points)}</span></div>
    ${e.voided ? `<div class="note">무효 · ${esc(e.voided.reason)} · ${esc(e.voided.at)}</div>` : ''}
    ${e.revs?.length ? `<button class="revbtn" data-act="rev" data-id="${e.id}">수정됨 ${e.revs.length}회 ${open ? '▾' : '▸'}</button>
      ${open ? e.revs.map((r) => `<div class="rev"><span>${esc(r.at)}</span>${Object.keys(r.after).map((k) => `<b>${L.fieldName(k)}: ${esc(L.fmtVal(k, r.before[k]))} → ${esc(L.fmtVal(k, r.after[k]))}</b>`).join('')}<span>사유: ${esc(r.reason)}</span></div>`).join('') : ''}` : ''}
    ${admin ? `<div class="note">${e.src === 'request' ? `요청: ${esc(e.by)} · 승인: ${esc(e.approvedBy)}` : e.requestedBy ? `출석 요청: ${esc(e.requestedBy)} · 승인: ${esc(e.approvedBy)}` : `기록: ${esc(e.by || '-')}`}${e.voided?.by ? ` · 무효 처리: ${esc(e.voided.by)}` : ''}${e.revs?.length ? ` · 수정: ${esc([...new Set(e.revs.map((r) => r.by))].join(', '))}` : ''} (관리자에게만 보임)</div>` : ''}
  </li>`;
  };
  return `<button class="back" data-act="back">← 자봉 현황</button>
  <div class="hero"><div><h1>${s.no}번${isStaff() && s.name ? ` <span class="sub" style="font-size:15px">${esc(s.name)}</span>` : ''}</h1><p class="sub">${isStaff() && s.exempt ? '<b>자봉 면제</b> · 상점만 받아요 · ' : ''}자봉·상점 ${es.filter(live).length}건${es.some((e) => e.voided) ? ` · 무효 ${es.filter((e) => e.voided).length}건` : ''}</p></div>
  <div style="text-align:right"><div class="sub">자봉</div><div class="big ${b > 0 ? 'p' : b < 0 ? 'm' : ''}">${b}</div></div></div>
  ${UI.role === 'student' ? `<button class="btn ghost" data-act="to-excuse" data-no="${s.no}">이 번호로 공결 신청</button>${UI.myNo !== s.no ? `<button class="btn ghost small" data-act="myno-set" data-no="${s.no}" style="align-self:flex-start">이 번호를 내 번호로 정하기</button>` : ''}` : ''}
  ${admin ? `<button class="btn ghost" data-act="to-record" data-sid="${s.id}">이 학생 자봉·상점 수정·무효 처리</button>` : ''}
  <div>${dates.map((d) => `<div class="day">${mdw(d)}</div><ul class="evs">${es.filter((e) => e.date === d).map(ev).join('')}</ul>`).join('') || '<p class="empty">아직 자봉·상점이 없어요.</p>'}</div>`;
}

function liveParts(fk) {
  const f = UI[fk];
  const { sids, bad } = parseNums(f.nums);
  // 추천은 입력칸의 마지막 낱말로 찾는다 (앞의 낱말은 띄어쓰기할 때 이미 선택으로 옮겨진다)
  const fq = (f.find || '').trim().split(/[\s,]+/).pop() || '';
  const sg = fq ? active().filter((s) => L.nameMatch(s.name, fq) || String(s.no).startsWith(fq)).slice(0, 8) : [];
  const dup = L.dupNums(S, f);
  return {
    sugg: sg.length
      ? `<div class="sugg">${sg.map((s) => `<button data-act="pick" data-fk="${fk}" data-sid="${s.id}"><span class="mono">${s.no}</span> ${esc(s.name)}${sids.includes(s.id) ? ' ✓' : ''}</button>`).join('')}</div>`
      : fq ? '<p class="note">일치하는 학생이 없어요.</p>' : '',
    chips: `${sids.map((id) => `<button class="chip" data-act="unpick" data-fk="${fk}" data-sid="${id}" aria-label="${noOf(id)}번 빼기">${noOf(id)} ${esc(stu(id).name)}${stu(id).exempt ? ' · 면제' : ''} ×</button>`).join('')}${bad.map((x) => `<span class="chip bad">${esc(x)} 없음</span>`).join('')}`,
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

// 점수 칸: 가운데는 숫자를 직접 적고, 오른쪽 ▾를 누르면 바로 아래에 작은 숫자판이 뜬다.
// 숫자를 누르면 곧바로 들어가고 숫자판은 닫힌다 (폰 기본 선택창처럼 "완료"를 누를 필요가 없다).
// 윗줄 자봉 +5 → +1, 아랫줄 상점 -5 → -1 (둘 다 왼쪽부터 큰 수)
const POINT_CHOICES = [5, 4, 3, 2, 1, -5, -4, -3, -2, -1];
function pointsField(fk) {
  const f = UI[fk];
  return `<div class="ptsbox"><input type="number" step="0.5" inputmode="decimal" id="${fk}-points" value="${esc(f.points)}" data-bind="${fk}.points" aria-label="점수 직접 입력">
  <button type="button" class="ptsdrop" data-act="pts-open" data-fk="${fk}" aria-label="점수 고르기" aria-expanded="false">▾</button>
  <div class="ptspop" id="${fk}-ptspop" hidden>${POINT_CHOICES.map((p) => `<button type="button" class="${p > 0 ? 'p' : 'm'}" data-act="pts-pick" data-fk="${fk}" data-v="${p}">${sgn(p)}</button>`).join('')}</div></div>`;
}
function closePtsPops(except) {
  document.querySelectorAll('.ptspop').forEach((el) => {
    if (el !== except) {
      el.hidden = true;
      el.parentElement.querySelector('.ptsdrop')?.setAttribute('aria-expanded', 'false');
    }
  });
}

const myPresets = () => S.presets.filter((p) => UI.user && p.owner === UI.user && p.kind !== 'period');
const myPeriodPresets = () => S.presets.filter((p) => UI.user && p.owner === UI.user && p.kind === 'period');
// 항목명 칸 오른쪽 "불러오기": 내 자주 쓰는 항목을 고르고, 지금 적은 항목을 추가·삭제한다 (직책마다 따로, 공용 없음)
// fk가 'np'이면 출석 "교시 추가" 칸의 자주 쓰는 교시(이름만)
function presetPop(fk) {
  if (fk === 'np') {
    const list = myPeriodPresets().map((p) => `<div class="pr-row"><button type="button" class="pr-use" data-act="pr-use" data-fk="np" data-id="${p.id}">${esc(p.name)}${p.points > 1 ? ` · ${p.points}시간` : ''}</button><button type="button" class="pr-del" data-act="pr-del" data-fk="np" data-id="${p.id}" aria-label="${esc(p.name)} 삭제">×</button></div>`).join('');
    const form = UI.prAdding === 'np'
      ? `<div class="pr-new one"><input id="np-prname" placeholder="교시 이름 (예: 1교시 구강해부학)" autocomplete="off" enterkeyhint="done">${hoursSel('np-prhours', 1)}
      <div class="btns"><button type="button" class="btn small" data-act="pr-save" data-fk="np">추가</button><button type="button" class="btn ghost small" data-act="pr-cancel" data-fk="np">취소</button></div></div>`
      : '<button type="button" class="pr-add" data-act="pr-add" data-fk="np">＋ 자주 쓰는 교시 추가</button>';
    return (list || '<p class="note" style="margin:0">아직 없어요. 아래 버튼으로 자주 쓰는 교시를 만들어 두세요.</p>') + form;
  }
  const list = myPresets().map((p) => `<div class="pr-row"><button type="button" class="pr-use" data-act="pr-use" data-fk="${fk}" data-id="${p.id}">${esc(p.name)} <b class="${p.points > 0 ? 'p' : 'm'}">${sgn(p.points)}</b></button><button type="button" class="pr-del" data-act="pr-del" data-fk="${fk}" data-id="${p.id}" aria-label="${esc(p.name)} 삭제">×</button></div>`).join('');
  const empty = '<p class="note" style="margin:0">아직 없어요. 아래 버튼으로 자주 쓰는 항목을 만들어 두세요.</p>';
  // "추가"를 누르면 그 자리에서 항목명·점수를 새로 적는다 (자주 쓰는 항목 점수는 정수)
  const form = UI.prAdding === fk
    ? `<div class="pr-new"><input id="${fk}-prname" placeholder="항목명" autocomplete="off" enterkeyhint="done"><input id="${fk}-prpts" type="number" inputmode="numeric" step="1" value="1" aria-label="점수" enterkeyhint="done">
    <div class="btns"><button type="button" class="btn small" data-act="pr-save" data-fk="${fk}">추가</button><button type="button" class="btn ghost small" data-act="pr-cancel" data-fk="${fk}">취소</button></div></div>`
    : `<button type="button" class="pr-add" data-act="pr-add" data-fk="${fk}">＋ 자주 쓰는 항목 추가</button>`;
  return (list || empty) + form;
}
function openPresetPop(fk) {
  const pop = document.getElementById(fk + '-prpop');
  if (!pop) return;
  pop.innerHTML = presetPop(fk);
  pop.hidden = false;
  document.querySelector(`[data-act="pr-open"][data-fk="${fk}"]`)?.setAttribute('aria-expanded', 'true');
}
function closePresetPops() {
  UI.prOpen = null;
  UI.prAdding = null;
  document.querySelectorAll('.prpop').forEach((el) => (el.hidden = true));
  document.querySelectorAll('[data-act="pr-open"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

function entryFields(fk) {
  const f = UI[fk];
  const P = liveParts(fk);
  // 학생을 먼저 고르고 항목·점수를 적는다
  return `<label class="fld"><span>학생</span><input id="${fk}-find" type="search" value="${esc(f.find)}" placeholder="이름이나 번호 (예: 김민, 56 59)" autocomplete="off" enterkeyhint="done" data-bind="${fk}.find" data-picker="${fk}"></label>
  <p class="hint">이름 일부를 치고 목록에서 고르거나, 번호를 띄어 쓰며 연달아 적으세요.</p>
  <div id="${fk}-sugg">${P.sugg}</div>
  <div class="req-top"><button class="btn ghost small" data-act="pickgrid">${UI.pickGrid ? '전체 명단 닫기 ▴' : '전체 명단에서 누르기 ▾'}</button><span class="note" id="${fk}-count">${P.count}</span></div>
  <div id="${fk}-grid">${P.grid}</div>
  <div class="chips" id="${fk}-chips">${P.chips}</div>
  <div id="${fk}-dup">${P.dup}</div>
  <div class="fld"><label for="${fk}-item">항목명</label><div class="itembox"><input id="${fk}-item" value="${esc(f.item)}" placeholder="예: 실습실 뒷정리 미흡" autocomplete="off" data-bind="${fk}.item" data-live="${fk}" data-suggest="item" data-fk="${fk}">
  <button type="button" class="itemdrop" data-act="pr-open" data-fk="${fk}" aria-expanded="${UI.prOpen === fk}">불러오기</button>
  <div class="prpop" id="${fk}-prpop" ${UI.prOpen === fk ? '' : 'hidden'}>${UI.prOpen === fk ? presetPop(fk) : ''}</div></div></div>
  <div class="row2"><label class="fld grow"><span>날짜</span><input type="date" id="${fk}-date" value="${esc(f.date)}" data-bind="${fk}.date" data-rerender="1"></label>
  <label class="fld pts-fld"><span>점수</span>${pointsField(fk)}</label></div>
  <p class="hint">+는 자봉, −는 상점이에요. 항목명 칸을 누르면 최근·자주 쓴 항목이, "불러오기"를 누르면 내 자주 쓰는 항목이 떠요.</p>
  <label class="fld"><span>세부내용 (선택)</span><input id="${fk}-detail" value="${esc(f.detail)}" placeholder="예: 전원 안끔" autocomplete="off" data-bind="${fk}.detail" data-suggest="detail" data-fk="${fk}"></label>`;
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
  return `<div><h1>상점·자봉 요청</h1><p class="sub">부총대가 승인하면 반영돼요. 요청자 이름은 학생들에게 보이지 않아요.</p></div>
  <div class="card">${entryFields('reqForm')}
  <label class="fld"><span>사유 (선택)</span><textarea id="reqForm-reason" data-bind="reqForm.reason" data-suggest="reqReason" placeholder="필요하면 적어주세요">${esc(f.reason)}</textarea></label>
  ${photoField('reqForm', f.photo)}
  <button class="btn" data-act="req-add">요청 보내기</button></div>
`;
}

function reqCard(r, admin) {
  return `<div class="card"><div class="req-top"><span class="pill ${r.status}">${STATUS[r.status]}</span><span class="note">${esc(r.by)} · ${esc(r.at)}</span></div>
  <div class="req-body"><b>${esc(r.item)}</b>${r.detail ? ` · ${esc(r.detail)}` : ''} <span class="pts ${r.points > 0 ? 'p' : 'm'}">${sgn(r.points)}</span> · ${md(r.date)}</div>
  <div class="chips">${r.sids.map((id) => `<span class="chip">${noL(id)} ${esc(stu(id)?.name || '')}</span>`).join('')}</div>
  ${r.reason ? `<div class="note">사유: ${esc(r.reason)}</div>` : ''}${photoView(r.photo)}
  ${r.note ? `<div class="note">${esc(r.reviewer || '')}: ${esc(r.note)}</div>` : ''}
  ${admin && r.status === 'pending' ? `<input id="note-${r.id}" placeholder="반려 사유 (선택)" autocomplete="off" data-suggest="note"><div class="btns"><button class="btn ok small" data-act="req-ok" data-id="${r.id}">승인</button><button class="btn danger small" data-act="req-no" data-id="${r.id}">반려</button></div>` : ''}</div>`;
}

// 출석 요청 카드: 교시, 요청자, 지각·결석·공결 명단
function attReqCard(a, admin) {
  const per = S.periods.find((p) => p.id === a.pid);
  // 지각 + 결석인 학생은 두 무리에 모두 (시간 수와 함께)
  const has = (k, v) => (k === 'late' ? attOf(v).l : k === 'absent' ? attOf(v).a : v === k);
  const groups = ['late', 'absent', 'excused']
    .map((k) => [k, Object.entries(a.statuses || {}).filter(([, v]) => has(k, v)).map(([sid]) => sid).sort((x, y) => noOf(x) - noOf(y))])
    .filter(([, l]) => l.length);
  const others = admin ? (S.attRequests || []).filter((o) => o.pid === a.pid && o.id !== a.id && o.status === 'pending') : [];
  return `<div class="card"><div class="req-top"><span class="pill ${a.status}">출석 ${STATUS[a.status]}</span><span class="note">${esc(a.by)} · ${esc(a.at)}</span></div>
  <div class="req-body"><b>${per ? `${mdw(per.date)} ${esc(per.label)}${hoursTag(per)}` : '지워진 교시'}</b></div>
  ${groups.map(([k, l]) => `<div class="note">${ST[k][1]} ${l.length}명</div><div class="chips">${l.map((id) => `<span class="chip">${noL(id)} ${esc(stu(id)?.name || '')}${(k === 'late' ? attOf(a.statuses[id]).l : k === 'absent' ? attOf(a.statuses[id]).a : 0) > 1 ? ` (${k === 'late' ? `${attOf(a.statuses[id]).l}번` : `${attOf(a.statuses[id]).a}시간`})` : ''}</span>`).join('')}</div>`).join('') || '<div class="note">전원 출석</div>'}
  ${a.status !== 'pending' ? `<div class="note">${esc(a.reviewer || '')} · ${esc(a.reviewedAt || '')}${a.note ? ` · 반려 사유: ${esc(a.note)}` : ''}</div>` : ''}
  ${admin && a.status === 'pending' ? `${S.att[a.pid] ? '<div class="warn">이미 저장된 교시예요. 승인하면 이 요청 내용으로 바뀌어요.</div>' : ''}${others.length ? `<div class="warn">같은 교시에 ${others.map((o) => esc(o.by)).join(', ')}의 요청도 있어요.</div>` : ''}
  <input id="note-${a.id}" placeholder="반려 사유 (선택)" autocomplete="off" data-suggest="note"><div class="btns"><button class="btn ok small" data-act="att-ok" data-id="${a.id}">승인 (출석 저장)</button><button class="btn danger small" data-act="att-no" data-id="${a.id}">반려</button></div>` : ''}</div>`;
}

function vReqs() {
  const list = [...S.requests.map((r) => ({ at: r.at, html: () => reqCard(r, false) })), ...(S.attRequests || []).map((a) => ({ at: a.at, html: () => attReqCard(a, false) }))]
    .sort((a, b) => b.at.localeCompare(a.at));
  return `<div><h1>요청 현황</h1><p class="sub">총대단 전체의 요청과 처리 상태예요. 같은 건을 두 번 요청하지 않게 확인하세요.</p></div>${list.map((x) => x.html()).join('') || '<p class="empty">요청이 없어요.</p>'}`;
}

// 명단에서 빠진 학생의 번호는 지금 다른 학생이 쓰고 있을 수 있어서 "(제외)"를 붙인다
const noL = (id) => (stu(id) && !stu(id).active ? `${noOf(id)}(제외)` : noOf(id));
const periodLabel = (e) => S.periods.find((p) => p.id === e.pid)?.label || e.detail;

// 공결 신청을 묶음째로 모은다. 하루 전체 신청(grp)은 한 묶음, 나머지는 한 건씩.
function excGroups(list) {
  const m = new Map();
  list.forEach((x) => {
    const k = x.grp || x.id;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  });
  return [...m.values()];
}
// 묶음의 상태. 하루 전체 신청은 그사이 정정된 줄만 반려되어 승인·반려가 섞일 수 있다 ("일부 승인")
const grpStatus = (g) => (g.some((x) => x.status === 'approved') && g.some((x) => x.status === 'rejected') ? 'partial' : g[0].status);
const grpPill = (g, pre = '') => {
  const st = grpStatus(g);
  return `<span class="pill ${st === 'partial' ? 'approved' : st}">${pre}${st === 'partial' ? '일부 승인' : STATUS[st]}</span>`;
};
const grpNote = (g) => g.find((x) => x.status === 'rejected' && x.note)?.note || g[0].note;
// "9/26(금) 하루 전체 · 1교시 결석, 2교시 지각 (+3)" 또는 "9/26(금) 1교시 결석 +2"
function excText(g, pts) {
  const es = g.map((x) => S.ledger.find((l) => l.id === x.eid)).filter(Boolean);
  const mixed = grpStatus(g) === 'partial';
  // 대기 중인데 그사이 출석을 고쳐 대상이 이미 무효가 됐으면 알린다 (승인하면 서버가 멈추거나 그 줄만 반려한다).
  // 일부 승인이면 반려된 줄에 표시한다
  const gone = (e) =>
    g[0].status === 'pending' && e.voided ? ' <b class="warnc">(그사이 정정되어 이미 무효)</b>'
      : mixed && g.find((x) => x.eid === e.id)?.status === 'rejected' ? ' <b class="warnc">(반려)</b>' : '';
  if (!es.length) return '';
  if (g[0].grp) {
    const sum = es.reduce((a, e) => a + Number(e.points), 0);
    return `${mdw(es[0].date)} <b>하루 전체</b> · ${es.map((e) => `${esc(periodLabel(e))} ${e.item}${gone(e)}`).join(', ')}${pts ? ` (${sgn(sum)})` : ''}`;
  }
  return `${mdw(es[0].date)} ${esc(periodLabel(es[0]))} ${es[0].item}${pts ? ` ${sgn(es[0].points)}` : ''}${gone(es[0])}`;
}

function vExcuse() {
  const f = UI.excForm;
  const s = S.students.find((x) => x.active && x.no === Number(f.no));
  const cands = s
    ? S.ledger
        .filter((e) => e.sid === s.id && L.excusable(e) && !S.excuses.some((x) => x.eid === e.id && x.status === 'pending'))
        .sort((a, b) => b.date.localeCompare(a.date))
    : [];
  const mine = s ? excGroups(S.excuses.filter((x) => x.sid === s.id)).sort((a, b) => b[0].at.localeCompare(a[0].at)) : [];
  // 날짜별로 묶고, 그날 두 건 이상이면 맨 위에 "하루 전체"
  const days = [...new Set(cands.map((e) => e.date))];
  const opts = days.map((d) => {
    const es = cands.filter((e) => e.date === d);
    const cnt = ['결석', '지각'].map((k) => [k, es.filter((e) => e.item === k).length]).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ');
    return `<optgroup label="${mdw(d)}">${es.length > 1 ? `<option value="day:${d}" ${f.eid === 'day:' + d ? 'selected' : ''}>${mdw(d)} 하루 전체 (${cnt})</option>` : ''}${es
      .map((e) => `<option value="${e.id}" ${f.eid === e.id ? 'selected' : ''}>${mdw(e.date)} ${esc(periodLabel(e))} ${e.item} ${sgn(e.points)}</option>`)
      .join('')}</optgroup>`;
  });
  return `<div><h1>공결 신청</h1><p class="sub">번호만 입력하면 돼요. 부총대가 증빙을 확인하고 승인하면 해당 자봉이 무효 처리돼요.</p></div>
  <div class="card"><label class="fld"><span>내 번호</span><input id="exc-no" inputmode="numeric" value="${esc(f.no)}" data-bind="excForm.no" data-rerender="1" placeholder="예: 56"></label>
  ${s ? (cands.length ? `<label class="fld"><span>공결 처리할 출결</span><select id="exc-eid" data-bind="excForm.eid"><option value="">선택하세요</option>${opts.join('')}</select></label>
  <p class="hint" style="margin:0">하루를 통째로 빠졌으면 그 날짜의 "하루 전체"를 고르세요. 그날의 지각·결석이 한 번에 신청돼요.</p>
  <label class="fld"><span>사유 (선택)</span><textarea id="exc-reason" data-bind="excForm.reason" placeholder="예: 예비군 훈련">${esc(f.reason)}</textarea></label>
  ${photoField('excForm', f.photo)}<button class="btn" data-act="exc-add">신청하기</button>` : '<p class="note">공결 신청할 지각·결석 기록이 없어요.</p>') : f.no ? '<p class="note">없는 번호예요.</p>' : ''}</div>
  ${mine.length ? `<h2>${s.no}번 신청 내역</h2>${mine.map((g) => {
    const x = g[0];
    const note = grpNote(g);
    return `<div class="card"><div class="req-top">${grpPill(g)}<span class="note">${esc(x.at)}</span></div><div class="req-body">${excText(g, false)}${x.reason ? ` · ${esc(x.reason)}` : ''}</div>${note ? `<div class="note">반려 사유: ${esc(note)}</div>` : ''}</div>`;
  }).join('')}` : ''}`;
}

// 리액션 상점 신청: 수업 중 대답한 것을 그날 안에 적어 낸다. 부총대가 승인한 것 3개마다 상점 1점 (남는 것은 이월).
// 날짜는 서버가 정한 오늘(S.today)이다. 하루 3번까지(반려된 것은 세지 않는다).
const REACT_MAX = 3;
const rxText = (r) => `${md(r.date)} ${esc(r.period)} · Q. ${esc(r.q)} · A. ${esc(r.a)}`;
// 학생 자기 리액션은 번호를 넣었을 때만 서버에서 받아 온다 (모든 학생 것을 상태에 싣으면 학기 중에 수 MB가 된다).
// 장부가 바뀌면(S.ver) 다시 받는다. 받는 동안에는 전에 받은 것을 보여 준다.
// 다시 받는 기준: 장부 버전과 서버 날짜 (자정이 지나면 "오늘 3번"이 풀려야 한다)
const rxKey = () => `${S.ver}|${S.today}`;
let rxLoad = null; // { sid, key, data, err }
function rxData(sid) {
  if (rxLoad && rxLoad.sid === sid && rxLoad.key === rxKey()) return rxLoad;
  const want = { sid, key: rxKey(), data: rxLoad?.sid === sid ? rxLoad.data : null, err: false };
  rxLoad = want;
  rpc('my_reactions', { p_student: sid })
    .then((d) => (want.data = d))
    .catch(() => (want.err = true))
    .finally(() => rxLoad === want && rxLoaded());
  return want;
}
const rxRetry = '<button class="btn ghost small" data-act="rx-retry">다시 시도</button>';
// 받아 오면 다시 그린다. 번호 칸(숫자, 다시 그려도 되는 칸)을 치는 중이면 커서를 지키며 바로, 글자 칸이면 다 친 뒤에
function rxLoaded() {
  if (UI.tab !== 'react') return;
  const a = document.activeElement;
  if (a?.dataset?.rerender) rerenderKeep(a);
  else softRender();
}
// 누구나 보는 전체 리액션 내역 (최신순). 처음 30개, "더 보기"로 300개까지.
let rxFeed = null; // { key, n, data, err }
function feedData() {
  const n = UI.rxFeedN;
  if (rxFeed && rxFeed.key === rxKey() && rxFeed.n === n) return rxFeed;
  const want = { key: rxKey(), n, data: rxFeed?.data || null, err: false };
  rxFeed = want;
  rpc('reaction_feed', { p_limit: n })
    .then((d) => (want.data = d))
    .catch(() => (want.err = true))
    .finally(() => rxFeed === want && rxLoaded());
  return want;
}
function vReactFeed() {
  const L0 = feedData();
  const F = L0.data;
  return `<h2>전체 리액션 내역</h2><p class="sub" style="margin-top:-12px">모든 학생의 리액션이 최신순으로 보여요.</p>
  ${L0.err ? `<div class="warn">리액션 내역을 ${F ? '새로 ' : ''}불러오지 못했어요. ${rxRetry}</div>` : ''}
  <div id="rx-feed">${F
    ? F.map((r) => `<div class="card rx-feed"><div class="req-top"><span class="pill ${r.status}">${STATUS[r.status]}${r.merit ? ' · 상점 반영' : ''}</span><span class="note">${r.no}번${r.active ? '' : ' (제외)'} · ${esc(r.at)}</span></div><div class="req-body">${rxText(r)}</div></div>`).join('') || '<p class="empty">아직 리액션이 없어요.</p>'
    : L0.err ? '' : '<p class="note">불러오는 중…</p>'}</div>
  ${F && F.length >= UI.rxFeedN && UI.rxFeedN < 300 ? '<button class="btn ghost" data-act="rx-more">더 보기</button>' : ''}`;
}
function vReact() {
  const f = UI.reactForm;
  const s = S.students.find((x) => x.active && x.no === Number(f.no));
  const today = S.today || TODAY;
  const RL = s ? rxData(s.id) : null;
  const R = RL?.data;
  if (s && !R)
    return `<div><h1>리액션 상점</h1></div><div class="card"><label class="fld"><span>내 번호</span><input id="rx-no" inputmode="numeric" value="${esc(f.no)}" data-bind="reactForm.no" data-rerender="1"></label>${RL.err ? `<div class="warn">내 리액션을 불러오지 못했어요. ${rxRetry}</div>` : '<p class="note">불러오는 중…</p>'}</div>${vReactFeed()}`;
  const mine = R ? R.rows : [];
  const usedToday = R ? R.today : 0;
  const prog = R ? R.prog : 0;
  const merits = R ? R.merits : 0;
  const pending = mine.filter((r) => r.status === 'pending').length;
  const pers = [...new Set(S.periods.filter((p) => p.date === today && !p.morning).map((p) => p.label))];
  const form =
    usedToday >= REACT_MAX
      ? `<p class="note">오늘은 ${REACT_MAX}번 모두 신청했어요. 내일 또 신청하세요.</p>`
      : `<label class="fld"><span>교시</span><input id="rx-period" value="${esc(f.period)}" maxlength="40" placeholder="예: 2교시 구강해부학" autocomplete="off" data-bind="reactForm.period"></label>
  ${pers.length ? `<div class="chips">${pers.map((l) => `<button type="button" class="chip" data-act="rx-per" data-v="${esc(l)}">${esc(l)}</button>`).join('')}</div>` : ''}
  <label class="fld"><span>질문</span><input id="rx-q" value="${esc(f.q)}" maxlength="300" placeholder="교수님이 하신 질문" autocomplete="off" data-bind="reactForm.q"></label>
  <label class="fld"><span>내 대답</span><textarea id="rx-a" maxlength="300" data-bind="reactForm.a" placeholder="내가 한 대답">${esc(f.a)}</textarea></label>
  <button class="btn" data-act="rx-add">신청하기 (오늘 ${usedToday}/${REACT_MAX})</button>`;
  return `<div><h1>리액션 상점</h1><p class="sub">수업 중 대답한 것을 적어 내면 부총대가 확인해요. 승인된 대답 ${REACT_MAX}번마다 상점 1점이고, 남는 것은 다음으로 이어져요. <b>오늘(${mdw(today)}) 한 것만</b> 하루 ${REACT_MAX}번까지 신청할 수 있어요.</p></div>
  <div class="card"><label class="fld"><span>내 번호</span><input id="rx-no" inputmode="numeric" value="${esc(f.no)}" data-bind="reactForm.no" data-rerender="1" placeholder="예: 56"></label>
  ${s
    ? `<div class="rx-prog" id="rx-prog"><div><b>${s.no}번</b> · 다음 상점까지 <b>${prog}/${REACT_MAX}</b> <span class="dots">${'●'.repeat(Math.min(prog, REACT_MAX))}${'○'.repeat(Math.max(0, REACT_MAX - prog))}</span></div>
    <div class="note">리액션 상점 ${merits}점 받음${pending ? ` · 확인 대기 ${pending}번` : ''}</div></div>${RL.err ? `<div class="warn">내 리액션을 새로 불러오지 못했어요 (위 숫자가 지난 것일 수 있어요). ${rxRetry}</div>` : ''}${form}`
    : f.no ? '<p class="note">없는 번호예요.</p>' : ''}</div>
  ${mine.length ? `<h2>${s.no}번 신청 내역</h2>${mine.map((r) => `<div class="card"><div class="req-top"><span class="pill ${r.status}">${STATUS[r.status]}${r.merit ? ' · 상점 반영' : ''}${r.cleared ? ' · 이월에서 뺌' : ''}</span><span class="note">${esc(r.at)}</span></div>
    <div class="req-body">${rxText(r)}</div>${r.note ? `<div class="note">반려 사유: ${esc(r.note)}</div>` : ''}</div>`).join('')}
    <p class="hint">최근 30일 것만 보여요.</p>` : ''}
  ${vReactFeed()}`;
}

// 출석: 날짜마다 "아침 출석"은 항상 맨 앞에 있다. 아직 서버에 없는 교시는 v: 로 시작하는 임시 id를 쓴다.
// 아침 출석은 부총대만 한다. 총대단 화면에는 나오지 않고, 총대단은 교시를 추가해서 체크한다.
function periodsOf(date) {
  if (!isAdmin()) return S.periods.filter((p) => p.date === date && !p.morning);
  const ps = S.periods.filter((p) => p.date === date);
  if (!ps.some((p) => p.morning)) ps.unshift({ id: `v:${date}:아침 출석`, date, label: '아침 출석', morning: true });
  return ps.sort((a, b) => (b.morning ? 1 : 0) - (a.morning ? 1 : 0));
}
// 내가 보낸 출석 요청 중 가장 최근 것 (총대단). 서버가 보낸 시각순 목록의 마지막이다
// (화면용 시각은 분 단위라, 같은 분에 다시 보낸 요청을 시각 글자로 비교하면 예전 것을 고를 수 있다)
const myAttReq = (pid) => (S.attRequests || []).filter((a) => a.pid === pid && a.by === UI.user).at(-1);
// 초안은 사람이 고친 뒤(UI.touched)에만 붙잡아 둔다. 손대지 않은 초안은 다른 기기에서 저장·요청한 값을 따라간다.
function attDraft(pid) {
  const mine = !isAdmin() && myAttReq(pid);
  const src = (mine && mine.status === 'pending' ? mine.statuses : S.att[pid]) || {};
  if (!UI.draft[pid] || (!UI.touched[pid] && !sameAtt(UI.draft[pid], src))) UI.draft[pid] = { ...src };
  return UI.draft[pid];
}
function clearDrafts() {
  UI.draft = {};
  UI.touched = {};
  UI.recalled = {};
  UI.recallPrev = {};
}
const ST = { present: ['✓', '출석'], late: ['지', '지각'], absent: ['결', '결석'], excused: ['공', '공결'] };
// 여러 시간 수업의 지각·결석은 시간 수로 쓴다: 'late'·'absent'(1시간), 'late2'~'late4'·'absent2'~'absent4',
// 함께면 'late1absent2'(지각 1시간 + 결석 2시간). 서버 _att_l·_att_a·_att_str·_att_norm과 같다 (지각 1점, 결석 2점씩)
const attOf = (v) => {
  let m = /^late([1-4])absent([1-4])$/.exec(v || '');
  if (m) return { l: +m[1], a: +m[2] };
  m = /^late([2-4])?$/.exec(v || '');
  if (m) return { l: +(m[1] || 1), a: 0 };
  m = /^absent([2-4])?$/.exec(v || '');
  return m ? { l: 0, a: +(m[1] || 1) } : { l: 0, a: 0 };
};
const attV = (k, n) => (n <= 1 ? k : `${k}${n}`);
const attStr = (l, a) => (l && a ? `late${l}absent${a}` : l ? attV('late', l) : a ? attV('absent', a) : null);
const lateN = (v) => attOf(v).l;
const stKey = (v) => {
  const { l, a } = attOf(v);
  return l && a ? 'mixed' : l ? 'late' : a ? 'absent' : v || 'present';
};
const stLabel = (v) => {
  const { l, a } = attOf(v);
  if (l && a) return `지각 ${l} · 결석 ${a}`;
  return l > 1 ? `지각 ${l}` : a > 1 ? `결석 ${a}` : ST[stKey(v)][1];
};
const stShort = (v) => {
  const { l, a } = attOf(v);
  if (l && a) return `지${l}결${a}`;
  return l > 1 ? `지${l}` : a > 1 ? `결${a}` : ST[stKey(v)][0];
};
const perHours = (pid) => S.periods.find((p) => p.id === pid)?.hours || 1;
const hoursTag = (p) => (p.hours > 1 ? ` · ${p.hours}시간` : '');
// 출결 초안과 저장된 출결이 같은지 (학생 순서와 무관하게)
const sameAtt = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);

// 고른 교시의 이름 바꾸기·삭제. 부총대는 어느 교시든, 총대단은 아직 저장 안 됐고 다른 사람의 요청도 없는 교시만
// (서버 rename_period·delete_period와 같은 조건). 아침 출석은 이름을 바꾸지 않는다.
function periodBar(pid) {
  const per = pid && S.periods.find((p) => p.id === pid);
  if (!per) return ''; // 아직 만들지 않은 아침 출석(v:)
  const given = S.ledger.filter((e) => e.pid === pid && !e.voided).length;
  const others = (S.attRequests || []).some((a) => a.pid === pid && a.by !== UI.user);
  if (!isAdmin() && (S.att[pid] || S.ledger.some((e) => e.pid === pid) || others)) return '';
  if (UI.perEdit === pid)
    return `<div class="per-edit"><input id="per-name" value="${esc(UI.perName)}" maxlength="40" autocomplete="off" enterkeyhint="done" aria-label="새 교시 이름" data-bind="perName">
    <button class="btn small" data-act="per-ren-save" data-id="${pid}">저장</button><button class="btn ghost small" data-act="per-ren-no">취소</button></div>`;
  if (UI.perDel === pid)
    return `<div class="att-confirm"><span>${esc(per.label)}을(를) 지울까요? 저장된 출결과 이 교시의 출석 요청이 함께 지워져요.${given ? ` 이 교시로 준 자봉 ${given}건은 "교시 삭제"로 무효 처리돼요.` : ''}</span>
  <div class="btns"><button class="btn danger small" data-act="per-del-yes" data-id="${pid}">네, 지우기</button><button class="btn ghost small" data-act="per-del-no">그만두기</button></div></div>`;
  // 처리하지 않은 출석 요청·공결 신청이 있으면 서버가 삭제를 거절하니 미리 알린다 (이름 바꾸기는 된다)
  const eids = new Set(S.ledger.filter((e) => e.pid === pid).map((e) => e.id));
  const blocked = (isAdmin() && (S.attRequests || []).some((a) => a.pid === pid && a.status === 'pending')) || (S.excuses || []).some((x) => x.status === 'pending' && eids.has(x.eid));
  // 수업 시간 바꾸기: 저장된 교시면 이 교시의 결석·지각 점수도 함께 고쳐진다
  const hrsBtns = per.morning ? '' : `<span class="hours-seg" role="group" aria-label="수업 시간 바꾸기">${[1, 2, 3, 4].map((h) => `<button class="btn ghost small ${per.hours === h ? 'on' : ''}" data-act="per-hours" data-id="${pid}" data-v="${h}" aria-pressed="${per.hours === h}">${h}시간</button>`).join('')}</span>`;
  return `<div class="per-del">${blocked ? '<span class="note">처리하지 않은 출석 요청·공결 신청이 있어서 지금은 이 교시를 지울 수 없어요. 요청함에서 먼저 처리하세요.</span>' : ''}${hrsBtns}${per.morning ? '' : `<button class="btn ghost small" data-act="per-ren" data-id="${pid}">이름 바꾸기</button>`}${blocked ? '' : `<button class="btn ghost small" data-act="per-del" data-id="${pid}">이 교시 삭제</button>`}</div>`;
}

// 지각 다시 부르기: 출석을 한 바퀴 부르고 내려오면 목록 맨 아래(저장 바로 위)에 지각인 학생만 번호순으로 모여 있다.
// 누르면 지각 ↔ 출석. 여기서 출석으로 바꾼 학생도(잘못 눌렀으면 되돌리도록) 저장·요청 전까지 남는다(UI.recalled).
function recallSec(pid, d) {
  const back = UI.recalled[pid] || [];
  // 여기서 출석으로 바꾼 학생은 그 뒤 그대로일 때만 남긴다 (그사이 다른 기기에서 결석 등이 되면 빠진다)
  const rec = UI.recallPrev[pid] || {};
  const list = active().filter((s) => lateN(d[s.id]) || (back.includes(s.id) && (d[s.id] || null) === (rec[s.id]?.left ?? null)));
  if (!list.length) return '';
  return `<div class="recall-sec" id="recall-sec"><div class="recall-bar"><b>지각 다시 부르기</b><span>지각 ${list.length}명 중 <b>${list.filter((s) => !lateN(d[s.id])).length}</b>명 출석</span></div>
  <p class="hint" style="margin:0">대답하면 칸을 눌러 출석으로 바꾸세요. 잘못 눌렀으면 한 번 더 누르면 지각으로 돌아가요.</p>
  <div class="att recall">${list.map((s) => {
    // 지각을 지운 학생의 남은 결석은 여기서는 출석으로 보인다 (지각 다시 부르기는 지각만 다룬다)
    const st = lateN(d[s.id]) ? d[s.id] : 'present';
    return `<button class="${stKey(st)}" data-act="recall-tog" data-sid="${s.id}" aria-label="${s.no}번 ${esc(s.name)} ${stLabel(st)}">${s.no}<span class="nm">${esc(s.name)}</span><small>${stLabel(st)}</small></button>`;
  }).join('')}</div></div>`;
}

// 수업 시간 고르기 (1~4시간)
const hoursSel = (id, v, attrs = '') =>
  `<select id="${id}" class="hours-sel" aria-label="수업 시간" ${attrs}>${[1, 2, 3, 4].map((h) => `<option value="${h}" ${String(v) === String(h) ? 'selected' : ''}>${h}시간</option>`).join('')}</select>`;

function vAttend() {
  const ps = periodsOf(UI.attDate);
  if (!ps.some((p) => p.id === UI.attPid)) UI.attPid = ps.find((p) => !S.att[p.id])?.id || ps[0]?.id || null;
  const pid = UI.attPid;
  let body = isAdmin() ? '' : '<p class="empty">위에서 교시를 추가한 뒤 출석을 체크하세요.<br>예: 1교시 구강해부학</p>';
  if (pid) {
    const d = attDraft(pid);
    const c = { late: 0, absent: 0, excused: 0 };
    // 지각 + 결석인 학생은 둘 다에 센다
    Object.values(d).forEach((v) => {
      const { l, a } = attOf(v);
      if (l) c.late++;
      if (a) c.absent++;
      if (v === 'excused') c.excused++;
    });
    const hrs = perHours(pid);
    const saved = !!S.att[pid];
    const dirty = !sameAtt(d, S.att[pid] || {});
    const admin = isAdmin();
    const mine = !admin && myAttReq(pid);
    const pendingHere = admin ? (S.attRequests || []).filter((a) => a.pid === pid && a.status === 'pending') : [];
    const state = admin
      ? saved ? (dirty ? '변경 사항 있음' : '저장됨') : '아직 저장 안 됨'
      : mine?.status === 'pending' ? '요청 보냄 · 부총대 확인 대기 중' : saved ? '부총대가 저장한 교시예요' : '아직 요청 안 함';
    body =
      (UI.attView === 'grid'
        ? `<div class="att">${active().map((s) => {
            const st = d[s.id] || 'present';
            return `<button class="${stKey(st)}" data-act="cyc" data-sid="${s.id}" aria-label="${s.no}번 ${esc(s.name)} ${stLabel(st)}">${s.no}<span class="nm">${esc(s.name)}</span><small>${stShort(st)}</small></button>`;
          }).join('')}</div>`
        : `<div class="calls">${active().map((s) => {
            const st = d[s.id] || 'present';
            return `<div class="call ${stKey(st)}"><span class="no">${s.no}</span><span class="nm">${esc(s.name || '이름 없음')}${s.exempt ? ' <span class="ex">면제</span>' : ''}</span><div class="st4" role="group" aria-label="${s.no}번 출결">${Object.entries(ST).map(([k, [, l]]) => `<button class="${k} ${stKey(st) === k || (stKey(st) === 'mixed' && (k === 'late' || k === 'absent')) ? 'on' : ''}" data-act="setst" data-sid="${s.id}" data-v="${k}">${k === 'late' && attOf(st).l > 1 ? `지각 ${attOf(st).l}` : k === 'absent' && attOf(st).a > 1 ? `결석 ${attOf(st).a}` : l}</button>`).join('')}</div></div>`;
          }).join('') || '<p class="empty">관리 탭에서 명단을 먼저 넣어 주세요.</p>'}</div>`) +
      recallSec(pid, d) +
      (hrs > 1 ? `<p class="hint" style="margin:0">${hrs}시간 수업이에요. 지각·결석은 누를 때마다 한 시간씩 늘어요. 지각 ${Array.from({ length: hrs }, (_, i) => `${i + 1}점`).join(' → ')}, 결석 ${Array.from({ length: hrs }, (_, i) => `${2 * (i + 1)}점`).join(' → ')}, 한 번 더 누르면 출석이에요. 지각과 결석을 함께 누르면 "지각 1 · 결석 2"처럼 나눠 기록돼요 (합은 ${hrs}시간까지).</p>` : '') +
      `${pendingHere.length ? `<div class="warn">이 교시에 ${pendingHere.map((a) => esc(a.by)).join(', ')}의 출석 요청이 있어요. 요청함에서 확인하세요.</div>` : ''}
    ${mine?.status === 'rejected' ? `<div class="warn">지난 요청이 반려됐어요${mine.note ? `: ${esc(mine.note)}` : ' (사유 없음)'}</div>` : ''}
    <div class="att-foot"><span class="note">지각 ${c.late} · 결석 ${c.absent} · 공결 ${c.excused}<br>${state}</span>
    <div class="btns"><button class="btn ghost small" data-act="att-clear">전원 출석으로 되돌리기</button>${admin ? '<button class="btn" data-act="att-save">저장</button>' : `<button class="btn" data-act="att-request">${mine?.status === 'pending' ? '요청 다시 보내기' : '출석 요청 보내기'}</button>`}</div></div>
    ${UI.attConfirm ? `<div class="att-confirm"><span>지금 표시한 지각 ${c.late}명 · 결석 ${c.absent}명 · 공결 ${c.excused}명이 모두 출석으로 바뀌어요. 되돌릴까요?</span>
    <div class="btns"><button class="btn danger small" data-act="att-clear-yes">네, 전원 출석으로</button><button class="btn ghost small" data-act="att-clear-no">그만두기</button></div></div>` : ''}`;
  }
  // 교시 추가가 맨 위(탭 바로 아래), 그 아래 날짜와 그날의 교시들, 그 아래 출석 체크
  return `<div class="toolbar"><div class="itembox"><input id="newPeriod" placeholder="교시 추가 (예: 1교시 구강해부학)" value="${esc(UI.newPeriod)}" autocomplete="off" data-bind="newPeriod" data-suggest="period">
  <button type="button" class="itemdrop" data-act="pr-open" data-fk="np" aria-expanded="${UI.prOpen === 'np'}">불러오기</button>
  <div class="prpop" id="np-prpop" ${UI.prOpen === 'np' ? '' : 'hidden'}>${UI.prOpen === 'np' ? presetPop('np') : ''}</div></div><button class="btn ghost small" data-act="add-period">추가</button></div>
  <div class="toolbar"><input type="date" id="attDate" value="${UI.attDate}" data-bind="attDate" data-rerender="1" style="width:auto"></div>
  <div class="seg" style="flex-wrap:wrap">${ps.map((p) => `<button class="${p.id === pid ? 'on' : ''}" data-act="pick-period" data-id="${p.id}">${esc(p.label)}${hoursTag(p)}${S.att[p.id] ? ' ·저장됨' : ''}</button>`).join('')}</div>
  ${periodBar(pid)}
  <div><h1>출석 체크</h1><p class="sub">${UI.attView === 'grid' ? '칸을 누를 때마다 출석 → 지각 → 결석 → 공결 순으로 바뀌어요.' : '번호순으로 이름을 부르면서 바로 출결을 고르세요.'} ${isAdmin() ? '저장하면 교시마다 지각 +1, 결석 +2가 기록돼요 (여러 시간 수업은 누른 횟수만큼).' : '다 고른 뒤 요청을 보내면 부총대가 확인하고 저장해요.'} 이름은 총대단에게만 보여요.</p></div>
  <div class="seg"><button class="${UI.attView !== 'grid' ? 'on' : ''}" data-act="attview" data-v="list">호명 목록</button><button class="${UI.attView === 'grid' ? 'on' : ''}" data-act="attview" data-v="grid">한눈에 보기</button></div>
  ${body}`;
}

function vRecord() {
  const q = UI.recFilter.trim();
  let list = [...S.ledger].reverse().sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at));
  // 학생 상세에서 왔으면 그 학생 것만 (그 학생이 작업 내역 이동으로 사라졌으면 거르지 않는다)
  if (UI.recSid && stu(UI.recSid)) list = list.filter((e) => e.sid === UI.recSid);
  // 번호는 화면에 보이는 대로 찾는다: "30"은 지금 30번인 학생만, 명단에서 빠진 학생은 "30(제외)"
  if (q) list = list.filter((e) => String(noL(e.sid)) === q || e.item.includes(q) || (e.detail || '').includes(q));
  const shown = list.slice(0, 40);
  const row = (e) => {
    let extra = '';
    if (UI.editId === e.id)
      extra = `<div class="edit"><div class="row2"><label class="fld grow"><span>날짜</span><input type="date" id="ed-date" value="${e.date}"></label><label class="fld pts-fld"><span>점수</span><input type="number" step="0.5" inputmode="decimal" id="ed-points" value="${e.points}"></label></div>
      <label class="fld"><span>항목명</span><input id="ed-item" value="${esc(e.item)}"></label><label class="fld"><span>세부</span><input id="ed-detail" value="${esc(e.detail)}"></label>
      <label class="fld"><span>수정 사유 (필수, 학생들에게 공개)</span><input id="ed-reason" autocomplete="off" data-suggest="editReason"></label><div class="btns"><button class="btn small" data-act="edit-save" data-id="${e.id}">수정 저장</button><button class="btn ghost small" data-act="edit-cancel">닫기</button></div></div>`;
    if (UI.voidId === e.id)
      extra = `<div class="edit"><label class="fld"><span>무효 처리 사유 (필수, 학생들에게 공개)</span><input id="vd-reason" autocomplete="off" data-suggest="voidReason"></label><p class="hint" style="margin:0">점수 합계에서 빠지지만, 기록은 줄이 그어진 채로 남아요.</p><div class="btns"><button class="btn danger small" data-act="void-save" data-id="${e.id}">무효 처리</button><button class="btn ghost small" data-act="edit-cancel">닫기</button></div></div>`;
    return `<div class="rec-row"><span class="mono">${noL(e.sid)}번</span><span class="${e.voided ? 'off' : ''}">${esc(e.item)}${e.detail ? ` · ${esc(e.detail)}` : ''}<br><span class="d">${mdw(e.date)}${e.revs?.length ? ' · 수정됨' : ''}${e.voided ? ' · 무효' : ''}</span></span><span class="pts ${e.points > 0 ? 'p' : 'm'} ${e.voided ? 'off' : ''}">${sgn(e.points)}</span>
    ${e.voided ? '' : `<div class="acts"><button class="btn ghost small" data-act="edit" data-id="${e.id}">수정</button><button class="btn ghost small" data-act="void" data-id="${e.id}">무효 처리</button></div>`}${extra}</div>`;
  };
  return `<div><h1>자봉·상점 주기</h1><p class="sub">즉석 부과, 상점 등 모든 항목을 여기서 바로 줘요.</p></div>
  <div class="card">${entryFields('recForm')}<button class="btn" data-act="rec-add">자봉·상점 주기</button></div>
  <h2>자봉·상점 수정·무효 처리</h2><p class="sub" style="margin-top:-12px">지우지 않고 이력으로 남아요. 학생 상세 화면에서 누구나 수정 내역을 볼 수 있어요.</p>
  ${UI.recSid && stu(UI.recSid) ? `<div class="req-top"><span class="note">${noL(UI.recSid)}번 ${esc(stu(UI.recSid).name || '')} 학생 것만 보는 중</span><button class="btn ghost small" data-act="rec-all">전체 보기</button></div>` : ''}
  <input type="search" id="recFilter" aria-label="자봉·상점 찾기" placeholder="번호 또는 항목으로 찾기" value="${esc(UI.recFilter)}" data-bind="recFilter" data-region="rec-list">
  <div class="card" style="gap:0" id="rec-list">${shown.map(row).join('') || '<p class="empty">아직 준 자봉·상점이 없어요.</p>'}${list.length > 40 ? '<p class="note">최근 40건만 보여요. 번호로 찾아보세요.</p>' : ''}</div>`;
}

function vInbox() {
  const rq = S.requests.filter((r) => r.status === 'pending');
  const ex = excGroups(S.excuses.filter((x) => x.status === 'pending'));
  const ar = (S.attRequests || []).filter((a) => a.status === 'pending');
  const rx = (S.reactions || []).filter((r) => r.status === 'pending');
  // 리액션은 학생별로 모은다 (번호순)
  const rxBy = [...new Set(rx.map((r) => r.sid))].sort((a, b) => noOf(a) - noOf(b)).map((sid) => rx.filter((r) => r.sid === sid));
  return `<div><h1>요청함</h1><p class="sub">출석 요청 ${ar.length}건 · 총대단 요청 ${rq.length}건 · 공결 신청 ${ex.length}건 · 리액션 ${rx.length}건</p></div>
  ${ar.length ? `<h2>출석 요청</h2>${ar.map((a) => attReqCard(a, true)).join('')}` : ''}
  <h2>총대단 요청</h2>${rq.map((r) => reqCard(r, true)).join('') || '<p class="empty">대기 중인 요청이 없어요.</p>'}
  <h2>공결 신청</h2>${ex.map((g) => {
    const x = g[0];
    return `<div class="card"><div class="req-top"><span class="pill pending">대기${g.length > 1 ? ` · ${g.length}건` : ''}</span><span class="note">${esc(x.at)}</span></div>
    <div class="req-body"><b>${noL(x.sid)}번 ${esc(stu(x.sid)?.name || '')}</b> · ${excText(g, true)}</div>${x.reason ? `<div class="note">사유: ${esc(x.reason)}</div>` : '<div class="note">사유 없음</div>'}${x.photo ? photoView(x.photo) : '<div class="note">증빙 사진 없음</div>'}
    <input id="note-${x.id}" aria-label="반려 사유" placeholder="반려 사유 (선택)" autocomplete="off" data-suggest="note"><div class="btns"><button class="btn ok small" data-act="exc-ok" data-id="${x.id}">${g.length > 1 ? `${g.length}건 모두 승인` : '승인'} (자봉 무효 처리)</button><button class="btn danger small" data-act="exc-no" data-id="${x.id}">반려</button></div></div>`;
  }).join('') || '<p class="empty">대기 중인 공결 신청이 없어요.</p>'}
  <h2>리액션 신청</h2>${rxBy.map((g) => {
    const sid = g[0].sid;
    const prog = S.reactProg?.[sid] || 0;
    return `<div class="card rx-card"><div class="req-top"><b>${noL(sid)}번 ${esc(stu(sid)?.name || '')}</b><span class="note">이월 ${prog}/${REACT_MAX} · 대기 ${g.length}건</span></div>
    ${g.map((r) => `<div class="rx-item"><div class="req-body">${rxText(r)}</div><div class="note">${esc(r.at)}</div>
      <input id="note-rx-${r.id}" aria-label="반려 사유" placeholder="반려 사유 (선택)" autocomplete="off" data-suggest="note">
      <div class="btns"><button class="btn ok small" data-act="rx-ok" data-ids="${r.id}">승인</button><button class="btn danger small" data-act="rx-no" data-id="${r.id}">반려</button></div></div>`).join('')}
    ${g.length > 1 ? `<button class="btn ok" data-act="rx-ok" data-ids="${g.map((r) => r.id).join(',')}">${noL(sid)}번 ${g.length}건 모두 승인</button>` : ''}</div>`;
  }).join('') || '<p class="empty">대기 중인 리액션 신청이 없어요.</p>'}
  ${rx.length > 1 && rxBy.length > 1 ? `<button class="btn ok" data-act="rx-ok" data-ids="${rx.map((r) => r.id).join(',')}">리액션 ${rx.length}건 모두 승인</button>` : ''}
  ${vDone()}`;
}

// 승인·반려한 요청과 공결 신청. 증빙 사진은 처리 후 180일 동안 여기서 다시 볼 수 있다.
function vDone() {
  const items = [
    ...S.requests.filter((r) => r.status !== 'pending').map((r) => ({ kind: 'req', at: r.reviewedAt || r.at, r })),
    ...excGroups(S.excuses.filter((x) => x.status !== 'pending')).map((g) => ({ kind: 'exc', at: g[0].reviewedAt || g[0].at, x: g[0], g })),
    ...(S.attRequests || []).filter((a) => a.status !== 'pending').map((a) => ({ kind: 'att', at: a.reviewedAt || a.at, a })),
    ...(S.reactions || []).filter((r) => r.status !== 'pending').map((r) => ({ kind: 'rx', at: r.reviewedAt || r.at, r })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const shown = items.slice(0, UI.doneLimit);
  const card = (it) => {
    if (it.kind === 'att') return attReqCard(it.a, false);
    if (it.kind === 'rx') {
      const r = it.r;
      return `<div class="card"><div class="req-top"><span class="pill ${r.status}">리액션 ${STATUS[r.status]}${r.merit ? ' · 상점 반영' : ''}</span><span class="note">${esc(r.reviewer || '')} · ${esc(it.at)}</span></div>
      <div class="req-body"><b>${noL(r.sid)}번 ${esc(stu(r.sid)?.name || '')}</b> · ${rxText(r)}</div>${r.note ? `<div class="note">반려 사유: ${esc(r.note)}</div>` : ''}</div>`;
    }
    if (it.kind === 'req') {
      const r = it.r;
      return `<div class="card"><div class="req-top"><span class="pill ${r.status}">총대단 요청 ${STATUS[r.status]}</span><span class="note">${esc(r.reviewer || '')} · ${esc(it.at)}</span></div>
      <div class="req-body"><b>${esc(r.item)}</b>${r.detail ? ` · ${esc(r.detail)}` : ''} <span class="pts ${r.points > 0 ? 'p' : 'm'}">${sgn(r.points)}</span> · ${md(r.date)}</div>
      <div class="chips">${r.sids.map((id) => `<span class="chip">${noL(id)} ${esc(stu(id)?.name || '')}</span>`).join('')}</div>
      <div class="note">요청: ${esc(r.by)} · ${esc(r.at)}${r.reason ? ` · 사유: ${esc(r.reason)}` : ''}</div>
      ${r.note ? `<div class="note">반려 사유: ${esc(r.note)}</div>` : ''}${photoView(r.photo)}</div>`;
    }
    const x = it.x;
    const txt = excText(it.g, true);
    const note = grpNote(it.g);
    return `<div class="card"><div class="req-top">${grpPill(it.g, '공결 ')}<span class="note">${esc(x.reviewer || '')} · ${esc(it.at)}</span></div>
    <div class="req-body"><b>${noL(x.sid)}번 ${esc(stu(x.sid)?.name || '')}</b>${txt ? ` · ${txt}` : ''}</div>
    <div class="note">신청: ${esc(x.at)}${x.reason ? ` · 사유: ${esc(x.reason)}` : ''}</div>
    ${note ? `<div class="note">반려 사유: ${esc(note)}</div>` : ''}${photoView(x.photo)}</div>`;
  };
  return `<h2>처리한 내역</h2><p class="sub" style="margin-top:-12px">승인·반려한 출석 요청, 총대단 요청, 공결 신청이에요. 증빙 사진은 처리 후 180일 동안 볼 수 있어요.</p>
  ${shown.map(card).join('') || '<p class="empty">아직 처리한 건이 없어요.</p>'}
  ${items.length > shown.length ? `<button class="btn ghost" data-act="done-more">더 보기 (${items.length - shown.length}건 남음)</button>` : ''}`;
}

// 무효 처리된 것만 있는 날은 공지할 것이 없으니 건너뛴다
const lastDate = () => [...new Set(S.ledger.filter((e) => !e.voided && !['import', 'carry'].includes(e.src)).map((e) => e.date))].sort().pop() || TODAY;

function vNotice() {
  // 날짜를 직접 고르지 않았으면 새 기록이 생긴 날로 따라간다 (탭을 켜 둔 채 하루가 지나도)
  if (!UI.noticeFrom || (UI.noticeAuto && UI.noticeAuto !== lastDate())) {
    UI.noticeFrom = UI.noticeTo = UI.noticeAuto = lastDate();
    UI.noticeText = null;
  }
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
  // 전체 파일을 받은 뒤 장부가 바뀌었으면(S.ver) 그 파일에는 새 기록이 없으니 다시 받아야 한다
  const fresh = UI.fullBackup && UI.fullBackupVer === S.ver;
  const ready = fresh && old.length && UI.purgeTyped.trim() === '정리';
  return `<div class="card"><h2>보관 후 정리</h2>
  <p class="hint" style="margin:0">기준 날짜까지의 기록을 학생마다 <b>"이월" 한 줄</b>로 합쳐서 서버를 가볍게 해요. 현재 자봉 점수는 그대로예요. 그 기간의 <b>리액션 내역도 모두 지우고</b>, 학생별 리액션 이월 횟수만 남겨요. 지워진 기록은 앱에서 다시 볼 수 없으니, 먼저 전체 기간 파일로 받아두세요.</p>
  <p class="hint" style="margin:0">기록은 글자라서 몇 년을 써도 수 MB라, 보통은 1년에 한 번이면 충분해요.</p>
  <label class="fld"><span>기준 날짜 (이 날까지 정리)</span><input type="date" id="purge-cut" value="${esc(cut)}" data-bind="purgeCut" data-rerender="1" style="width:auto"></label>
  ${cut ? `<div class="note">정리 대상: 기록 ${old.length}건 → 이월 ${n}건${old.some((e) => e.voided) ? ` (무효 ${old.filter((e) => e.voided).length}건 포함)` : ''}</div>` : ''}
  ${fresh ? '<div class="note" style="color:var(--merit)">✓ 전체 기간 파일을 받았어요</div>' : UI.fullBackup ? '<div class="warn">전체 기간 파일을 받은 뒤 장부가 바뀌었어요. 새 기록도 남도록 공지 탭 → 내보내기에서 <b>전체</b> 기간 파일을 다시 만들어 주세요.</div>' : '<div class="warn">먼저 공지 탭 → 내보내기에서 <b>전체</b> 기간 파일을 만들어야 정리할 수 있어요.</div>'}
  <input id="purge-typed" aria-label="정리 확인 입력" placeholder="확인하려면 '정리'라고 입력" value="${esc(UI.purgeTyped)}" data-bind="purgeTyped" data-region="purge-btn" ${fresh ? '' : 'disabled'}>
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

  <details class="card" ${UI.rosterOpen ? 'open' : ''}><summary data-act="roster-toggle"><b>명단 하나씩 고치기 (${active().length}명)</b></summary>
  <div class="req-top"><span></span><button class="btn ghost small" data-act="stu-add">학생 추가</button></div>
  <p class="hint" style="margin:0">번호를 바꿔도 기록은 그 학생을 따라가요. 제외해도 기록은 남아요. 이름은 출석 체크용이라 관리자에게만 보여요.</p>
  <div class="mlist">${all.map((s) => `<div class="mrow"><input type="number" class="no-in" data-sid="${s.id}" value="${s.no}" aria-label="번호" ${s.active ? '' : 'disabled'}><input class="grow name-in" data-sid="${s.id}" value="${esc(s.name)}" placeholder="이름" aria-label="이름" style="width:auto;min-width:0" ${s.active ? '' : 'disabled'}><span class="note">${s.active ? `자봉 ${bal(s.id)}` : '제외됨'}</span><button class="btn ghost small" data-act="stu-toggle" data-sid="${s.id}">${s.active ? '제외' : '복귀'}</button></div>`).join('')}</div>
  <button class="btn" data-act="nos-save">명단 저장</button></details>


  <div class="card"><h2>학급 매점 링크</h2>
  <p class="hint" style="margin:0">넣으면 모든 화면의 자봉 현황 맨 위에 "학급 매점 열기" 버튼이 생겨요. 비우고 저장하면 버튼이 사라져요. 구글 시트는 공유를 <b>"링크가 있는 모든 사용자 → 뷰어"</b>로 해 두세요 (편집자로 두면 학생 누구나 시트를 고칠 수 있어요).</p>
  <input id="store-url" type="url" inputmode="url" aria-label="학급 매점 링크" placeholder="https://docs.google.com/spreadsheets/..." value="${esc(S.links?.store || '')}" autocomplete="off">
  <div class="btns"><button class="btn ghost" data-act="link-save" data-id="store">링크 저장</button>${storeUrl() ? `<a class="btn ghost small" href="${esc(storeUrl())}" target="_blank" rel="noopener noreferrer">열어 보기 ↗</a>` : ''}</div></div>

  <div class="card"><h2>디데이 링크</h2>
  <p class="hint" style="margin:0">디데이 사이트 주소를 <b>보기 키(#k=…)까지 통째로</b> 붙여넣으세요. 넣으면 학생 화면의 첫 탭이 "디데이"가 되고, 그 사이트와 같은 마감 목록이 보여요. 비우고 저장하면 디데이 탭이 사라져요. 학생 앱 주소를 아는 사람은 누구나 이 목록을 볼 수 있어요.</p>
  <input id="dday-url" type="url" inputmode="url" aria-label="디데이 링크" placeholder="https://koderjoon.github.io/notice-todo/#k=..." value="${esc(S.links?.dday || '')}" autocomplete="off">
  <div class="btns"><button class="btn ghost" data-act="link-save" data-id="dday">링크 저장</button>${ddayUrl() ? `<a class="btn ghost small" href="${esc(ddayUrl())}" target="_blank" rel="noopener noreferrer">열어 보기 ↗</a>` : ''}</div>
  <h2 style="font-size:14px">디데이 관리자 링크</h2>
  <p class="hint" style="margin:0">관리자 키(#k=…)가 든 주소를 넣으면 <b>로그인한 총대단·부총대</b> 화면 첫 탭이 "디데이"가 되고, 거기서 바로 일정을 추가·수정·삭제할 수 있어요. 학생 화면과 백업 파일에는 들어가지 않아요.</p>
  <input id="dday_admin-url" type="url" inputmode="url" aria-label="디데이 관리자 링크" placeholder="https://koderjoon.github.io/notice-todo/#k=..." value="${esc(S.links?.dday_admin || '')}" autocomplete="off">
  <div class="btns"><button class="btn ghost" data-act="link-save" data-id="dday_admin">링크 저장</button></div></div>

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
  <p class="hint" style="margin:0">부총대가 비밀번호를 잊었을 때 쓰는 비상 코드예요. 잃어버렸거나 다른 사람이 봤을 것 같으면 새로 만드세요. 이전 코드는 바로 못 쓰게 돼요.</p>
  <input type="password" id="rc-pw" placeholder="내 비밀번호 확인" autocomplete="current-password"><button class="btn ghost" data-act="rc-new">새 복구 코드 만들기</button></div>

  ${vExempt()}
  ${vReactAdj()}

  ${vBackup()}

  ${vPurge()}`;
}

// 작업 내역과 뒤로가기·앞으로 가기. 목록은 탭을 열 때 서버에서 받아 온다.
// 작업은 한 줄로 이어져 있고, 되돌린 작업(undone)은 "지금" 위쪽에 흐리게 남아 앞으로 가기로 다시 적용할 수 있다.
// 이동 자체는 작업 내역에 남지 않는다. 되돌린 상태에서 새 작업을 하면 위쪽 작업들은 사라진다.
// "이 작업만 되돌리기"로 빼 둔 작업(dropped)은 제자리에 흐리게 남고 "다시 살리기"로 되살린다.
async function loadHistory() {
  UI.hist.list = await rpc('ops_list', { p_token: token(), p_limit: UI.hist.limit });
}
function histPos(list) {
  const cur = list.find((o) => !o.undone && !o.dropped) || null;
  const future = list.filter((o) => o.undone && !o.dropped);
  const locked = list.some((o) => !o.undoable);
  // 맨 끝은 빼 둔 작업까지 포함한 가장 새 작업이다. 뒤로 갔다 오면서 빼 둔 작업이 "뒤로 감"에 남으면 새 작업에 지워져 다시 살릴 수 없다
  const end = list[0]?.undone ? list[0].id : null;
  return {
    cur,
    back: cur && cur.undoable ? cur.id - 1 : null,
    fwd: future.length ? future[future.length - 1].id : end,
    end,
    // 앞으로 갈 수 있는 작업 수와, 함께 사라질 빼 둔 작업 수
    ahead: future.length,
    aheadDropped: list.filter((o) => o.undone && o.dropped).length,
    start: !locked && cur ? 0 : null,
  };
}
function vHistory() {
  const h = UI.hist;
  if (!h.list) {
    // 실패하면 저절로 다시 부르지 않는다 (오프라인이면 1초에 수백 번 부르게 된다). 다시 시도 버튼으로만.
    if (h.error) return `<div><h1>작업 내역</h1></div><div class="card"><p class="note">작업 내역을 불러오지 못했어요: ${esc(h.error)}</p><button class="btn" data-act="hist-retry">다시 시도</button></div>`;
    if (!h.loading) {
      h.loading = true;
      loadHistory()
        // 그사이 탭을 다시 눌러 UI.hist가 새것으로 바뀌었을 수 있으니 지금 것에 적는다
        .catch((e) => (e.code === '28000' ? signOut(e.message) : (UI.hist.error = e.message || '알 수 없는 오류')))
        .finally(() => {
          h.loading = false;
          UI.hist.loading = false;
          // 다른 탭으로 옮겼으면 그리지 않는다 (한글 입력 중인 칸의 포커스를 뺏지 않게)
          if (UI.tab === 'history') softRender();
        });
    }
    return '<div><h1>작업 내역</h1></div><p class="boot">불러오는 중…</p>';
  }
  const pos = histPos(h.list);
  const p = h.preview;
  const opRows = (ops) => `<div class="mlist" style="max-height:160px">${ops.map((o) => `<div class="mrow"><span class="note mono">${esc(o.at.slice(5))}</span><span class="grow">${esc(o.summary)}</span><span class="note">${esc(o.actor)}</span></div>`).join('')}</div>`;
  const previewCard = p
    ? `<div class="card" style="border-color:var(--warn)"><h2>${esc(p.title)}</h2>
    ${p.data.back.length ? `<div class="note">되돌릴 작업 ${p.data.back.length}개</div>${opRows(p.data.back)}` : ''}
    ${p.data.forward.length ? `<div class="note">다시 적용할 작업 ${p.data.forward.length}개</div>${opRows(p.data.forward)}` : ''}
    ${!p.drop && !p.data.back.length && !p.data.forward.length ? '<div class="note">빼 둔 작업만 제자리로 옮겨요 (데이터는 그대로예요).</div>' : ''}
    <div class="note">무효가 아닌 기록 ${p.data.ledger.before}건 → ${p.data.ledger.after}건</div>
    ${p.data.students.length ? `<div class="note">달라지는 학생 ${p.data.students.length}명</div><div class="mlist" style="max-height:200px">${p.data.students.map((x) => {
      const bits = [];
      if (x.before !== x.after) bits.push(`자봉 ${x.before ?? '없음'} → ${x.after ?? '없음'}`);
      if (x.beforeNo !== x.afterNo) bits.push(`번호 ${x.beforeNo ?? '없음'} → ${x.afterNo ?? '없음'}`);
      if (x.beforeActive !== x.afterActive) bits.push(x.afterActive ? '명단에 다시 들어감' : x.afterActive === false ? '명단에서 빠짐' : '명단에서 사라짐');
      return `<div class="mrow"><span class="mono">${x.no ?? ''}</span><span class="grow">${esc(x.name || '')}</span><span class="note">${bits.join(' · ') || '기록만 바뀜'}</span></div>`;
    }).join('')}</div>` : '<div class="note">학생별 점수·번호는 그대로예요 (요청·신청 같은 기록만 바뀌어요).</div>'}
    <div class="btns"><button class="btn danger" data-act="hist-run">${p.restore ? '다시 살리기' : p.drop ? '되돌리기' : '이동'}</button><button class="btn ghost" data-act="hist-cancel">그만두기</button></div></div>`
    : '';
  const here = '<div class="rec-row" style="color:var(--accent);font-weight:600"><span>▶</span><span>지금 여기</span><span></span></div>';
  // 빼 둔 작업도 뒤로 가지 않았으면 "지금" 아래(지난 쪽)에 둔다
  const hereId = h.list.find((o) => !o.undone)?.id;
  const row = (o) => {
    const isCur = pos.cur && o.id === pos.cur.id;
    const tag = !o.undoable ? '<span class="pill">이 너머로는 못 가요</span>' : o.dropped ? '<span class="pill rejected">이 작업만 되돌림</span>' : o.undone ? '<span class="pill rejected">뒤로 감</span>' : '';
    const canGo = !isCur && !o.dropped;
    const canDrop = o.undoable && !o.undone && !o.dropped;
    const dim = o.undone || o.dropped ? ' style="opacity:.55"' : '';
    return `${o.id === hereId ? here : ''}<div class="rec-row"><span class="note mono"${dim}>${esc(o.at.slice(5))}</span><span class="${o.undone || o.dropped ? 'off' : ''}"${dim}>${esc(o.summary)}<br><span class="d">${esc(o.actor)}</span></span><span>${tag}</span>
    ${canGo || canDrop || o.dropped ? `<div class="acts">${canGo ? `<button class="btn ghost small" data-act="hist-pv" data-target="${o.id}" data-title="이 작업 직후로 이동">이 시점으로</button>` : ''}${canDrop ? `<button class="btn ghost small" data-act="hist-drop-pv" data-id="${o.id}">이 작업만 되돌리기</button>` : ''}${o.dropped ? `<button class="btn ghost small" data-act="hist-drop-pv" data-id="${o.id}" data-restore="1">다시 살리기</button>` : ''}</div>` : ''}</div>`;
  };
  const list = h.list.map(row).join('') + (hereId == null && h.list.length ? here : '');
  const complete = h.list.length < h.limit;
  return `<div><h1>작업 내역</h1><p class="sub">누가 언제 무엇을 바꿨는지 최신순으로 보여요. 뒤로가기·앞으로 가기로 작업 단위로 오가거나, 작업 하나만 되돌릴 수 있어요. 이동이나 되돌리기는 작업 내역에 남지 않아요.</p></div>
  ${previewCard}
  ${pos.end != null ? `<div class="warn">지금 <b>뒤로 간 상태</b>예요. 이대로 누가 새 작업을 하면(학생의 공결·리액션 신청, 총대단 요청도 포함) ${[pos.ahead ? `앞으로 갈 수 있는 작업 ${pos.ahead}개` : '', pos.aheadDropped ? `빼 둔 작업 ${pos.aheadDropped}개` : ''].filter(Boolean).join('와 ')}가 사라져요. 확인이 끝나면 바로 맨 끝으로 돌아오세요.
    <div class="btns" style="margin-top:6px"><button class="btn small" data-act="hist-pv" data-target="${pos.end}" data-title="맨 끝으로 돌아가기">맨 끝으로 돌아가기</button></div></div>` : ''}
  <div class="card"><div class="btns">
    <button class="btn ghost" data-act="hist-pv" data-target="${pos.back ?? ''}" data-title="뒤로가기" ${pos.back == null ? 'disabled' : ''}>← 뒤로가기</button>
    <button class="btn ghost" data-act="hist-pv" data-target="${pos.fwd ?? ''}" data-title="앞으로 가기" ${pos.fwd == null ? 'disabled' : ''}>앞으로 가기 →</button>
  </div>${pos.start != null && complete ? '<button class="btn ghost small" data-act="hist-pv" data-target="0" data-title="맨 처음으로 이동">맨 처음으로</button>' : ''}</div>
  <div class="card" style="gap:0">${list || '<p class="empty">아직 작업이 없어요.</p>'}
  ${!complete ? '<button class="btn ghost" data-act="hist-more" style="margin-top:10px">더 보기</button>' : ''}</div>
  <p class="hint">"뒤로 감" 줄은 앞으로 가기나 "이 시점으로"로 다시 적용할 수 있어요. 다만 뒤로 간 상태에서 누가 새 작업(기록, 승인, 학생의 공결·리액션 신청 등)을 하면 그 줄들은 사라져요. "이 작업만 되돌리기"는 그 작업 하나만 빼 두고, "다시 살리기"로 언제든 되살릴 수 있어요. 뒤의 작업이 같은 기록을 바꿨으면 할 수 없다고 알려줘요. 이동하기 전에 무엇이 바뀌는지 먼저 보여줘요. 보관 후 정리나 백업에서 되살리기 너머로는 갈 수 없어요.</p>`;
}

// 리액션 이월 맞추기: 엑셀로 정리하던 이월(다음 상점까지 모은 횟수 0~2)을 붙여넣어 옮긴다 (서버 reaction_adjust)
function vReactAdj() {
  const plan = UI.rxAdjText.trim() ? L.planReactAdj(S, UI.rxAdjText) : null;
  const cur = active().filter((s) => S.reactProg?.[s.id]).map((s) => `${s.no}번 ${S.reactProg[s.id]}`);
  return `<div class="card" id="rxadj-card"><h2>리액션 이월 맞추기</h2>
  <p class="hint" style="margin:0">엑셀로 정리하던 리액션 이월(다음 상점까지 모은 횟수, 0~2번)을 옮겨요. <b>번호·이월 횟수</b> 열을 복사해 붙여넣으면, 적은 학생만 그 횟수로 맞춰져요. 이미 받은 상점은 자봉 점수(명단 붙여넣기·직접 주기)로 넣어 주세요.</p>
  <p class="note" style="margin:0" id="rxadj-cur">지금 이월: ${cur.join(', ') || '없음'}</p>
  <textarea id="rxadj-text" aria-label="리액션 이월 붙여넣기" data-bind="rxAdjText" data-region="rxadj-preview" placeholder="번호&#9;이월&#10;3&#9;2&#10;12&#9;1" style="min-height:90px;font-family:var(--mono)">${esc(UI.rxAdjText)}</textarea>
  <div id="rxadj-preview" style="display:flex;flex-direction:column;gap:8px">${plan
    ? `${plan.errors.length ? `<div class="warn">${plan.errors.map(esc).join('<br>')}</div>` : ''}${plan.items.length
        ? `<div class="mlist">${plan.items.map((x) => `<div class="mrow"><span class="mono">${x.no}번</span><span class="grow">${esc(stu(x.sid)?.name || '')}</span><span class="mono note">${x.from} → ${x.to}</span></div>`).join('')}</div>`
        : '<p class="note" style="margin:0">바뀌는 학생이 없어요.</p>'}
    <button class="btn" data-act="rxadj-apply" ${plan.errors.length || !plan.items.length ? 'disabled' : ''}>${plan.items.length}명 이월 맞추기</button>`
    : ''}</div></div>`;
}

// 자봉 면제: 지정한 학생은 출석·기록·요청으로 들어오는 +점수가 쌓이지 않고 상점(−)만 받는다 (서버 _entry)
function vExempt() {
  const ex = active().filter((s) => s.exempt);
  const P = liveParts('exForm');
  return `<div class="card" id="exempt-card"><h2>자봉 면제</h2>
  <p class="hint" style="margin:0">지정한 학생은 출석·자봉 탭·요청 승인으로 들어오는 <b>자봉(+)이 쌓이지 않고 상점(−)만</b> 받아요. 지정하기 전에 쌓인 자봉은 그대로라, 필요하면 자봉 탭에서 무효 처리하세요.</p>
  ${ex.length ? `<div class="chips">${ex.map((s) => `<button class="chip" data-act="stu-exempt" data-sid="${s.id}" aria-label="${s.no}번 면제 풀기">${s.no} ${esc(s.name)} ×</button>`).join('')}</div><p class="hint" style="margin:0">칩을 누르면 면제가 풀려요.</p>` : '<p class="note" style="margin:0">지정한 학생이 없어요.</p>'}
  <label class="fld"><span>면제로 지정할 학생</span><input id="exForm-find" type="search" value="${esc(UI.exForm.find)}" placeholder="이름이나 번호" autocomplete="off" enterkeyhint="done" data-bind="exForm.find" data-picker="exForm"></label>
  <div id="exForm-sugg">${P.sugg}</div><div class="chips" id="exForm-chips">${P.chips}</div>
  <button class="btn ghost" data-act="exempt-add">자봉 면제로 지정</button></div>`;
}

// 백업: 지금 받기, 백업에서 되살리기, 자동 백업 키
function vBackup() {
  const b = UI.bk;
  let preview = '';
  if (b.dump) {
    const t = b.dump.tables;
    const bal = new Map();
    t.ledger.filter((e) => !e.voided_at).forEach((e) => bal.set(e.student_id, (bal.get(e.student_id) || 0) + Number(e.points)));
    const bs = t.students.filter((x) => x.active).sort((x, y) => x.no - y.no);
    const now = new Map(active().map((x) => [x.id, x]));
    const diffs = bs
      .map((x) => ({ x, then: bal.get(x.id) || 0, cur: now.has(x.id) ? L.bal(S, x.id) : null }))
      .filter((d) => d.cur !== d.then);
    const gone = active().filter((x) => !bs.some((y) => y.id === x.id));
    preview = `<div class="card" style="background:var(--sunk);border-color:transparent">
    <b>${esc(b.dump.createdAt)} 백업</b>
    <div class="note">백업: 학생 ${bs.length}명 · 기록 ${t.ledger.length}건 &nbsp;/&nbsp; 지금: 학생 ${active().length}명 · 기록 ${S.ledger.length}건</div>
    ${diffs.length ? `<div class="note">점수가 달라지는 학생 ${diffs.length}명</div><div class="mlist" style="max-height:180px">${diffs.map((d) => `<div class="mrow"><span class="mono">${esc(d.x.no)}</span><span class="grow">${esc(d.x.name)}</span><span class="mono note">지금 ${esc(d.cur ?? '없음')} → ${esc(d.then)}</span></div>`).join('')}</div>` : '<div class="note">학생별 자봉 점수는 지금과 같아요.</div>'}
    ${gone.length ? `<div class="warn">백업 뒤에 추가된 학생 ${gone.length}명(${gone.map((x) => esc(x.no)).join(', ')}번)은 사라져요.</div>` : ''}
    <div class="warn">되살리면 이 백업 뒤에 생긴 기록·요청·출석이 모두 사라져요. 되살리기 직전 상태는 파일로 먼저 받아 둬요.</div>
    <input id="bk-typed" aria-label="되살리기 확인 입력" placeholder="확인하려면 '되살리기'라고 입력" value="${esc(b.typed)}" data-bind="bk.typed" data-region="bk-go">
    <div id="bk-go"><button class="btn danger" data-act="bk-restore" ${b.typed.trim() === '되살리기' ? '' : 'disabled'}>이 백업으로 되살리기</button></div></div>`;
  }
  // 예전에 암호를 걸어 받은 파일이면 암호 칸을 보여 준다
  const locked = b.file && !b.dump && b.file.format === 'jabong-backup-encrypted';
  return `<div class="card"><h2>백업</h2>
  <p class="hint" style="margin:0">매일 새벽 3시에 jabong-backup 저장소로 자동 백업이 올라가요. 백업에는 명단(이름 포함)·기록·이력·요청·출석이 들어가고, 비밀번호와 사진은 빠져요.</p>
  <button class="btn ghost" data-act="bk-download">지금 백업 파일 받기</button>
  <h2 style="font-size:14px">백업에서 되살리기</h2>
  <label class="fld"><span>백업 파일 (.json)</span><input type="file" accept=".json,application/json" data-bkfile="1"></label>
  ${locked ? `<div class="note">${esc(b.fileName)} · 암호를 걸어 둔 파일이에요</div><input type="password" id="bk-pw" placeholder="백업 암호" autocomplete="off" value="${esc(b.pw)}" data-bind="bk.pw"><button class="btn ghost" data-act="bk-open">암호로 열기</button>` : ''}
  ${preview}</div>`;
}

function downloadJSON(obj, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(obj)], { type: 'application/json' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${TODAY}-${p(d.getHours())}${p(d.getMinutes())}`;
};

async function downloadBackup(prefix) {
  downloadJSON(await rpc('backup_dump'), `${prefix}${stamp()}.json`);
}

function vLogin() {
  const list = UI.role === 'admin' ? admins() : officers();
  return `<div><h1>${UI.role === 'admin' ? '부총대' : '총대단'} 로그인</h1><p class="sub">직책을 고르고 비밀번호를 입력하세요.</p></div>
  <div class="card"><label class="fld"><span>직책</span><select id="login-who">${list.map((o) => `<option>${esc(o)}</option>`).join('')}</select></label>
  <label class="fld"><span>비밀번호</span><input type="password" id="login-pw" autocomplete="current-password"></label>
  <button class="btn" data-act="login">로그인</button>
  <p class="hint" style="margin:0">${UI.role === 'admin' ? '비밀번호를 잊었으면 아래 복구 코드로 새로 정하세요.' : '비밀번호를 잊었으면 부총대에게 재설정을 부탁하세요. 로그인한 뒤 위의 "비밀번호 바꾸기"로 직접 바꿀 수 있어요.'}</p>
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
        ? '<div class="mocknote">총대단과 부총대는 자기 직책의 비밀번호로 로그인해요.</div>'
        : `<div class="who"><b style="color:var(--ink)">${esc(UI.user)}</b>로 로그인됨 ${UI.role === 'officer' ? '<button class="btn ghost small" data-act="pw-open">비밀번호 바꾸기</button> ' : ''}<button class="btn ghost small" data-act="logout">로그아웃</button></div>`;
  const V = { dday: vDday, board: vBoard, excuse: vExcuse, react: vReact, request: vRequest, reqs: vReqs, attend: vAttend, record: vRecord, inbox: vInbox, notice: vNotice, history: vHistory, manage: vManage };
  const codeCard =
    !locked && UI.role === 'admin' && UI.newCode
      ? `<div class="card" style="border-color:var(--warn)"><h2>새 복구 코드</h2><div class="mono" style="font-size:22px;letter-spacing:.06em">${esc(UI.newCode)}</div>
    <p class="hint" style="margin:0">지금 캡처하거나 메모해서 따로 보관하세요. 이 화면을 닫으면 다시 보여주지 않아요. 인수인계할 때 비밀번호와 함께 넘겨주세요.</p>
    <div class="btns"><button class="btn ghost small" data-act="code-copy">복사</button><button class="btn small" data-act="code-ok">보관했어요</button></div></div>`
      : '';
  const pwCard =
    !locked && UI.role === 'officer' && UI.pwOpen
      ? `<div class="card"><h2>내 비밀번호 바꾸기 (${esc(UI.user)})</h2>
    <input type="password" id="pw-cur" placeholder="현재 비밀번호" autocomplete="current-password"><input type="password" id="pw-new" placeholder="새 비밀번호 (4자 이상)" autocomplete="new-password"><input type="password" id="pw-new2" placeholder="새 비밀번호 확인" autocomplete="new-password">
    <p class="hint" style="margin:0">현재 비밀번호를 잊었으면 부총대에게 재설정을 부탁하세요.</p>
    <div class="btns"><button class="btn" data-act="pw-change">바꾸기</button><button class="btn ghost" data-act="pw-open">닫기</button></div></div>`
      : '';
  view.innerHTML = locked ? vLogin() : codeCard + pwCard + (UI.sid ? vDetail() : (V[UI.tab] || vBoard)());
  const pc = pendingCount();
  tabs.innerHTML = locked
    ? ''
    : tabsOf(UI.role).map(([k, l]) => `<button class="${UI.tab === k && !UI.sid ? 'on' : ''}" data-act="tab" data-tab="${k}">${l}${k === 'inbox' && pc ? `<span class="badge">${pc}</span>` : ''}</button>`).join('');
}

// 다른 사람이 데이터를 바꿔서 다시 그려야 할 때, 입력 중이면 입력이 끝날 때까지 미룬다
let pendingRender = false;
let pointerDown = false;
document.addEventListener('pointerdown', () => (pointerDown = true), true);
['pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, () => setTimeout(() => (pointerDown = false), 0), true));
function softRender() {
  const a = document.activeElement;
  if (a && a.closest('#view') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return (pendingRender = true);
  // 버튼을 누르는 중에 다시 그리면 그 누름(click)이 사라진다. 손을 뗀 뒤에 그린다.
  if (pointerDown) return setTimeout(softRender, 50);
  renderKeep();
}
// 반려 사유·수정 사유처럼 상태에 묶이지 않은 칸의 글자는 다시 그려도 남긴다
function renderKeep() {
  const kept = [...document.querySelectorAll('#view input[id]:not([data-bind]):not([type=file]):not([type=checkbox]), #view textarea[id]:not([data-bind])')]
    .filter((el) => el.value)
    .map((el) => [el.id, el.value]);
  render();
  kept.forEach(([id, v]) => {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = v;
  });
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
  if (b === 'noticeFrom' || b === 'noticeTo') {
    UI.noticeText = null;
    UI.noticeAuto = null;
  }
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
  if (el.dataset?.bkfile && el.files?.[0]) {
    const f = el.files[0];
    f.text().then((txt) => {
      try {
        const data = JSON.parse(txt);
        if (data.format === 'jabong-backup' && Array.isArray(data.tables?.students) && Array.isArray(data.tables?.ledger)) UI.bk = { ...UI.bk, file: data, fileName: f.name, dump: data, typed: '' };
        else if (data.format === 'jabong-backup-encrypted') UI.bk = { ...UI.bk, file: data, fileName: f.name, dump: null, typed: '' };
        else throw new Error();
      } catch {
        UI.bk = { ...UI.bk, file: null, fileName: '', dump: null, typed: '' };
        toast('자봉 장부 백업 파일이 아니에요');
      }
      render();
    });
    return;
  }
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

/* ---------- 입력 추천 ---------- */
// data-suggest가 붙은 칸을 누르면 칸 바로 아래에 최근·자주 쓴 값(logic.js의 suggest*)을 띄우고, 누르면 그 값이 들어간다.
// 항목명은 점수도 함께 들어간다. 상자는 칸 밖에 따로 붙여서, 치는 중에 상자만 다시 그려도 한글 조합이 끊기지 않는다.
let SUG = null; // { el, list }
function sugList(el) {
  const kind = el.dataset.suggest;
  const fk = el.dataset.fk;
  if (kind === 'item') return L.suggestItems(S, UI.user, el.value, UI[fk].points);
  if (kind === 'detail') return L.suggestDetails(S, UI.user, UI[fk].item, el.value);
  if (kind === 'period') return L.suggestPeriods(S, UI.attDate, el.value);
  return L.suggestTexts(L.reasonEvents(S, kind, UI.user), el.value);
}
function hideSug() {
  document.getElementById('sugbox')?.remove();
  SUG = null;
}
function showSug(el) {
  const list = sugList(el);
  if (!list.length) return hideSug();
  let box = document.getElementById('sugbox');
  if (!box || SUG?.el !== el) {
    box?.remove();
    box = document.createElement('div');
    box.id = 'sugbox';
    box.className = 'sugbox';
    box.setAttribute('role', 'listbox');
    box.setAttribute('aria-label', '최근·자주 쓴 값');
    // 항목명처럼 점수 칸과 한 줄에 있으면 그 줄 아래에 (closest는 가장 가까운 것을 고르므로 .row2를 먼저 찾는다)
    (el.closest('.row2') || el.closest('.fld') || el.closest('.toolbar') || el).after(box);
  }
  SUG = { el, list };
  const groups = [];
  list.forEach((x, i) => {
    if (!groups.length || groups.at(-1).g !== x.g) groups.push({ g: x.g, items: [] });
    groups.at(-1).items.push(
      `<button type="button" role="option" data-act="sug-pick" data-i="${i}">${esc(x.v)}${x.pts != null ? ` <b class="${x.pts > 0 ? 'p' : 'm'}">${sgn(x.pts)}</b>` : ''}</button>`,
    );
  });
  box.innerHTML = groups.map((g) => `<div class="sug-g">${g.g ? `<span class="sug-l">${g.g}</span>` : ''}${g.items.join('')}</div>`).join('');
}
document.addEventListener('focusin', (ev) => {
  if (['item', 'period'].includes(ev.target.dataset?.suggest) && UI.prOpen) closePresetPops();
  if (ev.target.dataset?.suggest) showSug(ev.target);
});
document.addEventListener('focusout', (ev) => {
  if (ev.target.dataset?.suggest && SUG?.el === ev.target) hideSug();
});
// 이미 포커스가 있는 칸을 다시 누르면 다시 띄운다 (값을 고른 뒤 닫힌 경우)
document.addEventListener('click', (ev) => {
  if (ev.target.dataset?.suggest && !document.getElementById('sugbox')) showSug(ev.target);
});
document.addEventListener('input', (ev) => {
  if (ev.target.dataset?.suggest && ev.target.isConnected && document.activeElement === ev.target) showSug(ev.target);
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && SUG) hideSug();
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

async function saveAttendance(asRequest) {
  let pid = UI.attPid;
  const draft = attDraft(pid);
  if (pid.startsWith('v:')) {
    const per = periodsOf(UI.attDate).find((p) => p.id === pid);
    const real = await rpc('ensure_period', { p_token: token(), p_date: per.date, p_label: per.label, p_morning: per.morning });
    // 새로 만든 교시를 화면 상태에도 넣어 둔다. 바로 뒤 저장이 실패해도 다시 그릴 때 임시 교시(v:)로 돌아가
    // 고치던 출결이 빈 초안이 되지 않게 (지각 다시 부르기도 그 교시에서 이어진다)
    if (!S.periods.some((p) => p.id === real)) S.periods.push({ id: real, date: per.date, label: per.label, morning: per.morning, savedAt: null });
    UI.draft[real] = draft;
    UI.touched[real] = UI.touched[pid];
    delete UI.draft[pid];
    delete UI.touched[pid];
    UI.recalled[real] = UI.recalled[pid];
    delete UI.recalled[pid];
    UI.attPid = pid = real;
  }
  if (asRequest) {
    await run('request_attendance', { p_period: pid, p_statuses: draft }, '출석 요청을 보냈어요 · 부총대 확인을 기다려요');
    // 보낸 뒤에는 아직 지각인 학생만 남긴다
    delete UI.recalled[pid];
    render();
    return;
  }
  // 저장이 끝나면 초안을 지운 뒤에 다시 그린다 (먼저 그리면 방금 저장한 초안이 "변경 사항 있음"으로 보인다)
  const before = S.lastOp?.id ?? null;
  const n = await rpc('save_attendance', { p_token: token(), p_period: pid, p_statuses: draft });
  delete UI.draft[pid];
  delete UI.touched[pid];
  delete UI.recalled[pid];
  UI.noticeText = null;
  await refresh();
  render();
  doneToast(`저장했어요 · 새 자봉 ${n}건`, before);
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
  if (!sids.length || bad.length) return toast('학생을 골라 주세요');
  if (!f.item.trim()) return toast('항목명을 입력하세요');
  if (!f.date) return toast('날짜를 입력하세요');
  if (!L.isHalfStep(pts) || pts === 0) return toast('점수는 0이 아닌 0.5점 단위로 적어 주세요');
  const common = { p_date: f.date, p_sids: sids, p_item: f.item.trim(), p_detail: f.detail.trim(), p_points: pts };
  if (fk === 'reqForm') {
    await run('create_request', { ...common, p_reason: f.reason.trim(), p_photo: f.photo || null }, '요청을 보냈어요');
    UI.reqForm = { ...blankForm(), date: f.date };
  } else {
    await run('add_entries', common, (n) => `${n}명에게 ${pts > 0 ? `자봉 ${pts}점을 부과했어요` : `상점 ${-pts}점을 줬어요`}${n < sids.length ? ` · 자봉 면제 ${sids.length - n}명은 빠졌어요` : ''}`);
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
    UI.roleSet = true;
    resetDrafts();
    await refresh();
    UI.tab = tabsOf(UI.role)[0][0];
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
    UI.roleSet = true;
    resetDrafts();
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
  'pw-open': () => {
    UI.pwOpen = !UI.pwOpen;
    window.scrollTo(0, 0);
  },
  'pw-change': async () => {
    if (val('pw-new') !== val('pw-new2')) return toast('새 비밀번호 두 칸이 달라요');
    await rpc('change_pw', { p_token: token(), p_cur: val('pw-cur'), p_new: val('pw-new') });
    UI.pwOpen = false;
    render();
    return toast('내 비밀번호를 바꿨어요');
  },
  'link-save': async (d) => {
    const id = ['dday', 'dday_admin'].includes(d.id) ? d.id : 'store';
    const url = val(`${id}-url`).trim();
    if (url && !/^https:\/\/[^\s"<>]+$/.test(url)) return toast('링크는 https:// 로 시작하는 주소여야 해요 (띄어쓰기 없이)');
    if (id !== 'store' && url && !/[#&]k=[^&]+/.test(url)) return toast('디데이 링크는 보기 키(#k=…)까지 통째로 붙여넣어 주세요');
    const msg = {
      dday: url ? '디데이 링크를 저장했어요 · 학생 화면 첫 탭이 디데이가 돼요' : '디데이 링크를 지웠어요',
      dday_admin: url ? '디데이 관리자 링크를 저장했어요 · 총대단·부총대 화면 첫 탭이 디데이가 돼요' : '디데이 관리자 링크를 지웠어요',
      store: url ? '매점 링크를 저장했어요 · 자봉 현황에 버튼이 생겼어요' : '매점 링크를 지웠어요',
    }[id];
    await run('set_link', { p_id: id, p_url: url }, msg);
    return true;
  },
  'pw-reset': async () => {
    const who = val('pw-who');
    await rpc('reset_pw', { p_token: token(), p_role: who, p_new: val('pw-reset') });
    render();
    return toast(`${who} 비밀번호를 재설정했어요. 본인에게 알려주세요`);
  },
  tab: (d) => {
    if (d.tab === 'history') UI.hist = { ...UI.hist, list: null, preview: null, error: null, loading: false };
    if (d.tab === 'excuse' && !UI.excForm.no && myStudent()) UI.excForm.no = String(UI.myNo);
    if (d.tab === 'react' && !UI.reactForm.no && myStudent()) UI.reactForm.no = String(UI.myNo);
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
    UI.recFilter = '';
    UI.recSid = d.sid;
  },
  'rec-all': () => {
    UI.recSid = null;
  },
  pick: (d) => {
    addStudents(d.fk, [d.sid]);
    const inp = document.getElementById(d.fk + '-find');
    UI[d.fk].find = '';
    if (inp) {
      // 한글 조합 중이면 blur로 조합을 먼저 끝낸다. 안 그러면 조합이 끝날 때 친 글자가 칸에 되살아난다.
      inp.blur();
      UI[d.fk].find = '';
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
    UI.touched[UI.attPid] = true;
    const h = perHours(UI.attPid);
    // 여러 시간 수업: 지각·결석은 누를 때마다 그 시간을 하나 늘린다. 합이 수업 시간만큼 찼으면 다른 쪽에서 한 시간을 가져오고,
    // 다른 쪽도 없으면(그것만으로 다 찼으면) 그 항목을 지운다. 예) 3시간: 지각 → 지각 2 → 지각 3 → 출석, 지각 1에서 결석 두 번 → 지각 1 · 결석 2
    if ((d.v === 'late' || d.v === 'absent') && h > 1) {
      let { l, a } = attOf(dr[d.sid]);
      if (d.v === 'late') {
        if (l + a < h) l++;
        else if (a) (a--, l++);
        else l = 0;
      } else if (l + a < h) a++;
      else if (l) (l--, a++);
      else a = 0;
      const v = attStr(l, a);
      if (v) dr[d.sid] = v;
      else delete dr[d.sid];
    } else if (d.v === 'present') delete dr[d.sid];
    else dr[d.sid] = d.v;
  },
  cyc: (d) => {
    const dr = attDraft(UI.attPid);
    UI.touched[UI.attPid] = true;
    // 출석 → 지각(시간만큼 1번, 2번 …) → 결석(1시간, 2시간 …) → 공결 → 출석
    const h = perHours(UI.attPid);
    const order = ['present', ...Array.from({ length: h }, (_, i) => attV('late', i + 1)), ...Array.from({ length: h }, (_, i) => attV('absent', i + 1)), 'excused'];
    const n = order[(order.indexOf(dr[d.sid] || 'present') + 1) % order.length];
    if (n === 'present') delete dr[d.sid];
    else dr[d.sid] = n;
  },
  'recall-tog': (d) => {
    const dr = attDraft(UI.attPid);
    // 지각 ↔ 출석만. 그사이 다른 기기에서 결석·공결이 된 학생은 건드리지 않는다
    // 지각만 지운다 (함께 있던 결석은 남는다). 다시 누르면 전의 지각 횟수로 돌아간다 (rec: 바꾸기 전 값과 남긴 값)
    const rec = (UI.recallPrev[UI.attPid] ||= {});
    const r = rec[d.sid];
    const cur = dr[d.sid] || null;
    if (!lateN(cur) && !(r && cur === r.left) && cur) return toast('결석·공결인 학생은 위 목록에서 바꾸세요');
    UI.touched[UI.attPid] = true;
    const back = (UI.recalled[UI.attPid] ||= []);
    let next;
    if (lateN(cur)) {
      next = attStr(0, attOf(cur).a);
      rec[d.sid] = { from: cur, left: next };
      if (!back.includes(d.sid)) back.push(d.sid);
    } else next = r && cur === r.left ? r.from : 'late';
    if (next) dr[d.sid] = next;
    else delete dr[d.sid];
  },
  'att-clear': () => {
    UI.attConfirm = true;
  },
  'att-clear-yes': () => {
    delete UI.recalled[UI.attPid];
    UI.draft[UI.attPid] = {};
    UI.touched[UI.attPid] = true;
    UI.attConfirm = false;
    toast('전원 출석으로 되돌렸어요 · 저장해야 반영돼요');
  },
  'att-clear-no': () => {
    UI.attConfirm = false;
  },
  'dd-new': () => {
    UI.ddDel = null;
    UI.ddForm = { id: '', title: '', date: '', time: '', room: dday?.data?.rooms?.[0] || '', detail: '' };
  },
  'dd-edit': (d) => {
    const t = dday?.data?.tasks.find((x) => String(x.id) === d.id);
    if (!t) return;
    const due = ddayDue(t.due);
    UI.ddDel = null;
    UI.ddForm = { id: String(t.id), title: t.title || '', date: due ? String(t.due).slice(0, 10) : '', time: due?.hm || '', room: t.room || '', detail: t.detail || '' };
  },
  'dd-cancel': () => {
    UI.ddForm = null;
  },
  'dd-save': async () => {
    const f = UI.ddForm;
    if (!f) return;
    if (!f.title.trim() || !f.date) return toast('제목과 날짜는 꼭 입력하세요');
    const src = ddayAdminUrl();
    if (!src || !dday?.data?.api) return toast('디데이를 다시 불러온 뒤 해 보세요');
    await ddayPost(src, dday.data.api, { type: f.id ? 'edit' : 'add', id: f.id, title: f.title.trim(), due: f.date + (f.time ? ` ${f.time}` : ''), room: f.room, detail: f.detail.trim() });
    const msg = f.id ? '일정을 고쳤어요' : '일정을 추가했어요';
    UI.ddForm = null;
    ddayLoad(src, true);
    render();
    return toast(msg);
  },
  'dd-del': (d) => {
    UI.ddForm = null;
    UI.ddDel = d.id;
  },
  'dd-del-no': () => {
    UI.ddDel = null;
  },
  'dd-del-yes': async (d) => {
    const src = ddayAdminUrl();
    if (!src || !dday?.data?.api) return toast('디데이를 다시 불러온 뒤 해 보세요');
    await ddayPost(src, dday.data.api, { type: 'delete', id: d.id });
    UI.ddDel = null;
    ddayLoad(src, true);
    render();
    return toast('일정을 지웠어요');
  },
  'per-hours': async (d) => {
    const per = S.periods.find((p) => p.id === d.id);
    const h = Number(d.v);
    if (!per || per.hours === h) return;
    await run('set_period_hours', { p_id: d.id, p_hours: h }, (n) => `${h}시간 수업으로 바꿨어요${n ? ` · 이 교시 자봉 ${n}건의 점수도 고쳤어요` : ''}`);
    return true;
  },
  'pick-period': (d) => {
    UI.attPid = d.id;
  },
  'per-ren': (d) => {
    UI.perEdit = d.id;
    UI.perName = S.periods.find((p) => p.id === d.id)?.label || '';
    render();
    const el = document.getElementById('per-name');
    el?.focus();
    el?.select();
    return true;
  },
  'per-ren-no': () => {
    UI.perEdit = null;
  },
  'per-ren-save': async (d) => {
    const old = S.periods.find((p) => p.id === d.id)?.label || '';
    const label = (UI.perName || '').trim();
    if (!label) return toast('교시 이름을 입력하세요');
    if (label === old) {
      UI.perEdit = null;
      return;
    }
    // 서버가 거절하면(같은 이름이 이미 있음 등) 적던 이름이 남도록, 바뀐 뒤에만 입력칸을 닫는다
    await run('rename_period', { p_id: d.id, p_label: label }, `교시 이름을 바꿨어요: ${old} → ${label}`);
    UI.perEdit = null;
    render();
  },
  'per-del': (d) => {
    UI.perDel = d.id;
  },
  'per-del-no': () => {
    UI.perDel = null;
  },
  'per-del-yes': async (d) => {
    const label = S.periods.find((p) => p.id === d.id)?.label || '';
    UI.perDel = null;
    // 서버가 거절하면(대기 중인 요청 등) 고치던 출결을 그대로 두도록, 지워진 뒤에만 초안을 비운다
    await run('delete_period', { p_id: d.id }, (n) => `교시를 지웠어요: ${label}${n ? ` · 자봉 ${n}건 무효 처리` : ''}`);
    delete UI.draft[d.id];
    delete UI.touched[d.id];
    UI.attPid = null;
    render();
  },
  'add-period': async () => {
    const l = UI.newPeriod.trim();
    if (!l) return toast('교시 이름을 입력하세요');
    // 이미 있는 교시면 새로 만들지 않고 그 교시를 고른다 (부총대에게는 아침 출석도 늘 있다)
    const same = periodsOf(UI.attDate).find((p) => p.label === l) || S.periods.find((p) => p.date === UI.attDate && p.label === l);
    if (same && !String(same.id).startsWith('v:')) {
      UI.attPid = same.id;
      UI.newPeriod = '';
      render();
      return toast('이미 있는 교시예요 · 그 교시를 골랐어요');
    }
    // 교시 추가에는 되돌리기 버튼을 붙이지 않는다: 다른 기기가 방금 같은 교시를 만들었으면 새 작업이 없어서 엉뚱한 작업을 가리킬 수 있다
    // 수업 시간은 교시를 고른 뒤 아래 "1시간~4시간" 버튼으로 바꾼다. 자주 쓰는 교시에 시간을 저장해 뒀으면 그 시간으로
    const h = Math.max(1, myPeriodPresets().find((p) => p.name === l)?.points || 1);
    const id = await rpc('ensure_period', { p_token: token(), p_date: UI.attDate, p_label: l, p_morning: false, ...(h > 1 ? { p_hours: h } : {}) });
    UI.attPid = id;
    UI.newPeriod = '';
    await refresh();
    render();
    return toast(h > 1 ? `교시를 추가했어요 · ${h}시간 수업 (지각·결석은 누르는 횟수만큼)` : '교시를 추가했어요');
  },
  'att-save': async () => {
    await saveAttendance(false);
    return true;
  },
  'att-request': async () => {
    await saveAttendance(true);
    return true;
  },
  'att-ok': async (d) => {
    await run('review_attendance', { p_id: d.id, p_approve: true, p_note: null }, (n) => `출석을 저장했어요 · 새 자봉 ${n}건`);
    clearDrafts();
    UI.noticeText = null;
    return true;
  },
  'att-no': async (d) => {
    await run('review_attendance', { p_id: d.id, p_approve: false, p_note: val('note-' + d.id) }, '반려했어요');
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
    if (!val('ed-date')) return toast('날짜를 입력하세요');
    const before = S.lastOp?.id ?? null;
    await rpc('edit_entry', { p_token: token(), p_id: d.id, p_date: val('ed-date'), p_item: val('ed-item'), p_detail: val('ed-detail'), p_points: pts, p_reason: val('ed-reason') });
    UI.editId = null;
    UI.noticeText = null;
    await refresh();
    render();
    return doneToast('수정했어요 · 이력에 남았어요', before);
  },
  'void-save': async (d) => {
    const before = S.lastOp?.id ?? null;
    await rpc('void_entry', { p_token: token(), p_id: d.id, p_reason: val('vd-reason') });
    UI.voidId = null;
    UI.noticeText = null;
    await refresh();
    render();
    return doneToast('무효 처리했어요 · 점수에서 빠졌어요', before);
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
    await run('review_excuse', { p_id: d.id, p_approve: true, p_note: null }, S.excuses.some((x) => x.id === d.id && x.grp) ? '하루 전체 공결을 승인했어요 · 그날 자봉이 무효 처리됐어요' : '공결을 승인했어요 · 해당 자봉이 무효 처리됐어요');
    clearDrafts();
    UI.noticeText = null;
    return true;
  },
  'exc-no': async (d) => {
    await run('review_excuse', { p_id: d.id, p_approve: false, p_note: val('note-' + d.id) }, '반려했어요');
    return true;
  },
  'rx-retry': () => {
    rxLoad = null;
    rxFeed = null;
  },
  'rx-more': () => {
    UI.rxFeedN = Math.min(300, UI.rxFeedN + 30);
  },
  'rxadj-apply': async () => {
    const plan = L.planReactAdj(S, UI.rxAdjText);
    if (plan.errors.length || !plan.items.length) return toast(plan.errors[0] || '바뀌는 학생이 없어요');
    await run('reaction_adjust', { p_list: plan.items.map((x) => ({ sid: x.sid, n: x.to })) }, `${plan.items.length}명의 리액션 이월을 맞췄어요`);
    UI.rxAdjText = '';
    render();
    return true;
  },
  'rx-per': (d) => {
    UI.reactForm.period = d.v;
  },
  'rx-add': async () => {
    const f = UI.reactForm;
    const s = S.students.find((x) => x.active && x.no === Number(f.no));
    if (!s) return toast('번호를 확인하세요');
    if (!f.period.trim()) return toast('교시를 적어 주세요');
    if (!f.q.trim()) return toast('질문을 적어 주세요');
    if (!f.a.trim()) return toast('내 대답을 적어 주세요');
    // 오늘 낸 수는 불러온 것이 있을 때만 (못 불러왔으면 숫자를 빼고 알린다)
    const R0 = rxLoad?.sid === s.id && !rxLoad.err ? rxLoad.data : null;
    await rpc('create_reaction', { p_student: s.id, p_period: f.period.trim(), p_question: f.q.trim(), p_answer: f.a.trim() });
    UI.reactForm = { no: f.no, period: f.period, q: '', a: '' };
    await refresh();
    render();
    return toast(`신청했어요 · 부총대 확인을 기다려요${R0 ? ` (오늘 ${R0.today + 1}/${REACT_MAX})` : ''}`);
  },
  'rx-ok': async (d) => {
    const ids = d.ids.split(',');
    await run('review_reaction', { p_ids: ids, p_approve: true, p_note: null }, (m) => `${ids.length}건 승인했어요${m ? ` · 상점 ${m}점이 생겼어요` : ''}`);
    UI.noticeText = null;
    return true;
  },
  'rx-no': async (d) => {
    await run('review_reaction', { p_ids: [d.id], p_approve: false, p_note: val('note-rx-' + d.id) }, '반려했어요');
    return true;
  },
  'exc-add': async () => {
    const f = UI.excForm;
    const s = S.students.find((x) => x.active && x.no === Number(f.no));
    if (!s) return toast('번호를 확인하세요');
    if (!f.eid) return toast('공결 처리할 출결을 고르세요');
    const day = f.eid.startsWith('day:') ? f.eid.slice(4) : null;
    const n = day
      ? await rpc('create_excuse_day', { p_student: s.id, p_date: day, p_reason: f.reason.trim(), p_photo: f.photo || null })
      : await rpc('create_excuse', { p_student: s.id, p_ledger: f.eid, p_reason: f.reason.trim(), p_photo: f.photo || null });
    UI.excForm = { no: f.no, eid: '', reason: '', photo: '' };
    await refresh();
    render();
    return toast(day ? `하루 전체(${n}건)를 신청했어요 · 부총대 확인을 기다려요` : '신청했어요 · 부총대 확인을 기다려요');
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
    // "최근 하루"는 새 기록이 생기면 그날로 따라간다
    UI.noticeAuto = d.v === 'one' ? last : null;
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
    // 파일은 누른 순간의 장부로 만든다 (리액션을 받는 동안 새로 불러와도 섞이지 않게)
    const S0 = S;
    const [from, to, label] = L.expRange(S0, UI.exp, TODAY);
    // 리액션 내역은 상태에 다 싣지 않으니 따로 받아 온다. 서버가 아직 옛 버전이면 리액션 시트만 비운다
    let rx = [];
    let rxOk = true;
    try {
      // 전체 기간이면 리액션도 처음부터 끝까지 (기록이 없는 날의 리액션도 빠지지 않게. 정리하면 지워지니)
      const all = UI.exp.range === 'all';
      rx = await rpc('reaction_export', { p_token: token(), p_from: all ? '2000-01-01' : from, p_to: all ? '2999-12-31' : to });
    } catch (e) {
      if (e.code === '28000') throw e;
      rxOk = false;
    }
    await downloadExport(S0, from, to, `25학번_자봉_${label}.xlsx`, rx);
    if (UI.exp.range === 'all' && rxOk) {
      UI.fullBackup = true;
      UI.fullBackupVer = S0.ver;
    }
    render();
    return toast(rxOk ? '엑셀 파일을 만들었어요' : '엑셀 파일을 만들었어요 (리액션은 불러오지 못해 빠졌어요. 서버 반영을 확인하세요)');
  },
  purge: async () => {
    if (!UI.fullBackup || UI.fullBackupVer !== S.ver || UI.purgeTyped.trim() !== '정리') return toast('전체 기간 파일과 확인 입력이 필요해요');
    const r = await rpc('purge', { p_token: token(), p_cut: UI.purgeCut });
    UI.purgeTyped = '';
    UI.fullBackup = false;
    UI.noticeText = null;
    UI.noticeFrom = null;
    clearDrafts();
    await refresh();
    render();
    return toast(`기록 ${r.old}건을 이월 ${r.carry}건으로 정리했어요${r.reactions ? ` · 리액션 ${r.reactions}건 지움` : ''}`);
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
  'exempt-add': async () => {
    const inp = document.getElementById('exForm-find');
    if (inp && inp.value.trim()) {
      const { bad } = commitPicker(inp, true);
      if (bad.length) return toast(`"${bad.join(', ')}"을(를) 목록에서 골라 주세요`);
    }
    const ids = parseNums(UI.exForm.nums).sids.filter((id) => !stu(id).exempt);
    if (!ids.length) return toast('면제로 지정할 학생을 골라 주세요');
    UI.exForm = blankForm();
    await run('roster_apply', { p_ops: ids.map((id) => ({ op: 'exempt', id, on: true })), p_adjs: [], p_date: TODAY }, `${ids.map(noOf).join(', ')}번을 자봉 면제로 지정했어요`);
    return true;
  },
  'stu-exempt': async (d) => {
    await run('roster_apply', { p_ops: [{ op: 'exempt', id: d.sid, on: false }], p_adjs: [], p_date: TODAY }, `${noOf(d.sid)}번 자봉 면제를 풀었어요`);
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
  'sug-pick': (d) => {
    const x = SUG?.list[Number(d.i)];
    const el = SUG?.el;
    if (!x || !el) return true;
    // 한글 조합 중이면 blur로 조합을 먼저 끝낸다 (학생 고르기와 같은 이유)
    el.blur();
    el.value = x.v;
    el.focus();
    // 항목명을 고르면 그때 쓴 점수도 함께
    if (x.pts != null && el.dataset.fk) {
      UI[el.dataset.fk].points = x.pts;
      const p = document.getElementById(el.dataset.fk + '-points');
      if (p) p.value = x.pts;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    hideSug();
    return true;
  },
  'pts-open': (d) => {
    const pop = document.getElementById(d.fk + '-ptspop');
    closePtsPops(pop);
    pop.hidden = !pop.hidden;
    document.querySelector(`[data-act="pts-open"][data-fk="${d.fk}"]`)?.setAttribute('aria-expanded', String(!pop.hidden));
    return true;
  },
  'pts-pick': (d) => {
    UI[d.fk].points = Number(d.v);
    const box = document.getElementById(d.fk + '-points');
    if (box) box.value = d.v;
    closePtsPops();
    return true;
  },
  'bk-download': async () => {
    await downloadBackup('jabong-backup-');
    return toast('백업 파일을 받았어요');
  },
  'bk-open': async () => {
    const dump = await decryptBackup(UI.bk.file, UI.bk.pw);
    if (!Array.isArray(dump?.tables?.students) || !Array.isArray(dump?.tables?.ledger)) return toast('자봉 장부 백업 파일이 아니에요');
    UI.bk.dump = dump;
    UI.bk.typed = '';
  },
  'bk-restore': async () => {
    if (UI.bk.typed.trim() !== '되살리기') return toast("확인 칸에 '되살리기'라고 적어 주세요");
    await downloadBackup('jabong-되살리기전-');
    const r = await rpc('restore_backup', { p_token: token(), p_data: UI.bk.dump });
    UI.bk = { pw: '', file: null, fileName: '', dump: null, typed: '' };
    clearDrafts();
    UI.noticeText = null;
    await refresh();
    render();
    return toast(`${r.createdAt} 백업으로 되살렸어요 · 직전 상태 파일도 받아 뒀어요`);
  },
  'hist-pv': async (d) => {
    if (d.target === '' || d.target == null) return;
    const target = Number(d.target);
    const data = await rpc('history_move', { p_token: token(), p_target: target, p_preview: true });
    // top: 화면의 작업 내역이 기준으로 삼은 맨 위 작업. 실행할 때 서버와 다르면 멈춘다
    UI.hist.preview = { target, title: d.title, data, top: UI.hist.list?.[0]?.id ?? null };
    window.scrollTo(0, 0);
  },
  'hist-drop-pv': async (d) => {
    const id = Number(d.id);
    const restore = !!d.restore;
    const data = await rpc(restore ? 'history_restore' : 'history_drop', { p_token: token(), p_op: id, p_preview: true });
    UI.hist.preview = { drop: id, restore, title: restore ? '다시 살리기' : '이 작업만 되돌리기', data, top: UI.hist.list?.[0]?.id ?? null };
    window.scrollTo(0, 0);
  },
  'myno-set': (d) => {
    const no = Number(d.no || val('myno'));
    if (!S.students.some((x) => x.active && x.no === no)) return toast('없는 번호예요');
    setMyNo(no);
    UI.sid = null;
    UI.tab = 'board';
    window.scrollTo(0, 0);
    toast(`${no}번을 내 번호로 정했어요 · 이 폰에만 기억해요`);
  },
  install: async () => {
    const e = installEvt;
    installEvt = null;
    if (e) {
      e.prompt();
      await e.userChoice;
    }
  },
  'myno-clear': () => {
    setMyNo(null);
  },
  'undo-last': async (d) => {
    document.getElementById('toast').hidden = true;
    await rpc('history_drop', { p_token: token(), p_op: Number(d.id), p_preview: false });
    clearDrafts();
    UI.noticeText = null;
    UI.hist = { ...UI.hist, list: null, preview: null };
    await refresh();
    render();
    return toast('되돌렸어요 · 작업 내역에서 다시 살릴 수 있어요');
  },
  'hist-retry': () => {
    UI.hist = { ...UI.hist, list: null, error: null, loading: false };
  },
  'hist-cancel': () => {
    UI.hist.preview = null;
  },
  'hist-run': async () => {
    const p = UI.hist.preview;
    // 미리보기 뒤에 다른 사람이 새 작업을 했으면(학생 신청 등) 그 작업까지 되돌리게 되므로 멈춘다
    const top = (await rpc('ops_list', { p_token: token(), p_limit: 1 }))[0]?.id ?? null;
    if (top !== p.top) {
      UI.hist = { ...UI.hist, list: null, preview: null, loading: false };
      await refresh();
      render();
      return toast('그사이 새 작업이 생겼어요. 작업 내역을 새로 불러왔으니 다시 확인해 주세요');
    }
    if (p.drop) await rpc(p.restore ? 'history_restore' : 'history_drop', { p_token: token(), p_op: p.drop, p_preview: false });
    else await rpc('history_move', { p_token: token(), p_target: p.target, p_preview: false });
    UI.hist.preview = null;
    clearDrafts();
    UI.noticeText = null;
    await Promise.all([refresh(), loadHistory()]);
    render();
    return toast(p.restore ? '다시 살렸어요' : p.drop ? '되돌렸어요' : '이동했어요');
  },
  'hist-more': async () => {
    UI.hist.limit += 50;
    await loadHistory();
  },
  // 명단 하나씩 고치기를 펼친 채로 두어야 학생을 추가·제외한 뒤 바로 이어서 고칠 수 있다
  'roster-toggle': () => {
    UI.rosterOpen = !UI.rosterOpen;
    return true;
  },
  'pr-open': (d) => {
    const open = UI.prOpen === d.fk;
    closePtsPops();
    closePresetPops();
    hideSug();
    if (!open) {
      UI.prOpen = d.fk;
      openPresetPop(d.fk);
    }
    return true;
  },
  'pr-use': (d) => {
    const p = S.presets.find((x) => x.id === d.id);
    if (!p) return true;
    if (d.fk === 'np') {
      UI.newPeriod = p.name;
      document.getElementById('newPeriod').value = p.name;
      closePresetPops();
      return true;
    }
    const f = UI[d.fk];
    f.item = p.name;
    f.points = p.points;
    document.getElementById(d.fk + '-item').value = p.name;
    document.getElementById(d.fk + '-points').value = p.points;
    closePresetPops();
    updateLive(d.fk);
    return true;
  },
  'pr-add': (d) => {
    UI.prAdding = d.fk;
    openPresetPop(d.fk);
    document.getElementById(d.fk + '-prname')?.focus();
    return true;
  },
  'pr-cancel': (d) => {
    UI.prAdding = null;
    openPresetPop(d.fk);
    return true;
  },
  'pr-save': async (d) => {
    if (d.fk === 'np') {
      const name = val('np-prname').trim();
      if (!name) return toast('교시 이름을 적어 주세요');
      if (myPeriodPresets().some((p) => p.name === name)) return toast('이미 있는 교시예요');
      UI.prOpen = 'np';
      const hrs = Number(val('np-prhours')) || 1;
      const keep = myPeriodPresets().map((p) => ({ name: p.name, hours: Math.max(1, p.points || 1) }));
      await run('my_periods_save', { p_list: [...keep, { name, hours: hrs }] }, `자주 쓰는 교시에 넣었어요: ${name}${hrs > 1 ? ` (${hrs}시간)` : ''}`);
      // 서버가 거절하면 적던 이름이 남도록 저장된 뒤에만 입력칸을 닫는다
      UI.prAdding = null;
      openPresetPop('np');
      return true;
    }
    const name = val(d.fk + '-prname').trim();
    const pts = Number(val(d.fk + '-prpts'));
    if (!name) return toast('항목명을 적어 주세요');
    if (!Number.isInteger(pts) || pts === 0) return toast('자주 쓰는 항목 점수는 0이 아닌 정수여야 해요');
    if (myPresets().some((p) => p.name === name && p.points === pts)) return toast('이미 있는 항목이에요');
    const list = [...myPresets().map((p) => ({ name: p.name, points: p.points })), { name, points: pts }];
    UI.prOpen = d.fk;
    await run('my_presets_save', { p_list: list }, `자주 쓰는 항목에 넣었어요: ${name} ${sgn(pts)}`);
    UI.prAdding = null;
    openPresetPop(d.fk);
    return true;
  },
  'pr-del': async (d) => {
    const gone = S.presets.find((p) => p.id === d.id);
    if (d.fk === 'np') {
      UI.prOpen = 'np';
      await run('my_periods_save', { p_list: myPeriodPresets().filter((p) => p.id !== d.id).map((p) => ({ name: p.name, hours: Math.max(1, p.points || 1) })) }, `자주 쓰는 교시에서 뺐어요: ${gone?.name || ''}`);
      return true;
    }
    const list = myPresets().filter((p) => p.id !== d.id).map((p) => ({ name: p.name, points: p.points }));
    UI.prOpen = d.fk;
    await run('my_presets_save', { p_list: list }, `자주 쓰는 항목에서 뺐어요: ${gone?.name || ''}`);
    return true;
  },
};

let busy = false;
document.addEventListener('click', async (ev) => {
  // 점수 숫자판 밖을 누르면 닫는다
  if (!ev.target.closest('.ptsbox')) closePtsPops();
  if (UI.prOpen && !ev.target.closest('.itembox')) closePresetPops();
  const el = ev.target.closest('[data-act]');
  if (!el || busy) return;
  const act = el.dataset.act;
  if (!/^att-clear/.test(act)) UI.attConfirm = false;
  if (!/^per-del/.test(act)) UI.perDel = null;
  if (!/^per-ren/.test(act)) UI.perEdit = null;
  const fn = A[act];
  if (!fn) return;
  busy = true;
  document.body.style.cursor = 'progress';
  try {
    const done = await fn(el.dataset);
    if (done !== true) render();
  } catch (e) {
    if (e.code === '28000') await signOut(e.message);
    else {
      toast(e.message || '문제가 생겼어요. 다시 해보세요');
      // 다른 기기에서 이미 처리한 것이면 화면을 새로 불러와 그 카드를 치운다
      if (/이미 처리된|새로 불러온 뒤/.test(e.message || '')) {
        await refresh();
        renderKeep();
      }
    }
  } finally {
    busy = false;
    document.body.style.cursor = '';
  }
});

// 학생 추천·칩·명단 버튼은 손가락을 떼는 순간 바로 누른다.
// 보통의 click은 입력칸이 포커스를 잃은 뒤에 오는데, 그때 한글 조합이 끝나면서 추천 목록이 다시 그려져
// 누른 버튼이 사라지므로 두 번 눌러야 했다. 컴퓨터에서는 mousedown에서 포커스를 뺏지 않게 막는다.
const TAP_NOW = '[data-act="pick"], [data-act="unpick"], [data-act="gtoggle"], [data-act="sug-pick"]';
let tapStart = null;
document.addEventListener('touchstart', (ev) => {
  const t = ev.touches[0];
  tapStart = ev.touches.length === 1 && ev.target.closest(TAP_NOW) ? { el: ev.target.closest(TAP_NOW), x: t.clientX, y: t.clientY } : null;
}, { passive: true });
document.addEventListener('touchend', (ev) => {
  const st = tapStart;
  tapStart = null;
  if (!st) return;
  const t = ev.changedTouches[0];
  // 목록을 스크롤한 것이면 누른 것으로 보지 않는다
  if (Math.abs(t.clientX - st.x) > 10 || Math.abs(t.clientY - st.y) > 10) return;
  if (ev.target.closest(TAP_NOW) !== st.el) return;
  ev.preventDefault(); // 뒤따르는 click(이미 다시 그려진 자리에 떨어진다)을 막는다
  st.el.click();
}, { passive: false });
document.addEventListener('mousedown', (ev) => {
  if (ev.target.closest(TAP_NOW)) ev.preventDefault();
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
  if (ev.target.id === 'per-name' && !ev.isComposing && (ev.key === 'Enter' || ev.key === 'Escape')) {
    ev.preventDefault();
    document.querySelector(ev.key === 'Enter' ? '[data-act="per-ren-save"]' : '[data-act="per-ren-no"]')?.click();
    return;
  }
  if (ev.key === 'Enter' && ev.target.id === 'login-pw') document.querySelector('[data-act="login"]')?.click();
  if (ev.key === 'Enter' && !ev.isComposing && /-pr(name|pts)$/.test(ev.target.id || '')) {
    ev.preventDefault();
    document.querySelector(`[data-act="pr-save"][data-fk="${ev.target.id.split('-')[0]}"]`)?.click();
  }
});

async function boot() {
  const sess = getSession();
  if (sess) {
    UI.user = sess.role;
  }
  render();
  if (!configured) return;
  // 로그인돼 있으면 직책(부총대/총대단)은 처음으로 불러오기에 성공한 뒤에 정한다 (refresh 안에서).
  // 실패한 채로 정하면 직책 목록이 비어 부총대가 총대단 화면에 떨어진다
  UI.roleSet = !UI.user;
  await refresh();
  render();
  let timer;
  onChange(() => {
    clearTimeout(timer);
    timer = setTimeout(refreshBg, 300);
  });
  // 디데이는 1분마다 다시 그린다 (지난 마감이 빠지고 D-숫자가 바뀐다)
  setInterval(() => {
    if (UI.tab === 'dday' && !document.hidden) softRender();
  }, 60000);
  // 오래 켜 둔 화면이 날짜를 넘기면 오늘 날짜를 다시 맞춘다
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshBg();
  });
}

boot();
