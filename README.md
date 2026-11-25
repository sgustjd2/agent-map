# agent-map

내 로컬 Claude Code에 설정된 **플러그인 · 스킬 · 에이전트 · 커맨드 · 훅 · MCP**를 한 화면 지도로 보여주는 플러그인.

## 설치 (팀원 각자)
```
/plugin marketplace add <이 저장소의 git URL 또는 로컬 경로>
/plugin install agent-map@agent-map
```
## 사용
`/agent-map` → 로컬을 스캔해 HTML을 만들고 기본 브라우저로 연다. (Claude Code CLI·Desktop 모두 동일, Node 18+ 필요)
터미널에는 그룹별 개수 요약이 출력된다. 스캔만 하려면 `node scripts/agent-map.mjs --no-open`.

## 보는 것
- 그룹: 사용자(~/.claude) / 현재 프로젝트(.claude, .mcp.json) / 설치된 플러그인(비활성 표시)
- 상단 필터·검색, 칩 클릭 시 설명 표시
- 보안: MCP/훅은 이름, URL(쿼리·계정정보 제거), 실행파일명만 표시하고 args/env/헤더는 읽지 않는다. HTML은 ~/.claude/agent-map/ 에 저장. 외부 전송 없음.

## 실시간 대시보드 (`/agent-map:live`)
프로젝트 폴더별로 지금 어떤 작업이 진행 중인지, 세션의 작업 흐름이 어떻게 이어지는지 실시간으로 본다.
- **프로젝트 탭:** 폴더별 카드(작업 중/대기/휴면, 마지막 활동, 많이 쓴 도구, 사용한 스킬, 세션 목록)
- **실시간 흐름 탭:** 세션을 누르면 프롬프트, 도구 호출, 서브에이전트, 응답이 순서대로 이어지고 단계 사이 대기 시간이 표시된다. 2초마다 갱신
- 종료: `node scripts/live.mjs --stop` (30분 동안 접속이 없으면 자동 종료)

**개인정보와 보안**
- `~/.claude/projects`의 세션 기록 끝부분만 읽고, 화면에는 프로젝트 경로, 세션 제목, 시각, 도구 이름, 파일 기본 이름, 실행 파일 이름만 보낸다. 프롬프트 본문, 명령어 인자, 도구 출력은 읽어서 내보내지 않는다.
- 서버는 `127.0.0.1`에서만 열리고 외부 전송이 없다. 다른 Host 헤더는 거부한다.
- 세션 제목은 작업 주제가 드러날 수 있으니 화면을 공유할 때 주의한다.

## 크레딧
화면 디자인 패스는 Damir Sokolovsky ([@heydamir](https://x.com/heydamir))의 [unslop](https://github.com/heydamir/unslop) 스킬(CC BY 4.0)의 지침을 따라 적용했다.
