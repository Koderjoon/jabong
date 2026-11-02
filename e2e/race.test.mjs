// 동시에 들어오는 요청 검사 (psql 한 줄씩으로는 재현할 수 없는 것). 로컬 Postgres가 필요하다 (PGHOST·PGUSER·PGPASSWORD).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DBNAME = 'jabong_race';
let db;

before(async () => {
  const a = new pg.Client({ database: 'postgres' });
  await a.connect();
  await a.query(`drop database if exists ${DBNAME} with (force)`);
  await a.query(`create database ${DBNAME}`);
  await a.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if; end $$`);
  await a.end();
  db = new pg.Pool({ database: DBNAME, max: 40 });
  db.on('error', () => {}); // 끝날 때 DB를 지우며 끊는 연결 알림은 무시
  await db.query(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
  await db.query(`select init_app('1234')`);
});

after(async () => {
  await db?.end();
  const a = new pg.Client({ database: 'postgres' });
  await a.connect();
  await a.query(`drop database if exists ${DBNAME} with (force)`);
  await a.end();
});

// 브라우저처럼 anon 역할로 부른다
const rpc = async (sql, params) => {
  const c = await db.connect();
  try {
    await c.query('begin');
    await c.query('set local role anon');
    const r = await c.query(sql, params);
    await c.query('commit');
    return r.rows[0];
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
};

test('비밀번호를 동시에 30번 틀려도 5번째에서 잠기고, 뒤의 시도가 잠금을 풀지 못한다', async () => {
  const res = await Promise.all(Array.from({ length: 30 }, (_, i) => rpc(`select login('운영부장', $1)::json ->> 'error' as e`, ['wrong' + i]).then((r) => r.e)));
  assert.equal(res.filter((e) => e === '비밀번호가 맞지 않아요').length, 5);
  assert.equal(res.filter((e) => e.includes('잠겼어요')).length, 25);
  assert.match((await rpc(`select login('운영부장', '1234')::json ->> 'error' as e`)).e, /잠겼어요/);
});

test('복구 코드를 동시에 20번 틀려도 잠긴다', async () => {
  const res = await Promise.all(Array.from({ length: 20 }, () => rpc(`select recover('AAAA-AAAA-AAAA', '부총대', 'abcd')::json ->> 'error' as e`).then((r) => r.e)));
  assert.equal(res.filter((e) => e === '복구 코드가 맞지 않아요').length, 5);
  assert.ok(res.every((e) => e));
});

test('같은 교시를 동시에 추가해도 오류 없이 하나만 생긴다', async () => {
  const t = (await rpc(`select login('부총대', '1234')::json ->> 'token' as t`)).t;
  const ids = await Promise.all(Array.from({ length: 10 }, () => rpc(`select ensure_period($1, '2026-05-01', '1교시', false) as p`, [t]).then((r) => r.p)));
  assert.equal(new Set(ids).size, 1);
  assert.equal((await db.query(`select count(*)::int as n from periods where label = '1교시'`)).rows[0].n, 1);
});

test('교시 삭제와 그 교시 출석 저장이 동시에 와도 영어 오류 없이 하나가 먼저, 다른 하나는 안내', async () => {
  const t = (await rpc(`select login('부총대', '1234')::json ->> 'token' as t`)).t;
  await rpc(`select roster_apply($1, '[{"op":"add","name":"가","no":1}]', '[]', '2026-05-01')`, [t]);
  const s1 = (await db.query(`select id from students where name = '가'`)).rows[0].id;
  for (let i = 0; i < 5; i++) {
    const p = (await rpc(`select ensure_period($1, '2026-05-02', $2, false) as p`, [t, `${i + 1}교시`])).p;
    const res = await Promise.allSettled([
      rpc(`select save_attendance($1, $2, $3::jsonb)`, [t, p, JSON.stringify({ [s1]: 'late' })]),
      rpc(`select delete_period($1, $2)`, [t, p]),
    ]);
    for (const r of res) if (r.status === 'rejected') assert.match(r.reason.message, /교시를 찾을 수 없어요/, r.reason.message);
    assert.equal((await db.query(`select count(*)::int as n from periods where id = $1`, [p])).rows[0].n, 0, '교시는 지워진다');
    assert.equal((await db.query(`select count(*)::int as n from ledger where period_id = $1`, [p])).rows[0].n, 0);
  }
});

test('학생 성적 비밀번호: 처음 들어오는 학생(비밀번호 줄이 아직 없음)에게 동시에 30번 틀려도 5번째에서 잠기고, 맞는 이름도 막힌다', async () => {
  const s = (await db.query(`insert into students (no, name) values (901, '동시성') returning id`)).rows[0].id;
  const res = await Promise.all(Array.from({ length: 30 }, (_, i) => rpc(`select student_login(901, $1)::json ->> 'error' as e`, ['틀림' + i]).then((r) => r.e)));
  assert.equal(res.filter((e) => e === '비밀번호가 맞지 않아요').length, 5);
  assert.equal(res.filter((e) => /잠겼어요/.test(e || '')).length, 25);
  assert.match((await rpc(`select student_login(901, '동시성')::json ->> 'error' as e`)).e, /잠겼어요/);
  assert.equal((await db.query(`select count(*)::int as n from student_pw where student_id = $1`, [s])).rows[0].n, 1);
  // 이미 비밀번호 줄이 있는 학생도 (잠김이 풀린 뒤 다시)
  await db.query(`update student_pw set locked_until = now() - interval '1 second' where student_id = $1`, [s]);
  const res2 = await Promise.all(Array.from({ length: 30 }, (_, i) => rpc(`select student_login(901, $1)::json ->> 'error' as e`, ['다시틀림' + i]).then((r) => r.e)));
  assert.equal(res2.filter((e) => e === '비밀번호가 맞지 않아요').length, 5);
  assert.equal(res2.filter((e) => /잠겼어요/.test(e || '')).length, 25);
});

test('학생 성적 비밀번호: 이름으로 들어온 두 기기가 동시에 새 비밀번호를 정하면 하나만 되고, 다른 기기는 끊긴다', async () => {
  await db.query(`insert into students (no, name) values (902, '두기기')`);
  for (let round = 0; round < 5; round++) {
    await db.query(`delete from student_pw where student_id = (select id from students where no = 902)`);
    const a = (await rpc(`select student_login(902, '두기기')::json ->> 'token' as t`)).t;
    const b = (await rpc(`select student_login(902, '두기기')::json ->> 'token' as t`)).t;
    const res = await Promise.allSettled([
      rpc(`select student_change_pw($1, null, 'aaaa1111')`, [a]),
      rpc(`select student_change_pw($1, null, 'bbbb2222')`, [b]),
    ]);
    const won = res.findIndex((r) => r.status === 'fulfilled');
    assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1, `한 기기만 (${round})`);
    const lost = res[1 - won];
    assert.ok(['현재 비밀번호가 맞지 않아요', '성적 로그인이 끊겼어요. 다시 로그인해 주세요'].includes(lost.reason.message), lost.reason.message);
    const [wt, lt, wp] = won === 0 ? [a, b, 'aaaa1111'] : [b, a, 'bbbb2222'];
    await assert.rejects(rpc(`select my_grades($1)`, [lt]), (e) => e.code === 'P0401');
    assert.equal((await rpc(`select (my_grades($1) ->> 'initial')::boolean as i`, [wt])).i, false);
    assert.ok((await rpc(`select student_login(902, $1)::json ->> 'token' as t`, [wp])).t);
  }
});
