---
description: 프로젝트별 작업과 흐름을 실시간으로 보는 대시보드 열기 (이 컴퓨터에서만 접속)
allowed-tools: Bash(node:*)
---
Bash 도구로 아래 명령을 한 번만 실행해라.

node "${CLAUDE_PLUGIN_ROOT}/scripts/live.mjs" $ARGUMENTS

출력된 주소를 그대로 안내해라. `--lan`을 붙여 실행했다면 출력된 LAN 주소(토큰 포함)와 주의 문구를 빠짐없이 전달하고, 이 주소는 아는 사람 누구나 읽기 전용으로 볼 수 있다고 알려라. 세션 내용(프롬프트, 명령어 인자, 출력)은 읽지 않고 프로젝트, 세션 제목, 시각, 도구 이름만 보여준다는 것과, 종료하려면 `node "${CLAUDE_PLUGIN_ROOT}/scripts/live.mjs" --stop`을 실행하면 된다는 것을 한 줄로 덧붙여라. 그 외 작업은 하지 마라.
