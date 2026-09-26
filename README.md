# 25학번 자봉 장부

치전원 25학번의 자봉(벌점)·상점을 기록하고, 학생 전원이 실시간으로 볼 수 있게 하는 웹앱이다.

- **학생**: 로그인 없이 링크로 현황판(번호와 자봉 점수)을 보고, 자기 번호로 공결을 신청한다.
- **총대단** (총대, 실습부장 1·2, 운영부장, 총무, 학습부장, 정리부장, 치아부장): 자봉·상점을 요청한다. 총대와 실습부장 1·2는 출석을 체크해 **출석 요청**을 보낸다.
- **부총대** (관리자 한 명): 출석 저장, 직접 기록, 수정·무효 처리, 요청·출석 요청·공결 승인, 공지 문구, 엑셀 내보내기, 명단·비밀번호 관리, 작업 내역에서 되돌리기.

자봉은 `+`, 상점은 `-`로 기록한다. 화면의 "자봉"은 둘을 합친 점수이고, 음수면 남은 상점이 이월된 것이다.
기록은 지우지 않는다. 수정하면 이력이 남고, 무효 처리하면 줄이 그어진 채로 남는다.

## 처음 설정 (한 번만, 20분 정도)

돈이 드는 단계는 없다. Supabase(데이터베이스)와 Vercel(웹사이트) 무료 요금제를 쓴다.

### 1. Supabase 프로젝트 만들기

1. <https://supabase.com> 에 GitHub 계정으로 가입한다.
2. **New project**를 누르고 아래처럼 만든다.
   - Name: `jabong`
   - Database Password: 아무거나 길게 정하고 따로 적어 둔다. 앱에서는 쓰지 않는다.
   - Region: **Northeast Asia (Seoul)**
3. 왼쪽 메뉴 **SQL Editor** → **New query**에 [`supabase/schema.sql`](supabase/schema.sql) 전체를 붙여넣고 **Run**을 누른다.
   - "Success. No rows returned"가 나오면 된다.
4. 다시 **New query**에 아래 한 줄을 넣고 **Run**을 누른다. 따옴표 안에는 처음 쓸 비밀번호를 넣는다.

   ```sql
   select init_app('처음비밀번호');
   ```

   - 모든 직책(부총대와 총대단 8명)의 비밀번호가 이것으로 정해진다. 나중에 앱에서 바꾼다.
   - 결과로 나오는 `ABCD-EFGH-JKLM` 모양의 **복구 코드**를 캡처해서 보관한다. 부총대가 비밀번호를 잊었을 때 쓴다.
5. 왼쪽 아래 **Project Settings** → **API Keys**(또는 **API**)에서 두 값을 복사해 둔다.
   - **Project URL**: `https://xxxx.supabase.co`
   - **anon public** 키 (또는 **Publishable key** `sb_publishable_...`). 공개돼도 괜찮은 키다. `service_role`/`secret` 키는 절대 쓰지 않는다.

### 2. Vercel에 올리기

1. <https://vercel.com> 에 GitHub 계정으로 가입한다.
2. **Add New… → Project**에서 `jabong` 저장소를 **Import**한다.
3. **Environment Variables**에 두 개를 넣는다.

   | Name | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | 위의 Project URL |
   | `VITE_SUPABASE_ANON_KEY` | 위의 anon(publishable) 키 |

4. **Deploy**를 누른다. 1분쯤 뒤 `https://jabong-xxxx.vercel.app` 같은 주소가 나온다. 이 주소를 카톡 공지방에 올리면 된다.
   - 저장소에 코드를 올리면(push) Vercel이 알아서 다시 배포한다.

### 3. 앱에서 마무리

1. 앱 주소 → **부총대** → 부총대로 로그인한다.
2. **관리 → 명단 붙여넣기**에 지금 쓰는 엑셀의 **번호·이름·자봉** 세 열을 복사해 붙여넣고 적용한다. 현재 자봉 점수가 "기존 누적"으로 들어간다.
3. **관리 → 비밀번호 → 다른 사람 비밀번호 재설정**으로 총대단 각자의 비밀번호를 새로 정해 알려준다. 내 비밀번호도 바꾼다.
4. **관리 → 자주 쓰는 항목**에서 항목과 점수를 확인한다.

### 4. 잠들지 않게 하기 (권장)

Supabase 무료 프로젝트는 **1주일 동안 아무도 접속하지 않으면 일시정지**된다. 방학 때 멈추지 않도록, 이 저장소의 GitHub Actions가 사흘마다 한 번 접속한다.

GitHub 저장소 → **Settings → Secrets and variables → Actions → New repository secret**으로 두 개를 넣는다.

| Name | Value |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | anon(publishable) 키 |

**Actions** 탭 → "잠들지 않게 깨우기" → **Run workflow**로 한 번 돌려서 초록불이 뜨는지 확인한다.
만약 멈췄다면 Supabase 대시보드에서 **Restore project**를 누르면 데이터 그대로 다시 켜진다.

## 운영 메모

- **무료 한도**: 데이터베이스 500MB. 기록은 글자라 몇 년을 써도 수 MB다. 증빙 사진은 약 50~100KB로 줄여 저장하고, 처리 180일 뒤 자동으로 지운다.
- **백업**: [jabong-backup](https://github.com/Koderjoon/jabong-backup) 저장소의 GitHub Actions가 매일 새벽 3시에 전체 데이터를 `backups/날짜.json`으로 올린다 (암호화하지 않아 누구나 읽을 수 있다). 처음 설정과 되살리는 방법은 그 저장소의 README에 있다. 앱의 **관리 → 백업**에서 언제든 직접 파일을 받을 수도 있다. 매달 **공지 → 내보내기**로 만드는 엑셀은 사람이 읽는 용도이고, 백업 파일은 앱에 통째로 되살리는 용도다.
- **보관 후 정리** (관리 탭): 기준 날짜까지의 기록을 학생별 "이월" 한 줄로 합친다. 점수는 그대로다. 먼저 전체 기간 엑셀을 받아야 버튼이 켜진다. 보통 1년에 한 번이면 충분하다.
- **작업 내역**: 누가 언제 무엇을 바꿨는지 남고, 부총대는 "이 작업만 되돌리기"나 "이 작업 직전으로"로 되돌릴 수 있다. 되돌리기 전에 바뀌는 점수·번호를 미리 보여 주고, 되돌리기도 다시 되돌릴 수 있다. 보관 후 정리와 백업에서 되살리기는 되돌릴 수 없다.
- **인수인계**: 다음 부총대에게 비밀번호와 복구 코드를 넘기고, 받은 사람이 로그인해서 자기 비밀번호로 바꾼다. Supabase·Vercel 프로젝트도 넘겨야 하면 각 서비스의 팀 초대 또는 프로젝트 이전 기능을 쓴다.
- **비밀번호를 잊었을 때**: 총대단은 부총대가 재설정한다. 부총대는 로그인 화면의 "복구 코드로 들어가기".
- 비밀번호를 5번 틀리면 그 직책은 10분 동안 잠긴다.

## 개발

```bash
npm install
cp .env.example .env.local   # Supabase 주소와 키를 넣는다
npm run dev                  # http://localhost:5173
npm test                     # 계산 로직 유닛 테스트 (공지 문구, 명단 붙여넣기, 내보내기)
npm run build
```

DB 함수 테스트는 로컬 Postgres 16에서 돌린다 (CI도 같은 방식).

```bash
psql -c "create role anon nologin" -c "create role authenticated nologin" -c "create database jabong"
psql -d jabong -v ON_ERROR_STOP=1 -f supabase/schema.sql
psql -d jabong -v ON_ERROR_STOP=1 -f supabase/tests/flow.sql   # "모든 DB 흐름 테스트 통과"
```

`schema.sql`은 여러 번 실행해도 된다. 함수를 고쳤으면 Supabase SQL Editor에 파일 전체를 다시 붙여넣고 실행한다.
