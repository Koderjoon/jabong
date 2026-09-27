# CLAUDE.md

치전원 25학번 자봉(벌점)·상점 장부 웹앱. 문서·주석·커밋 메시지·화면 문구는 한국어로 쓴다.

## 구조

- `supabase/schema.sql` — 테이블, 권한, 모든 서버 함수. **정책의 실제 구현은 여기**에 있다.
- `src/logic.js` — 화면·서버와 무관한 계산 (공지 문구, 명단 붙여넣기 비교, 내보내기 시트). 유닛 테스트 대상.
- `src/main.js` — 화면 전체. 템플릿 문자열로 HTML을 만들고 `data-act`(클릭)·`data-bind`(입력)로 이벤트를 받는다.
- `src/api.js` — Supabase 연결, 로그인 토큰 저장. `src/excel.js` — 엑셀 내보내기.

빌드 도구는 Vite, 프레임워크 없음. 배포는 Vercel(정적 사이트), DB는 Supabase 무료 요금제.

## 지켜야 할 규칙

- **브라우저는 테이블에 직접 접근하지 않는다.** 모든 읽기·쓰기는 `security definer` 함수(RPC)로 한다. 새 함수를 만들면 파일 끝의 `grant execute` 목록에 넣어야 브라우저에서 부를 수 있다. `_`로 시작하는 함수와 `init_app`은 브라우저에 열지 않는다.
- **공개 범위**: `public_state()`는 번호와 자봉 내역만 준다. 학생 이름, 기록·요청·승인·수정한 사람은 `private_state()`(로그인)에만 넣는다. 화면에서는 로그인한 총대단 전체(부총대 포함)가 현황판·학생 상세에서 이름을 보고, 기록·요청·승인한 사람은 부총대만 본다(`isStaff`/`isAdmin`). 기록자 정보는 `ledger`가 아니라 `ledger_private`에 둔다. 내보내기 엑셀에도 이름과 요청자를 넣지 않는다.
- **기록은 지우지 않는다.** 수정은 `ledger_revisions`, 무효 처리는 `voided_at`/`void_reason`. 예외는 `purge()` 하나이고, 이때도 학생별 "이월" 기록으로 점수를 보존한다.
- 자봉 면제(`students.exempt`, 관리 탭 "자봉 면제" 카드, `roster_apply`의 `{op:'exempt',id,on}`): `_entry`가 면제 학생의 +점수(출석·직접 기록·요청)를 기록하지 않고 null을 돌려준다. 명단 붙여넣기의 점수 맞추기(import)와 이월(carry)은 예외. 기록 수를 세는 곳은 `_entry`가 null이면 세지 않는다. 지정 전 자봉은 그대로다.
- 점수 부호: 자봉 `+`, 상점 `-`. 화면의 "자봉"은 무효가 아닌 기록의 합이다. 음수 허용.
- 관리자(`is_admin`)는 부총대 한 명이다. 총대는 총대단이다.
- 출석은 부총대가 `save_attendance`로 바로 저장한다. `can_attend`인 총대단(총대, 실습부장 1·2, 스키마에 고정)은 `request_attendance`로 요청을 보내고, 부총대가 `review_attendance`로 승인하면 `_apply_attendance`가 반영한다. 이때 기록의 `requested_by`/`approved_by`가 남는다.
- 출석은 교시별이다. "아침 출석"은 부총대 화면에만, 날짜마다 항상 맨 앞에 있고 (총대단은 아침 출석을 보지 않고 교시를 추가해서 체크한다), 서버에 없으면 `v:`로 시작하는 임시 id로 보여 주다가 저장할 때 `ensure_period`로 만든다. 지각 +1, 결석 +2 (고정).
- 공지 문구 형식은 학급이 손으로 쓰던 카톡 공지를 그대로 따른다. `genNotice`를 고치면 `test/logic.test.js`의 기대 문자열도 확인한다.
- 자주 쓰는 항목은 직책마다 따로(`presets.owner`, `my_presets_save`)이고 공용 항목은 없다. 따로 관리 화면은 없고, 항목명 칸 오른쪽 "불러오기" 창(`.prpop`)에서 고르고, "＋ 자주 쓰는 항목 추가"를 누르면 그 자리에 뜨는 항목명·점수 칸으로 새로 넣고, ×로 뺀다. 항목명 칸 가운데를 누르면 입력 추천(`#sugbox`)이 뜬다. 출석 점수는 지각 +1, 결석 +2로 고정이다.
- 점수 칸은 가운데가 숫자 직접 입력, 오른쪽 ▾는 +5~-5(1점 단위) 작은 숫자판(`.ptspop`)이다. 폰 기본 선택창은 "완료"를 눌러야 해서 쓰지 않는다.
- 학생 추천·칩·명단 버튼(`TAP_NOW`)은 touchend에서 바로 누른다. 보통 click은 입력칸 blur → 한글 조합 끝 → 추천 목록 다시 그리기 뒤에 와서 두 번 눌러야 했다.
- 학생 고르기는 입력칸 하나(`data-picker`)다. 띄어쓰기·Enter로 번호나 정확한 이름을 선택(`f.nums`)으로 옮기고, 이름 일부면 추천 목록에서 고른다. 저장할 때 칸에 남은 글자도 먼저 옮긴다.
- 입력 추천: 칸에 `data-suggest="종류"`(item·detail·period·editReason·voidReason·note·reqReason)를 붙이면, 칸을 누를 때 `logic.js`의 `suggest*`가 지난 기록(S)에서 뽑은 최근·자주 쓴 값을 칸 아래 `#sugbox`에 띄운다. 따로 저장하지 않는다(어느 기기든 같고 작업 내역과 함께 움직인다). 항목명은 점수도 함께 넣는다. 교시는 같은 요일 것을 먼저. 화면 시각은 분 단위라, 같은 분이면 서버 목록에서 뒤에 있는 것을 최근으로 본다. 상자는 점수 칸과 한 줄(`.row2`)이면 그 줄 아래에 붙인다 — 줄 안에 넣으면 폰·크롬에서 커서가 튀어 친 글자 순서가 뒤집힌다.
- 되돌리기 버튼: 부총대 작업 뒤 안내는 `doneToast()`로 띄운다. `ops_list`의 맨 위 작업이 방금 내 것이면 "되돌리기"(=`history_drop`)를 붙인다. 안내 글자는 `#toast > span`, 버튼은 그 옆이다.
- 학생 "내 번호"는 `localStorage`(`jabong-myno`)에만 둔다. 서버에 저장하지 않는다(번호만 고르면 누구나 되는 것과 같은 수준).
- 홈 화면 앱: `public/manifest.webmanifest`와 아이콘(`public/icon-*.png`, 파비콘 `favicon-64.png`). 아이콘은 Pretendard ExtraBold로 그린 "자봉" PNG다(SVG로 두면 폰에 글꼴이 없어 모양이 바뀐다). 서비스 워커는 두지 않는다(캐시 때문에 새 버전이 늦게 보이는 일을 피하려고).
- 한글 입력: 입력칸을 통째로 다시 그리면 조합이 깨진다. 입력 중 갱신이 필요하면 `data-live`(추천·칩 영역만 갱신)나 `data-region`(특정 영역만 갱신)을 쓰고, `data-rerender`는 날짜·숫자·체크박스처럼 한글이 없는 칸에만 쓴다.
- Supabase는 앱에서 온 요청의 `where` 없는 `delete`/`update`를 거절한다(pg_safeupdate). 로컬 Postgres에서는 통과하니, 전체를 지울 때도 `where true`를 붙인다. `test/schema.test.js`가 검사한다.
- 백업: `_dump()`가 비밀번호·로그인·사진을 뺀 전체 데이터를 JSON으로 만든다. `backup_dump()`는 로그인 없이 누구나 부를 수 있다(학급이 이름 공개를 괜찮다고 정했다). jabong-backup 저장소의 GitHub Actions가 매일 이것을 받아 암호화 없이 올린다. `restore_backup`은 부총대만 되고, 되살리기 직전에 화면이 현재 상태 파일을 먼저 받게 한다. `src/backupcrypt.js`는 예전에 암호를 걸어 받은 파일을 열 때만 쓴다.
- 작업 내역(뒤로가기·앞으로 가기): 데이터를 바꾸는 서버 함수는 권한 확인 직후 `_op(누가, 종류, 요약)`을 불러야 한다. 그러면 트리거 `zz_log`(_log_change)가 그 트랜잭션에서 바뀐 행의 전·후를 `op_changes`에 남긴다. `_op`를 빼먹으면 그 작업은 작업 내역에 없고 되돌릴 수도 없다. 작업은 한 줄 시간선이다: `history_move(시점)`은 그 작업 직후 상태로 뒤·앞으로 옮기며 `ops.undone`만 바꾸고, `history_drop(작업)`은 작업 하나만 되돌려 `ops.dropped`로 빼 두고, `history_restore(작업)`가 다시 살린다. 빼 둔 작업은 뒤·앞으로 이동할 때 데이터는 건드리지 않고 undone 표시만 함께 옮긴다. **이동·되돌리기 자체는 기록을 남기지 않는다** (사용자가 정함. 남는 이력은 기록의 수정·무효뿐). 새 작업을 하면 `_op`가 undone 작업(뒤로 간 쪽의 빼 둔 작업 포함)을 지운다. 작업 밖에서 바뀐 행이 있거나 뒤 작업과 겹치면 `_apply_op`가 P0002로 멈춘다. 미리보기는 끝까지 계산한 뒤 P0003으로 전부 취소한다. 새 표를 만들면 `zz_log` 트리거 목록, `_log_change`의 기본키 매핑, `_dump`, `restore_backup`에 넣는다. 정리·되살리기는 `_op(..., false)`로 넘을 수 없게 하고 작업 로그를 비운다. 테스트는 `supabase/tests/rewind.sql`·`rewind_all.sql`, 기능을 빼는 방법은 `supabase/rollback-rewind.sql`.
- DB 테스트에서 권한 오류를 기대할 때는 `pg_temp.expect(쿼리, 오류코드, 설명)`에 미리 받아 둔 토큰을 넣는다. anon으로 바꾼 뒤 표를 읽는 하위 쿼리를 쓰면 표 읽기 권한 때문에 엉뚱하게 통과한다.
- 서버 오류 메시지는 한국어로 `raise exception` 한다. 화면은 그 메시지를 그대로 토스트로 보여 준다.

## 명령

```bash
npm test          # node:test 유닛 테스트 (src/logic.js)
npm run test:db   # DB 테스트 전부 (supabase/tests/run.sh, PGHOST·PGUSER·PGPASSWORD 필요)
npm run test:e2e  # 브라우저 전체 기능 테스트 (e2e/, Postgres + Chromium, CHROMIUM_PATH로 실행 파일 지정 가능)
npm run build
npm run dev       # .env.local에 VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY 필요
```

CI(`.github/workflows/test.yml`)가 세 가지 테스트와 빌드를 모두 돌린다.

- 서버 함수를 새로 만들거나 바꾸면 `supabase/tests/functions.sql`에 권한·검사·동작을 넣는다. 첫 절의 "브라우저에 열린 함수" 목록도 고친다. 데이터를 바꾸는 함수면 `rewind_all.sql`의 시나리오에도 한 번 부르게 넣는다 (모든 시점 왕복 검증).
- 화면을 바꾸면 `e2e/app.test.mjs`의 해당 절을 고친다. 이 파일은 위에서부터 이어지는 이야기라 앞 절의 데이터(명단·점수)를 뒤에서 쓴다. 점수 기대값을 바꿀 때는 앞 절에서 누가 몇 점을 받았는지 따라가 본다.
- 테스트가 정말 잡는지 보려면 코드를 일부러 망가뜨려 돌려 본다 (돌연변이 검사). 통과만 보고 끝내지 않는다.
