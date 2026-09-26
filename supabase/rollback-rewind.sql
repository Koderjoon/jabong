-- 뒤로가기·앞으로 가기(작업 내역) 기능을 빼고 예전으로 돌아가고 싶을 때 쓴다.
--
-- 1. 이 파일 전체를 Supabase SQL Editor에서 실행한다. (작업 로그 표·트리거·함수를 지운다)
-- 2. 곧바로 되돌리기 기능이 들어가기 전의 schema.sql을 다시 실행한다.
--    GitHub → jabong → supabase/schema.sql → History → "되돌리기 기능" 커밋 바로 전 버전을 연다.
--
-- 명단·기록·요청·출석 같은 데이터는 건드리지 않는다. 작업 내역만 사라진다.

do $$ declare t text; begin
  foreach t in array array['students','presets','periods','attendance','ledger','ledger_private','ledger_revisions','requests','excuses','attendance_requests'] loop
    execute format('drop trigger if exists zz_log on %I', t);
  end loop;
end $$;
drop function if exists history_move(uuid, bigint, boolean);
drop function if exists history_drop(uuid, bigint, boolean);
drop function if exists history_restore(uuid, bigint, boolean);
drop function if exists _history_one(uuid, bigint, boolean, boolean);
drop function if exists _snap_diff(jsonb, jsonb);
drop function if exists _op_json(bigint[], boolean);
drop function if exists ops_list(uuid, integer);
drop function if exists _apply_op(bigint, boolean, bigint);
drop function if exists undo_ops(uuid, bigint, text, boolean);
drop function if exists _undo_one(bigint, bigint);
drop function if exists _set_undone(bigint, bigint, bigint);
drop function if exists _snap();
drop function if exists _log_change();
drop table if exists op_changes;
drop table if exists ops;
-- 작업 기록 도우미. 2번에서 예전 schema.sql을 실행하면 이것을 부르는 함수들이 예전 모습으로 바뀐다.
drop function if exists _op(text, text, text, boolean);
drop function if exists _pt(numeric);
drop function if exists _nums(uuid[]);
drop function if exists _per(uuid);
drop function if exists _attn(jsonb);
