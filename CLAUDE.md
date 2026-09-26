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
- **공개 범위**: `public_state()`는 번호와 자봉 내역만 준다. 학생 이름, 기록·요청·승인·수정한 사람은 `private_state()`(로그인)에만 넣는다. 기록자 정보는 `ledger`가 아니라 `ledger_private`에 둔다. 내보내기 엑셀에도 이름과 요청자를 넣지 않는다.
- **기록은 지우지 않는다.** 수정은 `ledger_revisions`, 무효 처리는 `voided_at`/`void_reason`. 예외는 `purge()` 하나이고, 이때도 학생별 "이월" 기록으로 점수를 보존한다.
- 점수 부호: 자봉 `+`, 상점 `-`. 화면의 "자봉"은 무효가 아닌 기록의 합이다. 음수 허용.
- 출석은 교시별이다. "아침 출석"은 날짜마다 항상 맨 앞에 있고, 서버에 없으면 `v:`로 시작하는 임시 id로 보여 주다가 저장할 때 `ensure_period`로 만든다. 지각 +1, 결석 +2 (항목 설정의 점수를 따른다).
- 공지 문구 형식은 학급이 손으로 쓰던 카톡 공지를 그대로 따른다. `genNotice`를 고치면 `test/logic.test.js`의 기대 문자열도 확인한다.
- 한글 입력: 입력칸을 통째로 다시 그리면 조합이 깨진다. 입력 중 갱신이 필요하면 `data-live`(추천·칩 영역만 갱신)나 `data-region`(특정 영역만 갱신)을 쓰고, `data-rerender`는 날짜·숫자·체크박스처럼 한글이 없는 칸에만 쓴다.
- 서버 오류 메시지는 한국어로 `raise exception` 한다. 화면은 그 메시지를 그대로 토스트로 보여 준다.

## 명령

```bash
npm test          # node:test 유닛 테스트
npm run build
npm run dev       # .env.local에 VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY 필요
```

DB 테스트: README의 "개발" 절 참고 (`supabase/tests/flow.sql`, anon 역할로 전환해 권한까지 검증). CI(`.github/workflows/test.yml`)가 두 테스트와 빌드를 모두 돌린다.
