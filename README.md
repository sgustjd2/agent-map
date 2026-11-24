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

## 크레딧
화면 디자인 패스는 Damir Sokolovsky ([@heydamir](https://x.com/heydamir))의 [unslop](https://github.com/heydamir/unslop) 스킬(CC BY 4.0)의 지침을 따라 적용했다.
