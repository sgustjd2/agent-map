---
description: 내 로컬 Claude Code 구성(플러그인·스킬·에이전트·MCP·훅)을 지도로 열기
allowed-tools: Bash(node:*)
---
Bash 도구로 아래 명령을 한 번만 실행해라.

node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-map.mjs"

출력(그룹별 개수와 HTML 경로)을 한두 줄로 요약하고 HTML 경로를 그대로 안내해라. 브라우저는 스크립트가 이미 열었다. 그 외 작업은 하지 마라.
