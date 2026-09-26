import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Supabase(PostgREST)는 pg_safeupdate 때문에 where 없는 delete/update를 거절한다.
// 로컬 Postgres 테스트로는 잡히지 않으니 스키마 글자를 직접 검사한다.
test('서버 함수의 delete/update에는 모두 where가 있다', () => {
  const sql = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8')
    .replace(/--[^\n]*/g, '')
    .replace(/'(?:[^']|'')*'/g, "''");
  const bad = sql
    .split(';')
    .map((st) => st.replace(/\s+/g, ' ').trim())
    .filter((st) => /(^|\s)(delete from|update) [a-z_]+/i.test(st))
    .filter((st) => !/\bon conflict\b/i.test(st) && !/\btrigger\b/i.test(st) && !/\balter\b/i.test(st))
    .filter((st) => !/\swhere\s/i.test(st.slice(st.search(/(delete from|update) [a-z_]+/i))));
  assert.deepEqual(bad, []);
});
