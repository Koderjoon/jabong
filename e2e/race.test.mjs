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
