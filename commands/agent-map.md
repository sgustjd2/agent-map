---
description: 내 로컬 Claude Code 구성(플러그인·스킬·에이전트·MCP·훅)을 지도로 열기
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-map.mjs"`

위 출력은 `/agent-map` 실행 결과다. 한두 줄로 요약해서 알려주고, 생성된 HTML 경로를 그대로 안내해라. 그 외 작업은 하지 마라.
