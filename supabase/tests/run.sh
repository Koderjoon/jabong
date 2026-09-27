#!/bin/sh
# DB 테스트 전부 실행: 테스트마다 새 DB를 만들고, schema.sql을 두 번 실행한 뒤(여러 번 실행해도 되는지) 테스트를 돌린다.
# psql 접속 정보는 PGHOST·PGUSER·PGPASSWORD 환경 변수로 준다.  사용: npm run test:db
set -e
cd "$(dirname "$0")/../.."
# NOTICE(없는 것 지우기 등)는 숨기고 오류만 보인다
export PGOPTIONS="-c client_min_messages=warning"
psql -q -v ON_ERROR_STOP=1 -d postgres -c "do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if; end \$\$"
for t in flow rewind functions rewind_all scale; do
  db="jabong_test_$t"
  echo "── $t.sql"
  psql -q -d postgres -c "drop database if exists $db with (force)" -c "create database $db" >/dev/null
  psql -q -d "$db" -v ON_ERROR_STOP=1 -f supabase/schema.sql >/dev/null
  psql -q -d "$db" -v ON_ERROR_STOP=1 -f supabase/schema.sql >/dev/null
  psql -q -d "$db" -o /dev/null -v ON_ERROR_STOP=1 -f "supabase/tests/$t.sql"
  psql -q -d postgres -c "drop database $db" >/dev/null
done
echo "DB 테스트 모두 통과"
