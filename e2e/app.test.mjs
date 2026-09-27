// 브라우저 전체 기능 테스트. 실제 화면(빌드 결과)을 Chromium으로 열고, 학생·총대단·부총대가 쓰는 모든 버튼을 누른다.
// 서버는 로컬 Postgres + 가짜 Supabase(e2e/server.mjs)라서 인터넷이 필요 없다.
//
//   npm run test:e2e
//
// 필요한 것: Postgres 16 (PGHOST·PGUSER·PGPASSWORD 환경 변수, anon·authenticated 역할은 없으면 만든다), Chromium
// (npx playwright install chromium, 또는 CHROMIUM_PATH로 실행 파일 지정).
// 테스트는 위에서부터 차례로 이어지는 하나의 이야기다 (명단 → 기록 → 출석 → 요청 → 공결 → 작업 내역 → 백업 → 정리).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { chromium } from 'playwright';
import { build } from 'vite';
import { startServer } from './server.mjs';
import { encryptBackup } from '../src/backupcrypt.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8788);
const DBNAME = process.env.E2E_DB || 'jabong_e2e';
const OUT = path.join(ROOT, 'e2e/out');
// 첨부용 사진: 단색 PNG를 직접 만든다
function makePng(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x5a)])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = makePng(40, 30);
const BIG = makePng(1600, 1200);
// 저장된 JPEG data URL의 가로·세로
function jpegSize(dataUrl) {
  const b = Buffer.from(dataUrl.split(',')[1], 'base64');
  for (let i = 2; i < b.length; ) {
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xc3) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;

let server, browser, db, CODE;
const errors = [];
const pw = { 부총대: '1234', 학습부장: '1234', 총대: '1234' };

const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const sid = async (name) => (await one('select id from students where name = $1', [name])).id;
const balances = async () =>
  Object.fromEntries(
    (await q(`select s.name, coalesce(sum(l.points) filter (where l.voided_at is null), 0)::float as b from students s left join ledger l on l.student_id = s.id where s.active group by s.name`)).map((r) => [r.name, r.b]),
  );

before(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const admin = new pg.Client({ database: 'postgres' });
  await admin.connect();
  await admin.query(`drop database if exists ${DBNAME} with (force)`);
  await admin.query(`create database ${DBNAME}`);
  await admin.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if; end $$`);
  await admin.end();
  db = new pg.Pool({ database: DBNAME });
  await db.query(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
  CODE = (await one(`select init_app('1234') as c`)).c;
  process.env.VITE_SUPABASE_URL = `http://localhost:${PORT}`;
  process.env.VITE_SUPABASE_ANON_KEY = 'e2e';
  await build({ root: ROOT, logLevel: 'error', build: { outDir: path.join(ROOT, 'e2e/dist'), emptyOutDir: true } });
  server = await startServer({ port: PORT, dist: path.join(ROOT, 'e2e/dist'), database: DBNAME });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
});

after(async () => {
  await browser?.close();
  await server?.close();
  await db?.end();
});

// ───────── 화면 도우미 ─────────
async function open({ width = 390, height = 844, touch = false, beforeGoto, userAgent } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    hasTouch: touch,
    isMobile: touch,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    permissions: ['clipboard-read', 'clipboard-write'],
    ...(userAgent ? { userAgent } : {}),
  });
  // 인터넷 글꼴은 막는다 (테스트가 외부에 기대지 않게)
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  // 앱이 파일을 받게 할 때 붙인 파일 이름을 기록해 둔다
  await ctx.addInitScript(() => {
    window.__downloads = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) window.__downloads.push(this.download);
      return orig.call(this);
    };
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  if (beforeGoto) await beforeGoto(ctx);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // 서버가 거절한 요청(400)과 끊어 둔 Realtime·글꼴 연결은 예상된 것이다
    if (m.type() === 'error' && !/Failed to load resource|realtime|WebSocket|fonts\.g/i.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => !document.querySelector('#view .boot'));
  return ui(page);
}

function ui(page) {
  const u = {
    page,
    text: (sel = '#view') => page.textContent(sel),
    tabs: () => page.$$eval('#tabs button', (b) => b.map((x) => x.firstChild.textContent.trim())),
    // 버튼을 누르고 비동기 동작이 끝날 때까지 기다린다 (동작 중에는 body 커서가 progress)
    async click(sel) {
      await page.click(sel);
      await page.waitForFunction(() => !document.body.style.cursor);
    },
    // 버튼을 누르고 뜨는 안내(토스트) 문구를 돌려준다
    async toast(sel) {
      await page.evaluate(() => (document.getElementById('toast').hidden = true));
      await page.click(sel);
      await page.waitForSelector('#toast:not([hidden])');
      await page.waitForFunction(() => !document.body.style.cursor);
      return (await page.textContent('#toast > span')).trim();
    },
    async tab(k) {
      await u.click(`#tabs [data-tab="${k}"]`);
      await page.waitForFunction(() => !document.querySelector('#view .boot'));
    },
    async login(role, who, password) {
      await u.click(`#roles [data-role="${role === '부총대' ? 'admin' : 'officer'}"]`);
      await page.selectOption('#login-who', who);
      await page.fill('#login-pw', password);
      await u.click('[data-act="login"]');
      await page.waitForSelector('#tabs button');
    },
    // 가로로 넘치지 않는지 (폰에서 옆으로 밀리지 않게)
    async fits(label) {
      const [sw, w] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      assert.ok(sw <= w, `${label}: 화면이 가로로 넘침 (${sw} > ${w})`);
    },
    clipboard: () => page.evaluate(() => navigator.clipboard.readText()),
    downloads: () => page.evaluate(() => window.__downloads),
    async download(sel) {
      const [d] = await Promise.all([page.waitForEvent('download'), page.click(sel)]);
      const file = path.join(OUT, `${Date.now()}-${(await u.downloads()).at(-1)}`);
      await d.saveAs(file);
      await page.waitForFunction(() => !document.body.style.cursor);
      return file;
    },
    token: () => page.evaluate(() => JSON.parse(localStorage.getItem('jabong-session'))?.token),
    async reload() {
      await page.reload();
      await page.waitForFunction(() => !document.querySelector('#view .boot'));
    },
  };
  return u;
}

// xlsx(zip) 안의 파일들을 글자로 푼다
function unzip(buf) {
  const out = {};
  let e = buf.length - 22;
  while (buf.readUInt32LE(e) !== 0x06054b50) e--;
  let p = buf.readUInt32LE(e + 16);
  for (let n = buf.readUInt16LE(e + 10); n > 0; n--) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const lo = buf.readUInt32LE(p + 42);
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const data = buf.subarray(start, start + size);
    out[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    p += 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

let S, A, O, C; // 학생, 부총대, 총대단(학습부장), 출석 권한 총대단(총대)

// ───────── 학생 첫 화면 ─────────
test('학생 첫 화면: 명단 없음, 탭 2개', async () => {
  S = await open();
  assert.deepEqual(await S.tabs(), ['현황판', '공결 신청']);
  assert.match(await S.text(), /아직 명단이 없어요/);
  assert.equal(await S.text('#subbar'), '');
  await S.fits('학생 현황판');
  await S.tab('excuse');
  assert.match(await S.text(), /공결 신청/);
});

// ───────── 부총대 로그인 ─────────
test('부총대 로그인: 틀린 비밀번호, Enter로 로그인, 탭 목록', async () => {
  A = await open();
  await A.click('#roles [data-role="admin"]');
  assert.match(await A.text(), /부총대 로그인/);
  assert.deepEqual(await A.page.$$eval('#login-who option', (o) => o.map((x) => x.textContent)), ['부총대']);
  await A.page.fill('#login-pw', 'wrong');
  assert.equal(await A.toast('[data-act="login"]'), '비밀번호가 맞지 않아요');
  await A.page.fill('#login-pw', '1234');
  await A.page.press('#login-pw', 'Enter');
  await A.page.waitForSelector('#tabs button');
  assert.deepEqual(await A.tabs(), ['출석', '기록', '요청함', '공지', '작업 내역', '관리', '현황판']);
  assert.match(await A.text('#subbar'), /부총대로 로그인됨/);
  await A.fits('부총대 출석(빈 명단)');
  assert.match(await A.text(), /관리 탭에서 명단을 먼저 넣어 주세요/);
});

// ───────── 명단 ─────────
test('관리: 명단 붙여넣기 — 오류 미리보기, 적용, 복사, 전체 명단 모드', async () => {
  await A.tab('manage');
  await A.fits('관리 탭');
  await A.page.fill('#roster-text', '번호\t이름\t자봉\n1\t김민서\t3\n2\t이도윤\t-1\n2\t박하준');
  assert.match(await A.text('#roster-preview'), /2번이 두 번 이상 있어요/);
  assert.ok(await A.page.isDisabled('[data-act="roster-apply"]'));
  await A.page.fill('#roster-text', '1\t김민서\t0.3');
  assert.match(await A.text('#roster-preview'), /자봉은 0\.5점 단위로/);
  await A.page.fill('#roster-text', '번호\t이름\t자봉\n1\t김민서\t3\n2\t이도윤\t-1\n3\t박하준\n4\t최서연\t0.5\n5\t정우진\n6\t한지우');
  const pv = await A.text('#roster-preview');
  assert.match(pv, /추가 6/);
  assert.match(pv, /자봉 조정 3/);
  assert.match(await A.text('[data-act="roster-apply"]'), /9건 적용/);
  assert.equal(await A.toast('[data-act="roster-apply"]'), '명단 9건을 반영했어요');
  assert.equal(await A.page.inputValue('#roster-text'), '');
  assert.deepEqual(await balances(), { 김민서: 3, 이도윤: -1, 박하준: 0, 최서연: 0.5, 정우진: 0, 한지우: 0 });
  assert.equal((await one(`select item from ledger l join students s on s.id = l.student_id where s.name = '김민서'`)).item, '기존 누적');

  assert.equal(await A.toast('[data-act="roster-copy"]'), '복사했어요. 엑셀에 붙여넣어 고치세요');
  assert.equal((await A.clipboard()).split('\n').slice(0, 3).join('|'), '번호\t이름\t자봉|1\t김민서\t3|2\t이도윤\t-1');

  // 전체 명단 모드: 붙여넣은 명단에 없는 학생은 제외 예정으로 보인다 (적용하지 않고 비운다)
  await A.page.fill('#roster-text', '1\t김민서\n2\t이도윤\n3\t박하준\n4\t최서연\n5\t정우진');
  assert.match(await A.text('#roster-preview'), /제외 0/);
  await A.page.check('#roster-replace');
  assert.match(await A.text('#roster-preview'), /제외 1/);
  assert.match(await A.text('#roster-preview'), /한지우/);
  await A.page.uncheck('#roster-replace');
  await A.page.fill('#roster-text', '');
  assert.equal(await A.text('#roster-preview'), '');
});

test('관리: 명단 하나씩 고치기 — 추가, 이름·번호 저장, 검사, 제외·복귀', async () => {
  const openList = () => A.page.$eval('details:has([data-act="stu-add"])', (d) => d.open);
  await A.page.click('summary:has-text("명단 하나씩 고치기")');
  assert.ok(await openList());
  assert.equal(await A.toast('[data-act="stu-add"]'), '7번을 추가했어요. 이름을 적고 명단 저장을 누르세요');
  assert.ok(await openList(), '학생을 추가한 뒤에도 목록이 펼쳐져 있어야 이름을 바로 적을 수 있다');
  const row = (no) => `.mrow:has(.no-in[value="${no}"])`;
  await A.page.fill(`${row(7)} .name-in`, '서지호');
  await A.page.fill(`${row(5)} .no-in`, '8');
  assert.equal(await A.toast('[data-act="nos-save"]'), '명단을 저장했어요');
  assert.deepEqual(
    (await q(`select no || name as x from students where active order by no`)).map((r) => r.x),
    ['1김민서', '2이도윤', '3박하준', '4최서연', '6한지우', '7서지호', '8정우진'],
  );
  assert.equal(await A.toast('[data-act="nos-save"]'), '바뀐 내용이 없어요');
  await A.page.fill(`${row(1)} .no-in`, '2');
  assert.equal(await A.toast('[data-act="nos-save"]'), '겹치는 번호가 있어요');
  await A.page.fill(`${row(2)} .no-in`, '0');
  assert.equal(await A.toast('[data-act="nos-save"]'), '번호는 1 이상의 정수여야 해요');
  await A.tab('board');
  await A.tab('manage');
  if (!(await openList())) await A.page.click('summary:has-text("명단 하나씩 고치기")');
  // 제외 → 복귀 (번호가 비어 있으면 그 번호로)
  assert.equal(await A.toast(`${row(6)} [data-act="stu-toggle"]`), '명단에서 제외했어요 (기록은 남아요)');
  assert.match(await A.text('.mrow:has(.name-in[value="한지우"])'), /제외됨/);
  assert.equal(await A.toast('.mrow:has(.name-in[value="한지우"]) [data-act="stu-toggle"]'), '6번으로 복귀했어요');
  // 제외된 사이에 다른 학생이 그 번호를 쓰면, 맨 끝 번호로 복귀한다
  await A.toast(`${row(6)} [data-act="stu-toggle"]`);
  await A.page.fill(`${row(7)} .no-in`, '6');
  await A.toast('[data-act="nos-save"]');
  assert.equal(await A.toast('.mrow:has(.name-in[value="한지우"]) [data-act="stu-toggle"]'), '9번으로 복귀했어요');
  assert.deepEqual(
    (await q(`select no || name as x from students where active order by no`)).map((r) => r.x),
    ['1김민서', '2이도윤', '3박하준', '4최서연', '6서지호', '8정우진', '9한지우'],
  );
  await A.fits('명단 하나씩 고치기');
});

// ───────── 현황판·학생 상세 (부총대) ─────────
test('현황판(부총대): 이름 표시, 정렬, 이름·번호 검색', async () => {
  await A.tab('board');
  const tiles = () => A.page.$$eval('#board-grid .tile', (t) => t.map((x) => x.querySelector('.no').textContent));
  assert.deepEqual(await tiles(), ['1', '2', '3', '4', '6', '8', '9']);
  assert.match(await A.text('#board-grid'), /김민서/);
  await A.click('[data-act="sort"][data-v="bal"]');
  assert.deepEqual(await tiles(), ['1', '4', '3', '6', '8', '9', '2']);
  await A.page.fill('#q', '서');
  assert.deepEqual(await tiles(), ['1', '4', '6']);
  await A.page.fill('#q', '9');
  assert.deepEqual(await tiles(), ['9']);
  await A.page.fill('#q', '없는사람');
  assert.match(await A.text('#board-grid'), /찾는 학생이 없어요/);
  await A.page.fill('#q', '');
  await A.click('[data-act="sort"][data-v="no"]');
  await A.fits('현황판');
});

// ───────── 기록 ─────────
test('기록: 입력 검사 안내', async () => {
  await A.tab('record');
  await A.fits('기록 탭');
  assert.equal(await A.page.inputValue('#recForm-date'), TODAY);
  assert.equal(await A.toast('[data-act="rec-add"]'), '항목명을 입력하세요');
  await A.page.fill('#recForm-item', '실습');
  await A.page.fill('#recForm-points', '0.3');
  assert.equal(await A.toast('[data-act="rec-add"]'), '점수는 0이 아닌 0.5점 단위로 적어 주세요');
  await A.page.fill('#recForm-points', '0');
  assert.equal(await A.toast('[data-act="rec-add"]'), '점수는 0이 아닌 0.5점 단위로 적어 주세요');
  await A.page.fill('#recForm-points', '1');
  assert.equal(await A.toast('[data-act="rec-add"]'), '학생을 골라 주세요');
  await A.page.fill('#recForm-find', '없는사람');
  assert.equal(await A.toast('[data-act="rec-add"]'), '학생 칸의 "없는사람"을(를) 목록에서 골라 주세요');
  await A.page.fill('#recForm-find', '');
});

test('기록: 항목 불러오기, 점수 숫자판, 학생 고르기(추천·번호·Enter·전체 명단·빼기), 저장', async () => {
  // 불러오기: 내 자주 쓰는 항목 (부총대 기본 6개)
  await A.click('[data-act="pr-open"][data-fk="recForm"]');
  assert.deepEqual(await A.page.$$eval('#recForm-prpop .pr-use', (b) => b.map((x) => x.textContent)), ['지각 +1', '결석 +2', '실습실 뒷정리 미흡 +1', '실습 +1', '소치 실습 +1', '매점 -1']);
  await A.fits('불러오기 창');
  await A.click('#recForm-prpop .pr-use:has-text("매점")');
  assert.ok(await A.page.isHidden('#recForm-prpop'));
  assert.equal(await A.page.inputValue('#recForm-item'), '매점');
  assert.equal(await A.page.inputValue('#recForm-points'), '-1');
  await A.page.fill('#recForm-item', '실습 준비 미흡');
  // 점수 숫자판: 열고, 고르면 닫힌다. 밖을 누르면 닫힌다.
  await A.click('[data-act="pts-open"][data-fk="recForm"]');
  assert.ok(await A.page.isVisible('#recForm-ptspop'));
  assert.deepEqual(await A.page.$$eval('#recForm-ptspop button', (b) => b.map((x) => x.textContent)), ['+5', '+4', '+3', '+2', '+1', '-5', '-4', '-3', '-2', '-1']);
  await A.click('#recForm-ptspop [data-v="2"]');
  assert.equal(await A.page.inputValue('#recForm-points'), '2');
  assert.ok(await A.page.isHidden('#recForm-ptspop'));
  await A.click('[data-act="pts-open"][data-fk="recForm"]');
  await A.page.click('h1');
  assert.ok(await A.page.isHidden('#recForm-ptspop'));
  // 이름 일부 → 추천에서 고르기
  await A.page.fill('#recForm-find', '김민');
  assert.match(await A.text('#recForm-sugg'), /1 김민서/);
  await A.click('#recForm-sugg [data-act="pick"]');
  assert.equal(await A.page.inputValue('#recForm-find'), '');
  // 번호 + 띄어쓰기
  await A.page.type('#recForm-find', '2 ');
  // 정확한 이름 + Enter
  await A.page.type('#recForm-find', '박하준');
  await A.page.press('#recForm-find', 'Enter');
  const chips = () => A.page.$$eval('#recForm-chips .chip', (c) => c.map((x) => x.textContent.replace(' ×', '')));
  assert.deepEqual(await chips(), ['1 김민서', '2 이도윤', '3 박하준']);
  // 전체 명단에서 누르기: 켜고, 눌러서 넣고, 다시 눌러서 빼고, 닫는다
  await A.click('[data-act="pickgrid"]');
  await A.click('#recForm-grid [data-act="gtoggle"]:has(b:text-is("4"))');
  assert.deepEqual(await chips(), ['1 김민서', '2 이도윤', '3 박하준', '4 최서연']);
  assert.equal(await A.text('#recForm-count'), '4명 선택');
  await A.click('#recForm-grid [data-act="gtoggle"]:has(b:text-is("4"))');
  await A.click('[data-act="pickgrid"]');
  assert.equal(await A.page.$('#recForm-grid .pickgrid'), null);
  // 칩을 눌러 빼기
  await A.click('#recForm-chips [data-act="unpick"]:has-text("2 이도윤")');
  assert.deepEqual(await chips(), ['1 김민서', '3 박하준']);
  await A.page.fill('#recForm-detail', '전원 안끔');
  assert.equal(await A.toast('[data-act="rec-add"]'), '2명에게 기록했어요');
  assert.equal(await A.page.inputValue('#recForm-item'), '');
  assert.deepEqual(await chips(), []);
  assert.equal(await A.page.inputValue('#recForm-date'), TODAY);
  assert.equal((await one(`select count(*)::int as n from ledger where item = '실습 준비 미흡' and points = 2 and detail = '전원 안끔' and date = $1`, [TODAY])).n, 2);
  // 같은 날짜·항목이면 중복 경고
  await A.page.fill('#recForm-item', '실습 준비 미흡');
  await A.page.type('#recForm-find', '1 ');
  assert.match(await A.text('#recForm-dup'), /이미 요청됐거나 기록된 번호: 1/);
  await A.click('#recForm-chips [data-act="unpick"]');
  // 0.5점 직접 입력
  await A.page.fill('#recForm-item', '소치 실습');
  await A.page.fill('#recForm-points', '1.5');
  await A.page.type('#recForm-find', '4 ');
  assert.equal(await A.toast('[data-act="rec-add"]'), '1명에게 기록했어요');
  assert.equal((await balances())['최서연'], 2);
  await A.fits('기록 입력 후');
});

test('기록: 수정(검사·이력)과 무효 처리', async () => {
  assert.match(await A.text('#rec-list .rec-row >> nth=0'), /소치 실습/, '같은 분에 적은 기록도 가장 최근 것이 맨 위');
  await A.page.fill('#recFilter', '1');
  const rows = await A.page.$$eval('#rec-list .rec-row .mono', (r) => r.map((x) => x.textContent));
  assert.ok(rows.length >= 2 && rows.every((x) => x === '1번'), '번호로 찾으면 그 번호만');
  const row = '#rec-list .rec-row:has-text("실습 준비 미흡")';
  await A.click(`${row} [data-act="edit"]`);
  await A.page.fill('#ed-points', '0.3');
  assert.equal(await A.toast('[data-act="edit-save"]'), '점수는 0이 아닌 0.5점 단위로 적어 주세요');
  await A.page.fill('#ed-points', '1');
  assert.equal(await A.toast('[data-act="edit-save"]'), '수정 사유를 입력하세요');
  await A.page.fill('#ed-reason', '오기');
  assert.equal(await A.toast('[data-act="edit-save"]'), '수정했어요 · 이력에 남았어요');
  assert.match(await A.text(row), /수정됨/);
  assert.equal((await one(`select count(*)::int as n from ledger_revisions`)).n, 1);
  await A.click(`${row} [data-act="edit"]`);
  await A.click('[data-act="edit-cancel"]');
  assert.equal(await A.page.$('#ed-points'), null);
  await A.click(`${row} [data-act="void"]`);
  assert.equal(await A.toast('[data-act="void-save"]'), '무효 처리 사유를 입력하세요');
  await A.page.fill('#vd-reason', '착오');
  assert.equal(await A.toast('[data-act="void-save"]'), '무효 처리했어요 · 점수에서 빠졌어요');
  assert.match(await A.text(row), /무효/);
  assert.equal(await A.page.$(`${row} [data-act="edit"]`), null, '무효 처리한 기록은 버튼이 없다');
  assert.equal((await balances())['김민서'], 3);
  await A.page.fill('#recFilter', '');
});

test('되돌리기 버튼: 부총대가 한 작업 바로 뒤 안내에서 누르면 그 작업만 없던 일로 (작업 내역에서 다시 살릴 수 있음)', async () => {
  const before = await balances();
  await A.page.fill('#recForm-item', '되돌리기 연습');
  await A.page.fill('#recForm-points', '3');
  await A.page.type('#recForm-find', '8 ');
  assert.equal(await A.toast('[data-act="rec-add"]'), '1명에게 기록했어요');
  assert.equal(await A.text('#toast button'), '되돌리기');
  assert.equal((await balances())['정우진'], before['정우진'] + 3);
  await A.fits('되돌리기 안내');
  await A.page.click('#toast [data-act="undo-last"]');
  await A.page.waitForFunction(() => document.querySelector('#toast > span')?.textContent.startsWith('되돌렸어요'));
  assert.equal(await A.text('#toast > span'), '되돌렸어요 · 작업 내역에서 다시 살릴 수 있어요');
  assert.equal(await A.page.$('#toast button'), null);
  assert.deepEqual(await balances(), before);
  assert.ok((await one(`select dropped from ops where summary like '기록: 되돌리기 연습%'`)).dropped, '작업 내역에는 "이 작업만 되돌림"으로 남는다');
  assert.equal((await one(`select count(*)::int as n from ops where summary like '%되돌%' and summary not like '기록: 되돌리기 연습%'`)).n, 0, '되돌리기 자체는 기록이 없다');
  // 수정·무효 처리 안내에도 되돌리기가 붙는다
  await A.click('#rec-list .rec-row:has-text("소치 실습") [data-act="edit"]');
  await A.page.fill('#ed-detail', '임시');
  await A.page.fill('#ed-reason', '연습');
  assert.equal(await A.toast('[data-act="edit-save"]'), '수정했어요 · 이력에 남았어요');
  await A.page.click('#toast [data-act="undo-last"]');
  await A.page.waitForFunction(() => document.querySelector('#toast > span')?.textContent.startsWith('되돌렸어요'));
  assert.equal((await one(`select detail from ledger where item = '소치 실습'`)).detail, '', '수정도 되돌아간다');
  assert.equal((await one(`select count(*)::int as n from ledger_revisions`)).n, 1, '수정 이력도 함께 사라진다');
});

test('학생 상세(부총대): 수정 이력 펼치기, 무효 표시, 기록자 표시, 기록 탭으로 이동', async () => {
  await A.tab('board');
  await A.click('#board-grid .tile:has(.no:text-is("1"))');
  const v = await A.text();
  assert.match(v, /1번/);
  assert.match(v, /김민서/);
  assert.match(v, /무효 · 착오/);
  assert.match(v, /기록: 부총대/);
  assert.match(v, /관리자에게만 보임/);
  await A.click('[data-act="rev"]');
  const rev = await A.text('.rev');
  assert.match(rev, /사유: 오기/);
  assert.match(rev, /점수/);
  await A.fits('학생 상세');
  await A.click('[data-act="to-record"]');
  assert.equal(await A.page.inputValue('#recFilter'), '1');
  await A.page.fill('#recFilter', '');
  await A.tab('board');
  await A.click('#board-grid .tile:has(.no:text-is("2"))');
  await A.click('[data-act="back"]');
  assert.ok(await A.page.$('#board-grid'));
});

// ───────── 출석 (부총대) ─────────
test('출석(부총대): 아침 출석 체크·저장, 정정, 전원 출석 확인, 한눈에 보기, 교시 추가, 날짜 바꾸기', async () => {
  await A.tab('attend');
  const seg = () => A.page.$$eval('[data-act="pick-period"]', (b) => b.map((x) => x.textContent));
  assert.deepEqual(await seg(), ['아침 출석']);
  const set = async (name, v) => A.click(`[data-act="setst"][data-sid="${await sid(name)}"][data-v="${v}"]`);
  await set('이도윤', 'late');
  await set('박하준', 'absent');
  await set('최서연', 'excused');
  let foot = await A.text('.att-foot');
  assert.match(foot, /지각 1 · 결석 1 · 공결 1/);
  assert.match(foot, /아직 저장 안 됨/);
  await A.fits('출석 체크');
  assert.equal(await A.toast('[data-act="att-save"]'), '저장했어요 · 새 기록 2건');
  assert.deepEqual(await seg(), ['아침 출석 ·저장됨']);
  assert.match(await A.text('.att-foot'), /저장됨/);
  // 박하준은 기록 탭의 +2(실습 준비 미흡)에 결석 +2
  assert.deepEqual(await balances(), { 김민서: 3, 이도윤: 0, 박하준: 4, 최서연: 2, 정우진: 0, 한지우: 0, 서지호: 0 });
  // 같은 출결을 다른 순서로 다시 고르면 여전히 "저장됨" (학생 순서는 상관없다)
  const mp = (await one(`select id from periods where date = $1 and morning`, [TODAY])).id;
  const saved = (await one(`select json_object_agg(student_id, status) as a from attendance where period_id = $1`, [mp])).a;
  for (const k of Object.keys(saved).reverse()) {
    await A.click(`[data-act="setst"][data-sid="${k}"][data-v="present"]`);
    await A.click(`[data-act="setst"][data-sid="${k}"][data-v="${saved[k]}"]`);
  }
  assert.match(await A.text('.att-foot'), /저장됨/);
  // 정정: 이도윤 출석으로 → 변경 사항 있음
  await set('이도윤', 'present');
  assert.match(await A.text('.att-foot'), /변경 사항 있음/);
  // 전원 출석으로 되돌리기: 확인 → 그만두기 / 확인 → 네
  await A.click('[data-act="att-clear"]');
  assert.match(await A.text('.att-confirm'), /지각 0명 · 결석 1명 · 공결 1명이 모두 출석으로 바뀌어요/);
  await A.click('[data-act="att-clear-no"]');
  assert.equal(await A.page.$('.att-confirm'), null);
  await A.click('[data-act="att-clear"]');
  assert.equal(await A.toast('[data-act="att-clear-yes"]'), '전원 출석으로 되돌렸어요 · 저장해야 반영돼요');
  assert.match(await A.text('.att-foot'), /지각 0 · 결석 0 · 공결 0/);
  await set('박하준', 'absent');
  assert.equal(await A.toast('[data-act="att-save"]'), '저장했어요 · 새 기록 0건');
  assert.equal((await one(`select void_reason from ledger l join students s on s.id = l.student_id where s.name = '이도윤' and l.item = '지각'`)).void_reason, '출석 정정');
  assert.equal((await balances())['박하준'], 4, '결석은 그대로라 새 기록 없음');
  // 한눈에 보기: 누를 때마다 출석 → 지각 → 결석 → 공결 → 출석
  await A.click('[data-act="attview"][data-v="grid"]');
  const tile = `.att [data-act="cyc"][data-sid="${await sid('정우진')}"]`;
  const cls = () => A.page.$eval(tile, (b) => b.className);
  for (const want of ['late', 'absent', 'excused', 'present']) {
    await A.click(tile);
    assert.equal(await cls(), want);
  }
  await A.fits('한눈에 보기');
  await A.click('[data-act="attview"][data-v="list"]');
  // 교시 추가
  assert.equal(await A.toast('[data-act="add-period"]'), '교시 이름을 입력하세요');
  await A.page.fill('#newPeriod', '1교시 구강해부학');
  assert.equal(await A.toast('[data-act="add-period"]'), '교시를 추가했어요');
  assert.deepEqual(await seg(), ['아침 출석 ·저장됨', '1교시 구강해부학']);
  assert.match(await A.text('[data-act="pick-period"].on'), /1교시 구강해부학/);
  await A.click('[data-act="pick-period"]:has-text("아침 출석")');
  assert.match(await A.text('[data-act="pick-period"].on'), /아침 출석/);
  // 다른 날짜에는 아직 저장 안 된 아침 출석만
  await A.page.fill('#attDate', '2026-01-05');
  assert.deepEqual(await seg(), ['아침 출석']);
  await A.page.fill('#attDate', TODAY);
  assert.equal(await A.page.inputValue('#attDate'), TODAY);
});

// ───────── 입력 추천 ─────────
const sugChips = (u) => u.page.$$eval('#sugbox button', (b) => b.map((x) => x.textContent));
test('입력 추천(부총대): 항목명은 점수와 함께, 세부내용은 같은 항목에서, 교시는 같은 요일, 수정·무효 사유', async () => {
  await A.tab('record');
  await A.page.click('#recForm-item');
  let c = await sugChips(A);
  assert.match(await A.text('#sugbox'), /^최근/);
  assert.deepEqual(c.slice(0, 2), ['소치 실습 +1.5', '실습 준비 미흡 +2'], '최근에 적은 것부터');
  await A.fits('항목 추천');
  await A.click('#sugbox button:has-text("소치 실습")');
  assert.equal(await A.page.inputValue('#recForm-item'), '소치 실습');
  assert.equal(await A.page.inputValue('#recForm-points'), '1.5', '점수도 함께 들어간다');
  // 화면을 다시 그려도 그대로 (보이는 칸만이 아니라 저장에 쓰는 값도 바뀌었는지)
  await A.click('[data-act="pickgrid"]');
  await A.click('[data-act="pickgrid"]');
  assert.equal(await A.page.inputValue('#recForm-item'), '소치 실습');
  assert.equal(await A.page.inputValue('#recForm-points'), '1.5');
  assert.equal(await A.page.$('#sugbox'), null, '고르면 닫힌다');
  // 치는 중이면 그 글자가 들어간 것만
  await A.page.fill('#recForm-item', '');
  await A.page.type('#recForm-item', '미흡');
  assert.deepEqual(await sugChips(A), ['실습 준비 미흡 +2']);
  await A.click('#sugbox button');
  assert.equal(await A.page.inputValue('#recForm-points'), '2');
  // 세부내용: 같은 항목에서 쓴 것
  await A.page.click('#recForm-detail');
  assert.deepEqual(await sugChips(A), ['전원 안끔']);
  await A.click('#sugbox button');
  assert.equal(await A.page.inputValue('#recForm-detail'), '전원 안끔');
  // Esc로 닫고, 칸을 다시 누르면 다시 열린다
  await A.page.fill('#recForm-detail', '');
  assert.ok(await A.page.$('#sugbox'));
  await A.page.keyboard.press('Escape');
  assert.equal(await A.page.$('#sugbox'), null);
  await A.page.click('#recForm-detail');
  assert.ok(await A.page.$('#sugbox'));
  await A.page.click('h1');
  assert.equal(await A.page.$('#sugbox'), null, '칸을 떠나면 닫힌다');
  await A.page.fill('#recForm-item', '');
  await A.page.fill('#recForm-points', '1');
  // 수정·무효 사유: 지난 사유
  await A.click('#rec-list .rec-row:has-text("소치 실습") [data-act="edit"]');
  await A.page.click('#ed-reason');
  assert.deepEqual(await sugChips(A), ['오기']);
  await A.click('#sugbox button');
  assert.equal(await A.page.inputValue('#ed-reason'), '오기');
  await A.click('[data-act="edit-cancel"]');
  await A.click('#rec-list .rec-row:has-text("소치 실습") [data-act="void"]');
  await A.page.click('#vd-reason');
  assert.deepEqual(await sugChips(A), ['착오']);
  await A.click('[data-act="edit-cancel"]');
  // 교시: 다음 주 같은 요일에는 오늘 만든 교시를 먼저, 이미 있는 교시는 빼고
  await A.tab('attend');
  const next = new Date(Date.parse(TODAY) + 7 * 864e5).toISOString().slice(0, 10);
  await A.page.fill('#attDate', next);
  await A.page.click('#newPeriod');
  assert.match(await A.text('#sugbox'), /^같은 요일/);
  assert.deepEqual(await sugChips(A), ['1교시 구강해부학']);
  await A.click('#sugbox button');
  assert.equal(await A.page.inputValue('#newPeriod'), '1교시 구강해부학');
  await A.page.fill('#newPeriod', '');
  await A.page.fill('#attDate', TODAY);
  await A.page.click('#newPeriod');
  assert.equal(await A.page.$('#sugbox'), null, '오늘은 이미 있는 교시라 추천할 것이 없다');
  await A.page.click('h1');
});

// ───────── 공지·내보내기 ─────────
test('공지: 문구 만들기·고치기·복사, 기간 버튼', async () => {
  await A.tab('notice');
  await A.fits('공지 탭');
  const text = await A.page.inputValue('#notice-text');
  assert.ok(text.startsWith(`😿 ${md(TODAY)} 자봉, 상점 공지하겠습니다.`), text);
  assert.match(text, /결석: 3\(\+2\)/);
  assert.match(text, /소치 실습: 4 \(\+1\.5\)/);
  assert.doesNotMatch(text, /실습 준비 미흡: 1/, '무효 처리한 기록은 공지에 없다');
  assert.equal(await A.toast('[data-act="copy"]'), '복사했어요. 카톡 공지방에 붙여넣으세요');
  assert.equal(await A.clipboard(), text);
  await A.page.fill('#notice-text', text + '\n추가 안내');
  await A.toast('[data-act="copy"]');
  assert.match(await A.clipboard(), /추가 안내$/);
  await A.click('[data-act="notice-preset"][data-v="week"]');
  assert.equal(await A.page.inputValue('#nf'), new Date(Date.parse(TODAY) - 6 * 864e5).toISOString().slice(0, 10));
  await A.click('[data-act="notice-preset"][data-v="one"]');
  assert.equal(await A.page.inputValue('#nf'), TODAY);
  await A.page.fill('#nf', '2026-01-01');
  await A.page.fill('#nt', '2026-01-02');
  await A.click('[data-act="notice-gen"]');
  assert.equal(await A.page.inputValue('#notice-text'), '해당 기간에 기록이 없어요.');
});

test('내보내기: 엑셀 파일(이름·요청자 없음, 시트 3개), 기간 고르기', async () => {
  await A.click('[data-act="exp-range"][data-v="custom"]');
  assert.ok(await A.page.$('#exp-from'));
  await A.click('[data-act="exp-range"][data-v="all"]');
  assert.equal(await A.page.$('#exp-from'), null);
  const file = await A.download('[data-act="exp-make"]');
  assert.equal((await A.downloads()).at(-1), '25학번_자봉_전체.xlsx');
  const buf = fs.readFileSync(file);
  assert.equal(buf.toString('latin1', 0, 2), 'PK');
  const x = unzip(buf);
  const all = Object.values(x).join('\n');
  assert.match(x['xl/workbook.xml'], /요약/);
  assert.match(x['xl/workbook.xml'], /날짜별 내역/);
  assert.match(x['xl/workbook.xml'], /수정 이력/);
  assert.match(all, /소치 실습/);
  assert.match(all, /오기/, '수정 이력 사유');
  for (const name of ['김민서', '이도윤', '박하준', '부총대']) assert.doesNotMatch(all, new RegExp(name), `엑셀에 ${name}이(가) 없어야 한다`);
});

// ───────── 총대단 (학습부장) ─────────
test('총대단 로그인: 탭, 비밀번호 바꾸기(검사·성공·다시 로그인)', async () => {
  O = await open();
  await O.click('#roles [data-role="officer"]');
  assert.deepEqual(await O.page.$$eval('#login-who option', (o) => o.map((x) => x.textContent)), ['총대', '실습부장 1', '실습부장 2', '운영부장', '총무', '학습부장', '정리부장', '치아부장']);
  await O.login('총대단', '학습부장', '1234');
  assert.deepEqual(await O.tabs(), ['요청하기', '요청 현황', '현황판']);
  await O.fits('요청하기');
  await O.click('[data-act="pw-open"]');
  await O.page.fill('#pw-cur', '1234');
  await O.page.fill('#pw-new', '5678');
  await O.page.fill('#pw-new2', '5679');
  assert.equal(await O.toast('[data-act="pw-change"]'), '새 비밀번호 두 칸이 달라요');
  await O.page.fill('#pw-cur', '0000');
  await O.page.fill('#pw-new2', '5678');
  assert.equal(await O.toast('[data-act="pw-change"]'), '현재 비밀번호가 맞지 않아요');
  await O.page.fill('#pw-cur', '1234');
  assert.equal(await O.toast('[data-act="pw-change"]'), '내 비밀번호를 바꿨어요');
  assert.equal(await O.page.$('#pw-cur'), null);
  pw.학습부장 = '5678';
  assert.equal(await O.toast('[data-act="logout"]'), '로그아웃했어요');
  assert.deepEqual(await O.tabs(), ['현황판', '공결 신청']);
  await O.login('총대단', '학습부장', '5678');
  assert.deepEqual(await O.tabs(), ['요청하기', '요청 현황', '현황판']);
});

test('총대단: 항목명 칸의 불러오기 — "추가"를 누르면 그 자리에서 항목명·점수 입력(검사·Enter·취소), 고르기, 빼기, 바깥 누르면 닫힘', async () => {
  const pop = '#reqForm-prpop';
  await O.page.fill('#reqForm-item', '적던 항목');
  await O.click('[data-act="pr-open"][data-fk="reqForm"]');
  assert.match(await O.text(pop), /아직 없어요/);
  assert.equal(await O.page.$('#reqForm-prname'), null);
  await O.click(`${pop} [data-act="pr-add"]`);
  assert.equal(await O.page.evaluate(() => document.activeElement.id), 'reqForm-prname', '추가를 누르면 항목명 칸으로 바로');
  assert.equal(await O.page.inputValue('#reqForm-prname'), '');
  assert.equal(await O.page.inputValue('#reqForm-prpts'), '1');
  await O.fits('불러오기 새 항목 입력');
  assert.equal(await O.toast(`${pop} [data-act="pr-save"]`), '항목명을 적어 주세요');
  await O.page.fill('#reqForm-prname', '청소 불참');
  await O.page.fill('#reqForm-prpts', '1.5');
  assert.equal(await O.toast(`${pop} [data-act="pr-save"]`), '자주 쓰는 항목 점수는 0이 아닌 정수여야 해요');
  await O.page.fill('#reqForm-prpts', '2');
  await O.page.evaluate(() => (document.getElementById('toast').hidden = true));
  await O.page.press('#reqForm-prpts', 'Enter');
  await O.page.waitForFunction(() => document.querySelector('#toast > span')?.textContent.startsWith('자주 쓰는 항목에 넣었어요'));
  assert.equal(await O.text('#toast > span'), '자주 쓰는 항목에 넣었어요: 청소 불참 +2');
  assert.ok(await O.page.isVisible(pop), '넣은 뒤에도 창이 열려 있다');
  assert.equal(await O.page.$('#reqForm-prname'), null, '입력칸은 닫히고 목록에 들어간다');
  assert.equal(await O.page.inputValue('#reqForm-item'), '적던 항목', '적던 항목명은 그대로');
  await O.click(`${pop} [data-act="pr-add"]`);
  await O.page.fill('#reqForm-prname', '청소 불참');
  await O.page.fill('#reqForm-prpts', '2');
  assert.equal(await O.toast(`${pop} [data-act="pr-save"]`), '이미 있는 항목이에요');
  await O.click(`${pop} [data-act="pr-cancel"]`);
  assert.equal(await O.page.$('#reqForm-prname'), null);
  await O.click(`${pop} [data-act="pr-add"]`);
  await O.page.fill('#reqForm-prname', '임시');
  await O.page.fill('#reqForm-prpts', '-1');
  await O.toast(`${pop} [data-act="pr-save"]`);
  assert.deepEqual(await O.page.$$eval(`${pop} .pr-use`, (b) => b.map((x) => x.textContent)), ['청소 불참 +2', '임시 -1']);
  assert.equal(await O.toast(`${pop} .pr-row:has-text("임시") [data-act="pr-del"]`), '자주 쓰는 항목에서 뺐어요: 임시');
  assert.deepEqual(await O.page.$$eval(`${pop} .pr-use`, (b) => b.map((x) => x.textContent)), ['청소 불참 +2']);
  await O.page.click('h1');
  assert.ok(await O.page.isHidden(pop), '바깥을 누르면 닫힌다');
  assert.equal((await one(`select count(*)::int as n from presets where owner = '학습부장'`)).n, 1);
  assert.equal((await one(`select count(*)::int as n from presets where owner = '부총대'`)).n, 6, '다른 직책 항목은 그대로');
  await O.page.fill('#reqForm-item', '');
  // 날짜는 왼쪽, 점수는 오른쪽
  const x = async (sel) => (await O.page.$eval(sel, (el) => el.getBoundingClientRect().left));
  assert.ok((await x('#reqForm-date')) < (await x('#reqForm-points')));
});

test('총대단: 사진 붙인 요청, 숫자판으로 상점 요청, 요청 현황, 현황판 이름', async () => {
  await O.click('[data-act="pr-open"][data-fk="reqForm"]');
  await O.click('#reqForm-prpop .pr-use:has-text("청소 불참")');
  assert.equal(await O.page.inputValue('#reqForm-item'), '청소 불참');
  assert.equal(await O.page.inputValue('#reqForm-points'), '2');
  await O.page.fill('#reqForm-find', '최서');
  await O.click('#reqForm-sugg [data-act="pick"]');
  await O.page.type('#reqForm-find', '9 ');
  await O.page.fill('#reqForm-reason', '청소 시간에 없음');
  await O.page.setInputFiles('[data-photo="reqForm"]', { name: 'a.png', mimeType: 'image/png', buffer: PNG });
  await O.page.waitForSelector('img.thumb');
  await O.fits('요청 사진 첨부');
  assert.equal(await O.toast('[data-act="req-add"]'), '요청을 보냈어요');
  assert.equal(await O.page.$('#toast button'), null, '총대단 안내에는 되돌리기가 없다 (작업 내역은 부총대만)');
  assert.equal(await O.page.$('img.thumb'), null);
  // 요청 사유: 내가 쓴 지난 사유
  await O.page.click('#reqForm-reason');
  assert.deepEqual(await sugChips(O), ['청소 시간에 없음']);
  await O.page.keyboard.press('Escape');
  assert.equal(await O.page.inputValue('#reqForm-reason'), '');
  // 항목명: 총대단은 내가 요청한 것이 최근
  await O.page.click('#reqForm-item');
  assert.equal((await sugChips(O))[0], '청소 불참 +2');
  await O.page.fill('#reqForm-item', '매점 도움');
  await O.click('[data-act="pts-open"][data-fk="reqForm"]');
  await O.click('#reqForm-ptspop [data-v="-1"]');
  await O.page.type('#reqForm-find', '1 ');
  assert.equal(await O.toast('[data-act="req-add"]'), '요청을 보냈어요');
  const r = await q(`select item, points::float, requested_by, photo_id is not null as photo, reason, status from requests order by created_at`);
  assert.deepEqual(r, [
    { item: '청소 불참', points: 2, requested_by: '학습부장', photo: true, reason: '청소 시간에 없음', status: 'pending' },
    { item: '매점 도움', points: -1, requested_by: '학습부장', photo: false, reason: '', status: 'pending' },
  ]);
  assert.ok((await one(`select length(data) as n from photos`)).n > 100, '사진은 JPEG로 줄여 저장');
  assert.match((await one(`select data from photos`)).data, /^data:image\/jpeg;base64,/);
  await O.tab('reqs');
  const v = await O.text();
  assert.equal((v.match(/대기/g) || []).length, 2);
  assert.match(v, /학습부장/);
  assert.match(v, /4 최서연/);
  await O.fits('요청 현황');
  await O.tab('board');
  assert.match(await O.text('#board-grid'), /김민서/);
  // 총대단은 출석 탭이 없다
  assert.equal(await O.page.$('#tabs [data-tab="attend"]'), null);
});

// ───────── 출석 권한 총대단 (총대) ─────────
test('총대: 출석 탭(아침 출석 없음), 교시 추가, 출석 요청·다시 보내기', async () => {
  C = await open();
  await C.login('총대단', '총대', '1234');
  assert.deepEqual(await C.tabs(), ['출석', '요청하기', '요청 현황', '현황판']);
  // 부총대가 오늘 만든 교시는 보이지만 아침 출석은 없다
  assert.deepEqual(await C.page.$$eval('[data-act="pick-period"]', (b) => b.map((x) => x.textContent)), ['1교시 구강해부학']);
  await C.page.fill('#attDate', '2026-01-06');
  assert.match(await C.text(), /위에서 교시를 추가한 뒤 출석을 체크하세요/);
  assert.equal(await C.page.$('[data-act="pick-period"]'), null, '총대단 화면에는 아침 출석이 없다');
  await C.page.fill('#attDate', TODAY);
  await C.page.fill('#newPeriod', '2교시 생리학');
  assert.equal(await C.toast('[data-act="add-period"]'), '교시를 추가했어요');
  await C.click(`[data-act="setst"][data-sid="${await sid('김민서')}"][data-v="late"]`);
  await C.click(`[data-act="setst"][data-sid="${await sid('서지호')}"][data-v="absent"]`);
  assert.equal(await C.page.$('[data-act="att-save"]'), null, '총대단은 저장 대신 요청');
  assert.equal(await C.toast('[data-act="att-request"]'), '출석 요청을 보냈어요 · 부총대 확인을 기다려요');
  assert.match(await C.text('.att-foot'), /요청 보냄 · 부총대 확인 대기 중/);
  assert.equal(await C.text('[data-act="att-request"]'), '요청 다시 보내기');
  await C.click(`[data-act="setst"][data-sid="${await sid('정우진')}"][data-v="late"]`);
  await C.toast('[data-act="att-request"]');
  assert.equal((await one(`select count(*)::int as n from attendance_requests`)).n, 1, '다시 보내면 같은 요청이 바뀐다');
  assert.equal((await one(`select count(*)::int as n from ledger where period_id is not null and date = $1 and item = '지각' and voided_at is null`, [TODAY])).n, 0, '요청만으로는 기록 없음');
  await C.fits('총대 출석');
});

// ───────── 요청함 (부총대) ─────────
test('요청함: 알림 숫자, 출석 요청 승인, 사진 보기, 요청 승인·반려(사유 필수), 처리한 내역', async () => {
  await A.reload();
  assert.equal(await A.text('#tabs [data-tab="inbox"] .badge'), '3');
  await A.tab('inbox');
  await A.fits('요청함');
  const v = await A.text();
  assert.match(v, /출석 요청 1건 · 총대단 요청 2건 · 공결 신청 0건/);
  assert.match(v, /지각 2명/);
  assert.match(v, /결석 1명/);
  assert.match(await A.toast('[data-act="att-ok"]'), /^출석을 저장했어요 · 새 기록 3건$/);
  const reqCard = (item) => `.card:has(.req-body:has-text("${item}"))`;
  await A.click(`${reqCard('청소 불참')} [data-act="photo"]`);
  assert.match(await A.page.getAttribute(`${reqCard('청소 불참')} img.photo-big`, 'src'), /^data:image\/jpeg/);
  assert.equal(await A.toast(`${reqCard('청소 불참')} [data-act="req-ok"]`), '승인했어요 · 2명 반영');
  assert.equal(await A.toast(`${reqCard('매점 도움')} [data-act="req-no"]`), '반려 사유를 입력하세요');
  const id = await A.page.getAttribute(`${reqCard('매점 도움')} [data-act="req-no"]`, 'data-id');
  await A.page.fill(`#note-${id}`, '중복');
  assert.equal(await A.toast(`${reqCard('매점 도움')} [data-act="req-no"]`), '반려했어요');
  assert.equal(await A.page.$('#tabs [data-tab="inbox"] .badge'), null);
  const done = await A.text();
  assert.match(done, /총대단 요청 승인/);
  assert.match(done, /총대단 요청 반려/);
  assert.match(done, /반려 사유: 중복/);
  assert.match(done, /출석 승인/);
  // 이도윤은 아침 지각이 출석 정정으로 무효가 되어 -1
  assert.deepEqual(await balances(), { 김민서: 4, 이도윤: -1, 박하준: 4, 최서연: 4, 정우진: 1, 한지우: 2, 서지호: 2 });
  const lp = await one(`select lp.requested_by, lp.approved_by from ledger l join ledger_private lp on lp.ledger_id = l.id where l.item = '청소 불참' limit 1`);
  assert.deepEqual(lp, { requested_by: '학습부장', approved_by: '부총대' });
  // 요청자 화면: 새로 불러오면 처리 결과가 보인다
  await O.reload();
  await O.tab('reqs');
  const ov = await O.text();
  assert.match(ov, /승인/);
  assert.match(ov, /부총대: 중복/);
  await C.reload();
  await C.click('[data-act="pick-period"]:has-text("2교시 생리학")');
  assert.match(await C.text('.att-foot'), /부총대가 저장한 교시예요/);
});

// ───────── 학생: 현황판·상세·공결 신청 ─────────
test('학생 현황판: 번호만(이름 없음), 번호 검색, 상세(수정 이력 공개, 기록자 비공개)', async () => {
  await S.reload();
  const v = await S.text();
  for (const name of ['김민서', '이도윤', '서지호']) assert.doesNotMatch(v, new RegExp(name));
  assert.equal(await S.page.getAttribute('#q', 'inputmode'), 'numeric');
  await S.page.fill('#q', '1');
  assert.deepEqual(await S.page.$$eval('#board-grid .tile .no', (t) => t.map((x) => x.textContent)), ['1']);
  await S.page.fill('#q', '김');
  assert.match(await S.text('#board-grid'), /찾는 학생이 없어요/, '학생 화면은 이름으로 못 찾는다');
  await S.page.fill('#q', '');
  await S.click('#board-grid .tile:has(.no:text-is("1"))');
  const d = await S.text();
  assert.match(d, /수정됨 1회/);
  assert.doesNotMatch(d, /김민서|부총대|학습부장|관리자에게만/);
  await S.click('[data-act="rev"]');
  assert.match(await S.text('.rev'), /사유: 오기/);
  await S.fits('학생 상세');
  await S.click('[data-act="to-excuse"]');
  assert.equal(await S.page.inputValue('#exc-no'), '1');
});

test('학생 공결 신청: 번호 검사, 대상 목록, 사진, 신청 내역', async () => {
  await S.page.fill('#exc-no', '99');
  assert.match(await S.text(), /없는 번호예요/);
  await S.page.fill('#exc-no', '8');
  assert.match(await S.text(), /1교시.*지각|지각/);
  await S.page.fill('#exc-no', '9');
  assert.match(await S.text(), /공결 신청할 지각·결석 기록이 없어요/);
  await S.page.fill('#exc-no', '3');
  assert.equal(await S.toast('[data-act="exc-add"]'), '공결 처리할 출결을 고르세요');
  const opts = await S.page.$$eval('#exc-eid option', (o) => o.map((x) => x.textContent));
  assert.equal(opts.length, 2);
  assert.match(opts[1], /아침 출석 결석 \+2/);
  await S.page.selectOption('#exc-eid', { index: 1 });
  await S.page.fill('#exc-reason', '병원 진료');
  await S.page.setInputFiles('[data-photo="excForm"]', { name: 'b.png', mimeType: 'image/png', buffer: BIG });
  await S.page.waitForSelector('img.thumb');
  await S.fits('큰 사진 미리보기');
  assert.equal(await S.toast('[data-act="exc-add"]'), '신청했어요 · 부총대 확인을 기다려요');
  const ph = (await one(`select p.data from photos p join excuses x on x.photo_id = p.id`)).data;
  assert.deepEqual(jpegSize(ph), [720, 540], '1600×1200 사진은 긴 변 720px JPEG로 줄여 저장');
  assert.ok(ph.length < 400000, '서버 한도(400KB) 안');
  assert.match(await S.text(), /3번 신청 내역/);
  assert.match(await S.text(), /대기/);
  assert.match(await S.text(), /공결 신청할 지각·결석 기록이 없어요/, '대기 중인 기록은 다시 고를 수 없다');
  await S.page.fill('#exc-no', '1');
  await S.page.selectOption('#exc-eid', { index: 1 });
  assert.equal(await S.toast('[data-act="exc-add"]'), '신청했어요 · 부총대 확인을 기다려요');
  await S.fits('공결 신청');
  assert.equal((await one(`select count(*)::int as n from excuses where status = 'pending'`)).n, 2);
});

test('요청함: 공결 증빙 보기, 승인(출결이 공결로), 반려(사유)', async () => {
  await A.reload();
  await A.tab('inbox');
  assert.match(await A.text(), /공결 신청 2건/);
  const card = (no) => `.card:has(.req-body b:text-matches("^${no}번"))`;
  assert.match(await A.text(card(3)), /사유: 병원 진료/);
  await A.click(`${card(3)} [data-act="photo"]`);
  assert.ok(await A.page.$(`${card(3)} img.photo-big`));
  assert.match(await A.text(card(1)), /증빙 사진 없음/);
  assert.equal(await A.toast(`${card(3)} [data-act="exc-ok"]`), '공결을 승인했어요 · 해당 자봉이 무효 처리됐어요');
  const id = await A.page.getAttribute(`${card(1)} [data-act="exc-no"]`, 'data-id');
  await A.page.click(`#note-${id}`);
  assert.ok((await sugChips(A)).includes('중복'), '반려 사유도 지난 사유를 추천');
  await A.page.fill(`#note-${id}`, '증빙 필요');
  assert.equal(await A.toast(`${card(1)} [data-act="exc-no"]`), '반려했어요');
  assert.equal((await balances())['박하준'], 2, '결석 +2만 무효');
  await A.tab('attend');
  // 출석 탭은 아직 저장 안 한 교시를 먼저 보여 주므로 아침 출석을 고른다
  await A.click('[data-act="pick-period"]:has-text("아침 출석")');
  assert.ok(await A.page.$(`.call.excused:has(.no:text-is("3"))`), '공결 승인하면 출석 화면에서도 공결');
  await S.reload();
  await S.tab('excuse');
  await S.page.fill('#exc-no', '1');
  assert.match(await S.text(), /반려 사유: 증빙 필요/);
  await S.page.fill('#exc-no', '3');
  assert.match(await S.text(), /승인/);
});

// ───────── 학생 "내 번호" ─────────
test('학생 "내 번호": 정하기(없는 번호 안내), 내 카드·칸 강조, 새로고침해도 기억, 공결 신청에 미리, 상세에서 정하기, 바꾸기', async () => {
  await S.tab('board');
  assert.ok(await S.page.$('.mycard #myno'));
  await S.page.fill('#myno', '99');
  assert.equal(await S.toast('[data-act="myno-set"]'), '없는 번호예요');
  await S.page.fill('#myno', '3');
  assert.equal(await S.toast('[data-act="myno-set"]'), '3번을 내 번호로 정했어요 · 이 폰에만 기억해요');
  const card = await S.text('.mycard');
  assert.match(card, /내 번호 3/);
  assert.match(card, new RegExp(`자봉 ${(await balances())['박하준']}`));
  assert.match(card, /결석 · 무효/, '최근 기록 (공결 승인된 결석은 무효로)');
  assert.equal(await S.page.$$eval('#board-grid .tile.me', (t) => t.map((x) => x.querySelector('.no').textContent).join()), '3');
  await S.fits('내 번호 카드');
  await S.reload();
  assert.match(await S.text('.mycard'), /내 번호 3/, '새로고침해도 기억');
  await S.tab('excuse');
  assert.equal(await S.page.inputValue('#exc-no'), '3', '공결 신청에 번호가 미리 들어간다');
  await S.tab('board');
  await S.click('.mycard [data-act="open"]');
  assert.match(await S.text(), /3번/);
  await S.click('[data-act="back"]');
  await S.click('.mycard [data-act="myno-clear"]');
  assert.ok(await S.page.$('#myno'));
  assert.equal(await S.page.$('#board-grid .tile.me'), null);
  await S.click('#board-grid .tile:has(.no:text-is("4"))');
  assert.equal(await S.toast('[data-act="myno-set"]'), '4번을 내 번호로 정했어요 · 이 폰에만 기억해요');
  assert.match(await S.text('.mycard'), /내 번호 4/);
  assert.equal(await S.page.evaluate(() => localStorage.getItem('jabong-myno')), '4');
  await A.tab('board');
  assert.equal(await A.page.$('.mycard'), null, '부총대 현황판에는 내 번호 카드가 없다');
  await S.click('.mycard [data-act="myno-clear"]');
});

// ───────── 출석 요청: 저장된 교시·같은 교시 경고, 반려 안내 ─────────
test('출석 요청: 이미 저장된 교시·같은 교시 두 요청 경고, 반려 사유 필수, 요청자에게 반려 안내', async () => {
  const before = await balances();
  await C.reload();
  await C.click('[data-act="pick-period"]:has-text("2교시 생리학")');
  await C.click(`[data-act="setst"][data-sid="${await sid('한지우')}"][data-v="late"]`);
  await C.toast('[data-act="att-request"]');
  const P1 = await open();
  await P1.login('총대단', '실습부장 1', '1234');
  assert.deepEqual(await P1.tabs(), ['출석', '요청하기', '요청 현황', '현황판']);
  await P1.click('[data-act="pick-period"]:has-text("2교시 생리학")');
  assert.match(await P1.text('.att-foot'), /부총대가 저장한 교시예요/);
  await P1.click(`[data-act="setst"][data-sid="${await sid('이도윤')}"][data-v="absent"]`);
  await P1.toast('[data-act="att-request"]');
  await A.reload();
  await A.tab('attend');
  await A.click('[data-act="pick-period"]:has-text("2교시 생리학")');
  assert.match(await A.text(), /이 교시에 (총대, 실습부장 1|실습부장 1, 총대)의 출석 요청이 있어요/);
  await A.tab('inbox');
  const card = (by) => `.card:has(.pill:text-is("출석 대기")):has(.note:text-matches("^${by} ·"))`;
  assert.match(await A.text(card('총대')), /이미 저장된 교시예요/);
  assert.match(await A.text(card('총대')), /같은 교시에 실습부장 1의 요청도 있어요/);
  assert.match(await A.text(card('실습부장 1')), /같은 교시에 총대의 요청도 있어요/);
  assert.equal(await A.toast(`${card('총대')} [data-act="att-no"]`), '반려 사유를 입력하세요');
  for (const [by, note] of [['총대', '다시 확인'], ['실습부장 1', '중복']]) {
    const id = await A.page.getAttribute(`${card(by)} [data-act="att-no"]`, 'data-id');
    await A.page.fill(`#note-${id}`, note);
    assert.equal(await A.toast(`${card(by)} [data-act="att-no"]`), '반려했어요');
  }
  assert.deepEqual(await balances(), before, '반려하면 점수는 그대로');
  await C.reload();
  await C.click('[data-act="pick-period"]:has-text("2교시 생리학")');
  assert.match(await C.text(), /지난 요청이 반려됐어요: 다시 확인/);
  await P1.page.context().close();
});

// ───────── 보안: 이름·항목에 HTML ─────────
test('HTML이 들어간 이름·항목은 글자로만 보인다', async () => {
  await A.tab('manage');
  await A.page.fill('#roster-text', '10\t<i>홍</i>');
  await A.toast('[data-act="roster-apply"]');
  await A.tab('record');
  await A.page.fill('#recForm-item', '<img src=x onerror="window.__x=1">');
  await A.page.type('#recForm-find', '10 ');
  await A.toast('[data-act="rec-add"]');
  await A.tab('board');
  assert.match(await A.text('#board-grid'), /<i>홍<\/i>/);
  await A.click('#board-grid .tile:has(.no:text-is("10"))');
  assert.match(await A.text(), /<img src=x/);
  await A.tab('notice');
  assert.match(await A.page.inputValue('#notice-text'), /<img src=x/);
  assert.equal(await A.page.evaluate(() => window.__x), undefined);
  assert.equal(await A.page.$('#view i, #view img:not(.photo-big):not(.thumb)'), null);
});

// ───────── 작업 내역 ─────────
test('작업 내역: 뒤로가기·앞으로 가기, 그만두기, 이 작업만 되돌리기·다시 살리기, 맨 처음·이 시점으로, 겹침 안내', async () => {
  const sig = async () => JSON.stringify(await q(`select l.id, l.points, l.voided_at is null as live from ledger l order by l.id`)) + JSON.stringify(await q(`select id, no, active from students order by id`));
  const start = await sig();
  const nops = (await one(`select count(*)::int as n from ops`)).n;
  await A.tab('history');
  await A.fits('작업 내역');
  const rows = () => A.page.$$eval('#view .rec-row', (r) => r.map((x) => x.innerText.split('\n').slice(0, 2).join(' ')));
  let list = await rows();
  assert.equal(list.length, nops + 1, '작업마다 한 줄 + 지금 여기');
  assert.match(list[0], /지금 여기/);
  assert.ok(await A.page.isDisabled('[data-title="앞으로 가기"]'));
  // 뒤로가기 → 그만두기 → 뒤로가기 → 이동
  await A.click('[data-title="뒤로가기"]');
  assert.match(await A.text('.card[style*="warn"]'), /뒤로가기.*되돌릴 작업 1개/s);
  await A.fits('뒤로가기 미리보기');
  await A.click('[data-act="hist-cancel"]');
  assert.equal(await A.page.$('[data-act="hist-run"]'), null);
  await A.click('[data-title="뒤로가기"]');
  assert.equal(await A.toast('[data-act="hist-run"]'), '이동했어요');
  list = await rows();
  assert.match(list[1], /지금 여기/);
  assert.match(await A.text('#view .rec-row >> nth=0'), /뒤로 감/);
  assert.equal((await one(`select count(*)::int as n from ops`)).n, nops, '이동은 작업 내역에 남지 않는다');
  await A.click('[data-title="앞으로 가기"]');
  assert.match(await A.text('.card[style*="warn"]'), /다시 적용할 작업 1개/);
  assert.equal(await A.toast('[data-act="hist-run"]'), '이동했어요');
  assert.equal(await sig(), start);
  // 이 작업만 되돌리기 → 다시 살리기
  const row = (t) => `#view .rec-row:has-text("${t}")`;
  await A.click(`${row('기록: 소치 실습')} [data-act="hist-drop-pv"]`);
  assert.match(await A.text('.card[style*="warn"]'), /4.*최서연.*자봉 4 → 2\.5/s);
  assert.equal(await A.toast('[data-act="hist-run"]'), '되돌렸어요');
  assert.match(await A.text(row('기록: 소치 실습')), /이 작업만 되돌림/);
  assert.equal((await balances())['최서연'], 2.5);
  await A.click(`${row('기록: 소치 실습')} [data-act="hist-drop-pv"][data-restore]`);
  assert.equal(await A.toast('[data-act="hist-run"]'), '다시 살렸어요');
  assert.equal(await sig(), start);
  // 겹치는 작업은 하나만 되돌릴 수 없다고 알려 준다
  assert.match(await A.toast(`${row('명단: 추가 6')} [data-act="hist-drop-pv"]`), /이 작업만 되돌릴 수 없어요/);
  // 맨 처음으로 → 명단이 비고, 맨 위 작업 "이 시점으로" → 원래대로
  await A.click('[data-title="맨 처음으로 이동"]');
  assert.equal(await A.toast('[data-act="hist-run"]'), '이동했어요');
  assert.equal((await one(`select count(*)::int as n from students`)).n, 0);
  list = await rows();
  assert.match(list.at(-1), /지금 여기/);
  await A.click('#view .rec-row >> nth=0 >> [data-act="hist-pv"]');
  assert.equal(await A.toast('[data-act="hist-run"]'), '이동했어요');
  assert.equal(await sig(), start);
  // 50개가 넘으면 "더 보기"
  const tok = await A.token();
  for (let i = 0; i < 50; i++) await db.query(`select my_presets_save($1, (select json_agg(json_build_object('name', name, 'points', points) order by sort) from presets where owner = '부총대')::jsonb)`, [tok]);
  await A.tab('board');
  await A.tab('history');
  assert.equal((await rows()).length, 51);
  await A.click('[data-act="hist-more"]');
  assert.ok((await rows()).length > 51);
});

// ───────── 요청함: 처리한 내역 더 보기 ─────────
test('요청함: 처리한 내역은 20건씩, "더 보기"로 이어서', async () => {
  const at = await A.token();
  const ot = await O.token();
  for (let i = 0; i < 21; i++) {
    const r = await one(`select create_request($1, $2, array[(select id from students where no = 1 and active)], $3, '', 1, '', null) as id`, [ot, TODAY, `묶음 ${i}`]);
    await db.query(`select review_request($1, $2, false, '연습')`, [at, r.id]);
  }
  const n = (await one(`select (select count(*) from requests where status <> 'pending') + (select count(*) from excuses where status <> 'pending')
    + (select count(*) from attendance_requests where status <> 'pending') as n`)).n;
  await A.reload();
  await A.tab('inbox');
  const cards = () => A.page.$$eval('#view h2 ~ .card', (c) => c.filter((x) => /승인|반려/.test(x.querySelector('.pill')?.textContent || '')).length);
  assert.equal(await cards(), 20);
  assert.equal(await A.text('[data-act="done-more"]'), `더 보기 (${n - 20}건 남음)`);
  await A.click('[data-act="done-more"]');
  assert.equal(await cards(), Math.min(40, Number(n)));
});

// ───────── 관리: 비밀번호·복구 코드 ─────────
test('관리: 다른 직책 비밀번호 재설정 → 그 직책은 다음 동작에서 로그아웃', async () => {
  await A.tab('manage');
  await A.page.fill('#pw-cur', '1234');
  await A.page.fill('#pw-new', 'abcd');
  await A.page.fill('#pw-new2', 'abce');
  assert.equal(await A.toast('[data-act="pw-change"]'), '새 비밀번호 두 칸이 달라요');
  assert.ok(!(await A.page.$$eval('#pw-who option', (o) => o.map((x) => x.textContent))).includes('부총대'));
  await A.page.selectOption('#pw-who', '학습부장');
  await A.page.fill('#pw-reset', '12');
  assert.equal(await A.toast('[data-act="pw-reset"]'), '새 비밀번호는 4자 이상이어야 해요');
  await A.page.fill('#pw-reset', 'qwer');
  assert.equal(await A.toast('[data-act="pw-reset"]'), '학습부장 비밀번호를 재설정했어요. 본인에게 알려주세요');
  pw.학습부장 = 'qwer';
  await O.tab('request');
  await O.page.fill('#reqForm-item', '확인');
  await O.page.type('#reqForm-find', '1 ');
  assert.equal(await O.toast('[data-act="req-add"]'), '로그인이 끊겼어요. 다시 로그인해 주세요');
  assert.deepEqual(await O.tabs(), ['현황판', '공결 신청']);
  await O.login('총대단', '학습부장', 'qwer');
});

test('관리: 새 복구 코드 → 복구 코드로 들어가기(소문자·붙여 쓰기) → 새 코드 표시', async () => {
  await A.page.fill('#rc-pw', 'wrong');
  assert.equal(await A.toast('[data-act="rc-new"]'), '내 비밀번호가 맞지 않아요');
  await A.page.fill('#rc-pw', '1234');
  assert.equal(await A.toast('[data-act="rc-new"]'), '새 복구 코드를 만들었어요 · 이전 코드는 더 이상 안 돼요');
  const code = (await A.text('.card:has([data-act="code-ok"]) .mono')).trim();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(await A.toast('[data-act="code-copy"]'), '복사했어요');
  assert.equal(await A.clipboard(), code);
  await A.click('[data-act="code-ok"]');
  assert.equal(await A.page.$('[data-act="code-ok"]'), null);
  await A.toast('[data-act="logout"]');
  await A.click('#roles [data-role="admin"]');
  await A.click('[data-act="recover-open"]');
  await A.page.fill('#rc-code', CODE);
  await A.page.fill('#rc-new', 'zxcv');
  await A.page.fill('#rc-new2', 'zxcv');
  assert.equal(await A.toast('[data-act="recover"]'), '복구 코드가 맞지 않아요', '처음 코드는 새 코드를 만들면서 무효');
  await A.page.fill('#rc-code', code.replace(/-/g, '').toLowerCase());
  await A.page.fill('#rc-new2', 'zxcb');
  assert.equal(await A.toast('[data-act="recover"]'), '새 비밀번호 두 칸이 달라요');
  await A.page.fill('#rc-new2', 'zxcv');
  assert.equal(await A.toast('[data-act="recover"]'), '비밀번호를 새로 정했어요 · 복구 코드가 바뀌었어요');
  pw.부총대 = 'zxcv';
  const code2 = (await A.text('.card:has([data-act="code-ok"]) .mono')).trim();
  assert.notEqual(code2, code);
  assert.deepEqual(await A.tabs(), ['출석', '기록', '요청함', '공지', '작업 내역', '관리', '현황판']);
  await A.click('[data-act="code-ok"]');
  await A.fits('복구 뒤');
});

test('로그인 잠금: 5번 틀리면 10분 잠김 안내', async () => {
  const P = await open();
  await P.click('#roles [data-role="officer"]');
  await P.page.selectOption('#login-who', '정리부장');
  await P.page.fill('#login-pw', 'x');
  for (let i = 0; i < 4; i++) assert.equal(await P.toast('[data-act="login"]'), '비밀번호가 맞지 않아요');
  assert.equal(await P.toast('[data-act="login"]'), '비밀번호가 맞지 않아요');
  await P.page.fill('#login-pw', '1234');
  assert.match(await P.toast('[data-act="login"]'), /^비밀번호를 여러 번 틀려서 잠겼어요\. 10분 뒤에 다시 해보세요$/);
  await P.page.context().close();
});

// ───────── 한 번 탭으로 고르기 (폰, 한글 조합 중) ─────────
test('폰: 한글을 치던 중 추천 이름을 한 번 탭하면 바로 선택된다', async () => {
  const T = await open({ touch: true });
  await T.login('총대단', '학습부장', pw.학습부장);
  const cdp = await T.page.context().newCDPSession(T.page);
  await T.page.tap('#reqForm-find');
  await cdp.send('Input.imeSetComposition', { text: '최', selectionStart: 1, selectionEnd: 1 });
  await T.page.waitForSelector('#reqForm-sugg [data-act="pick"]');
  await T.page.tap('#reqForm-sugg [data-act="pick"]');
  await T.page.waitForTimeout(200);
  assert.deepEqual(await T.page.$$eval('#reqForm-chips .chip', (c) => c.map((x) => x.textContent.replace(' ×', ''))), ['4 최서연']);
  assert.equal(await T.page.inputValue('#reqForm-find'), '');
  await T.page.tap('#reqForm-chips [data-act="unpick"]');
  assert.equal(await T.page.$$eval('#reqForm-chips .chip', (c) => c.length), 0);
  // 항목 추천도 조합 중에 한 번 탭으로 (항목과 점수가 함께)
  await T.page.tap('#reqForm-item');
  await cdp.send('Input.imeSetComposition', { text: '청', selectionStart: 1, selectionEnd: 1 });
  await T.page.waitForSelector('#sugbox button:has-text("청소 불참")');
  await T.page.tap('#sugbox button:has-text("청소 불참")');
  await T.page.waitForTimeout(200);
  assert.equal(await T.page.inputValue('#reqForm-item'), '청소 불참');
  assert.equal(await T.page.inputValue('#reqForm-points'), '2');
  assert.equal(await T.page.$('#sugbox'), null);
  await T.page.context().close();
});

// ───────── 백업 ─────────
test('백업: 받기 → 데이터 바꾸기 → 파일로 되살리기(미리보기·확인 입력·직전 상태 받기), 잘못된 파일, 예전 암호 파일', async () => {
  await A.tab('manage');
  const file = await A.download('[data-act="bk-download"]');
  assert.match((await A.downloads()).at(-1), /^jabong-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
  const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(dump.format, 'jabong-backup');
  assert.equal(dump.tables.students.filter((s) => s.active).length, 8);
  const before = await balances();
  await A.tab('record');
  await A.page.fill('#recForm-item', '망가뜨리기');
  await A.page.fill('#recForm-points', '5');
  await A.page.type('#recForm-find', '1 2 ');
  await A.toast('[data-act="rec-add"]');
  await A.tab('manage');
  await A.page.evaluate(() => (document.getElementById('toast').hidden = true));
  await A.page.setInputFiles('[data-bkfile]', { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"foo":1}') });
  await A.page.waitForSelector('#toast:not([hidden])');
  assert.equal((await A.text('#toast > span')).trim(), '자봉 장부 백업 파일이 아니에요');
  await A.page.setInputFiles('[data-bkfile]', file);
  await A.page.waitForSelector('#bk-typed');
  const pv = await A.text('.card:has(#bk-typed)');
  assert.match(pv, /점수가 달라지는 학생 2명/);
  assert.match(pv, new RegExp(`김민서지금 ${before.김민서 + 5} → ${before.김민서}`));
  assert.ok(await A.page.isDisabled('[data-act="bk-restore"]'));
  await A.page.fill('#bk-typed', '되살리기');
  assert.ok(await A.page.isEnabled('[data-act="bk-restore"]'));
  await A.fits('백업 미리보기');
  const n0 = (await A.downloads()).length;
  assert.match(await A.toast('[data-act="bk-restore"]'), /백업으로 되살렸어요 · 직전 상태 파일도 받아 뒀어요$/);
  assert.match((await A.downloads())[n0], /^jabong-되살리기전-/);
  assert.deepEqual(await balances(), before);
  assert.equal(await A.page.$('#bk-typed'), null);
  // 예전에 암호를 걸어 받은 파일도 열 수 있다
  const enc = await encryptBackup(dump, 'oldpw1');
  await A.page.setInputFiles('[data-bkfile]', { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(enc)) });
  await A.page.waitForSelector('#bk-pw');
  assert.match(await A.text(), /암호를 걸어 둔 파일이에요/);
  await A.page.fill('#bk-pw', 'nope');
  assert.equal(await A.toast('[data-act="bk-open"]'), '백업 암호가 맞지 않아요');
  await A.page.fill('#bk-pw', 'oldpw1');
  await A.click('[data-act="bk-open"]');
  assert.match(await A.text('.card:has(#bk-typed)'), /학생별 자봉 점수는 지금과 같아요/);
  // 작업 내역은 되살리기 한 줄
  await A.tab('history');
  assert.match(await A.text('#view .rec-row >> nth=1'), /백업에서 되살리기/);
  assert.ok(await A.page.isDisabled('[data-title="뒤로가기"]'));
});

// ───────── 보관 후 정리 ─────────
test('보관 후 정리: 전체 파일 먼저, 확인 입력, 점수 그대로, 작업 내역 비움', async () => {
  await A.tab('manage');
  assert.match(await A.text(), /먼저 공지 탭 → 내보내기에서 전체 기간 파일을 만들어야/);
  assert.ok(await A.page.isDisabled('#purge-typed'));
  await A.tab('notice');
  await A.click('[data-act="exp-range"][data-v="all"]');
  await A.download('[data-act="exp-make"]');
  await A.tab('manage');
  assert.match(await A.text(), /전체 기간 파일을 받았어요/);
  await A.page.fill('#purge-cut', TODAY);
  assert.match(await A.text(), /정리 대상: 기록 \d+건 → 이월 \d+건/);
  assert.ok(await A.page.isDisabled('[data-act="purge"]'));
  await A.page.fill('#purge-typed', '정리');
  assert.ok(await A.page.isEnabled('[data-act="purge"]'));
  const before = await balances();
  assert.match(await A.toast('[data-act="purge"]'), /^기록 \d+건을 이월 \d+건으로 정리했어요$/);
  assert.deepEqual(await balances(), before);
  assert.equal((await one(`select count(*)::int as n from ledger where src <> 'carry'`)).n, 0);
  await A.tab('history');
  assert.match(await A.text(), /보관 후 정리/);
  assert.match(await A.text(), /이 너머로는 못 가요/);
  assert.ok(await A.page.isDisabled('[data-title="뒤로가기"]'));
  assert.equal(await A.page.$('[data-title="맨 처음으로 이동"]'), null);
  await A.tab('board');
  await A.click('#board-grid .tile:has(.no:text-is("1"))');
  assert.match(await A.text(), /이월/);
});

// ───────── 다른 기기의 변경 ─────────
test('다른 기기의 변경: 화면으로 돌아오면 새로 불러오고, 입력 중이면 입력이 끝난 뒤 다시 그린다', async () => {
  await O.tab('board');
  const tile = '#board-grid .tile:has(.no:text-is("1")) .pt';
  const b0 = (await balances())['김민서'];
  assert.equal(await O.text(tile), `자봉 ${b0}`);
  const tok = (await one(`select login('부총대', $1)::json ->> 'token' as t`, [pw.부총대])).t;
  await db.query(`select add_entries($1, $2, array[(select id from students where no = 1 and active)], '다른 기기', '', 3)`, [tok, TODAY]);
  await O.page.click('#q');
  await O.page.type('#q', '1');
  await O.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await O.page.waitForTimeout(400);
  assert.equal(await O.page.inputValue('#q'), '1', '입력 중인 글자는 그대로');
  assert.equal(await O.page.evaluate(() => document.activeElement.id), 'q', '입력칸 포커스도 그대로');
  assert.equal(await O.text(tile), `자봉 ${b0}`, '입력 중에는 다시 그리지 않는다');
  await O.page.click('h1');
  await O.page.locator(tile).filter({ hasText: new RegExp(`^자봉 ${b0 + 3}$`) }).waitFor();
  await O.page.fill('#q', '');
});

test('홈 화면 앱: manifest·아이콘, 안드로이드 설치 버튼, 아이폰 안내', async () => {
  const P = await open();
  assert.equal(await P.page.getAttribute('link[rel="manifest"]', 'href'), '/manifest.webmanifest');
  assert.equal(await P.page.getAttribute('link[rel="apple-touch-icon"]', 'href'), '/icon-180.png');
  const get = (u) => P.page.request.get(`http://localhost:${PORT}${u}`);
  const m = await (await get('/manifest.webmanifest')).json();
  assert.equal(m.display, 'standalone');
  assert.equal(m.short_name, '자봉');
  assert.equal(m.start_url, '/');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  for (const ic of [...m.icons.filter((i) => i.type === 'image/png'), { src: '/icon-180.png', sizes: '180x180' }]) {
    const b = await (await get(ic.src)).body();
    assert.equal(b.toString('latin1', 1, 4), 'PNG', ic.src);
    assert.deepEqual([b.readUInt32BE(16), b.readUInt32BE(20)], ic.sizes.split('x').map(Number), `${ic.src} 크기`);
  }
  // 안드로이드 크롬: 설치할 수 있다고 알려 오면 버튼이 생기고, 누르면 설치 창
  assert.equal(await P.page.$('[data-act="install"]'), null);
  await P.page.evaluate(() => {
    const e = new Event('beforeinstallprompt', { cancelable: true });
    e.prompt = () => (window.__prompted = true);
    e.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(e);
  });
  await P.page.waitForSelector('[data-act="install"]');
  assert.ok(await P.page.$eval('[data-act="install"]', (b) => b.getBoundingClientRect().top < document.querySelector('#board-grid').getBoundingClientRect().top), '현황판 위쪽에');
  await P.fits('설치 버튼');
  await P.click('[data-act="install"]');
  assert.equal(await P.page.evaluate(() => window.__prompted), true);
  assert.equal(await P.page.$('[data-act="install"]'), null);
  await P.page.context().close();
  // 아이폰 Safari: 공유 메뉴 안내
  const I = await open({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  assert.match(await I.text(), /공유 버튼 → "홈 화면에 추가"/);
  await I.page.context().close();
});

test('자봉 면제: 관리에서 지정·해제, 면제 학생은 자봉이 빠지고 상점만, 현황판·기록·출석에 "면제" 표시', async () => {
  await A.tab('manage');
  assert.match(await A.text('#exempt-card'), /지정한 학생이 없어요/);
  assert.equal(await A.toast('[data-act="exempt-add"]'), '면제로 지정할 학생을 골라 주세요');
  await A.page.fill('#exForm-find', '서지');
  await A.click('#exForm-sugg [data-act="pick"]');
  assert.equal(await A.toast('[data-act="exempt-add"]'), '6번을 자봉 면제로 지정했어요');
  assert.match(await A.text('#exempt-card .chips'), /6 서지호 ×/);
  assert.ok((await one(`select exempt from students where name = '서지호'`)).exempt);
  await A.fits('자봉 면제 카드');
  const before = await balances();
  await A.tab('record');
  await A.page.fill('#recForm-item', '면제 확인');
  await A.page.fill('#recForm-points', '1');
  await A.page.type('#recForm-find', '6 8 ');
  assert.match(await A.text('#recForm-chips'), /6 서지호 · 면제/);
  assert.equal(await A.toast('[data-act="rec-add"]'), '1명에게 기록했어요 · 자봉 면제 1명은 빠졌어요');
  await A.page.fill('#recForm-item', '면제 상점');
  await A.page.fill('#recForm-points', '-1');
  await A.page.type('#recForm-find', '6 ');
  assert.equal(await A.toast('[data-act="rec-add"]'), '1명에게 기록했어요');
  const after = await balances();
  assert.equal(after['서지호'], before['서지호'] - 1, '면제 학생은 상점만');
  assert.equal(after['정우진'], before['정우진'] + 1);
  await A.tab('board');
  assert.equal(await A.text('#board-grid .tile:has(.no:text-is("6")) .ex'), '면제');
  await A.click('#board-grid .tile:has(.no:text-is("6"))');
  assert.match(await A.text(), /자봉 면제 · 상점만 받아요/);
  await A.tab('attend');
  assert.match(await A.text(`.call:has(.no:text-is("6"))`), /면제/);
  await S.reload();
  assert.equal(await S.text('#board-grid .tile:has(.no:text-is("6")) .ex'), '면제', '학생 화면에도 면제 표시');
  await A.tab('manage');
  assert.equal(await A.toast('#exempt-card [data-act="stu-exempt"]'), '6번 자봉 면제를 풀었어요');
  assert.match(await A.text('#exempt-card'), /지정한 학생이 없어요/);
  assert.ok(!(await one(`select exempt from students where name = '서지호'`)).exempt);
});

test('서버에 못 닿으면 "불러오지 못했어요"와 다시 시도', async () => {
  const R = await open({ beforeGoto: (ctx) => ctx.route('**/rest/v1/rpc/public_state', (r) => r.abort()) });
  assert.match(await R.text(), /불러오지 못했어요/);
  await R.page.context().unroute('**/rest/v1/rpc/public_state');
  await R.click('[data-act="reload"]');
  await R.page.waitForSelector('#board-grid');
  assert.deepEqual(await R.tabs(), ['현황판', '공결 신청']);
  await R.page.context().close();
});

// ───────── 로그인 유지·만료 ─────────
test('새로고침해도 로그인 유지, 서버에서 로그인이 지워지면 다음 동작에서 로그아웃', async () => {
  await A.reload();
  assert.match(await A.text('#subbar'), /부총대로 로그인됨/);
  assert.deepEqual(await A.tabs(), ['출석', '기록', '요청함', '공지', '작업 내역', '관리', '현황판']);
  await db.query(`delete from sessions where role = '부총대'`);
  await A.page.evaluate(() => (document.getElementById('toast').hidden = true));
  await A.page.click('#tabs [data-tab="history"]');
  await A.page.waitForSelector('#toast:not([hidden])');
  assert.equal((await A.text('#toast > span')).trim(), '로그인이 끊겼어요. 다시 로그인해 주세요');
  assert.deepEqual(await A.tabs(), ['현황판', '공결 신청']);
});

// ───────── 좁은 폰(320px)에서 모든 화면 ─────────
test('좁은 폰(320px): 모든 역할의 모든 탭이 가로로 넘치지 않는다', async () => {
  const N = await open({ width: 320, height: 640 });
  for (const t of ['board', 'excuse']) {
    await N.tab(t);
    await N.fits(`320 학생 ${t}`);
  }
  await N.login('총대단', '총대', '1234');
  for (const t of ['attend', 'request', 'reqs', 'board']) {
    await N.tab(t);
    await N.fits(`320 총대 ${t}`);
  }
  await N.toast('[data-act="logout"]');
  await N.login('부총대', '부총대', pw.부총대);
  for (const t of ['attend', 'record', 'inbox', 'notice', 'history', 'manage', 'board']) {
    await N.tab(t);
    await N.fits(`320 부총대 ${t}`);
  }
  await N.tab('manage');
  await N.page.click('summary:has-text("명단 하나씩 고치기")');
  await N.fits('320 관리 펼침');
  await N.tab('record');
  await N.click('[data-act="pickgrid"]');
  await N.click('[data-act="pts-open"][data-fk="recForm"]');
  await N.fits('320 기록 전체 명단·숫자판');
  await N.page.evaluate(() => window.scrollTo(0, 0));
  assert.ok(await N.page.$eval('#recForm-item', (el) => {
    const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === el && r.width - 84 > 120;
  }), '좁은 폰에서도 항목명 칸 가운데는 칸이고, 글자 칸이 넉넉하다 (불러오기 버튼에 가리지 않게)');
  await N.page.click('#recForm-item');
  assert.ok(await N.page.$('#sugbox'));
  await N.fits('320 항목 추천');
  await N.click('[data-act="pr-open"][data-fk="recForm"]');
  await N.fits('320 불러오기 창');
  await N.page.context().close();
});

test('화면 오류(자바스크립트 예외·콘솔 오류)가 하나도 없다', () => {
  assert.deepEqual(errors, []);
});
