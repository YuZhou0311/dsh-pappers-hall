#!/bin/bash
# Pappers-Hall 开关与原生 DSH 影响检查（Lead 使用；只读探测，不修改任何状态）。
#
# 用法: bash scripts/check-native.sh [enabled|disabled]
#   enabled  : 期望插件 API 200、客户端 bundle 在 boot 图中、原生 GUI 200
#   disabled : 期望插件 API 404、客户端 bundle 不在 boot 图中、原生 GUI 仍 200
#
# 开关本身请用内置 plugin_manager 工具（set_plugin）或插件管理页完成，本脚本不代劳。
set -u
BASE="${PAPPERS_BASE:-http://127.0.0.1:54731}"
EXPECT="${1:-enabled}"
fails=0
pass() { echo "PASS $1${2:+ — $2}"; }
fail() { echo "FAIL $1${2:+ — $2}"; fails=$((fails+1)); }

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# 1) 原生 Web GUI 必须始终可用
gui=$(code "$BASE/")
if [ "$gui" = "200" ]; then pass "native GUI index" "$gui"; else fail "native GUI index" "$gui"; fi

# 2) 原生插件管理页/静态资源（前端 dist）仍可加载
asset=$(code "$BASE/plugins/@deepseek-ai/dsh-client-ui-plugin-manager/client.js")
if [ "$asset" = "200" ] || [ "$asset" = "304" ]; then pass "native client bundle route" "$asset"; else fail "native client bundle route" "$asset"; fi

# 3) 插件 HTTP API
api=$(code -X POST "$BASE/pappers-hall/api" -H 'content-type: application/json' -d '{"method":"status","params":{}}')
if [ "$EXPECT" = "enabled" ]; then
  if [ "$api" = "200" ]; then pass "pappers-hall api" "$api"; else fail "pappers-hall api" "$api"; fi
else
  if [ "$api" = "404" ]; then pass "pappers-hall api removed" "$api"; else fail "pappers-hall api removed" "$api"; fi
fi

# 4) 客户端 bundle 是否在页面 boot 图中（启用时应在；停用时不应在）
boot=$(curl -s "$BASE/")
if printf '%s' "$boot" | grep -q 'dsh-pappers-hall'; then
  if [ "$EXPECT" = "enabled" ]; then pass "client module in boot graph"; else fail "client module still in boot graph"; fi
else
  if [ "$EXPECT" = "disabled" ]; then pass "client module removed from boot graph"; else fail "client module missing from boot graph"; fi
fi

# 5) 状态 JSON（启用时）与降级项
if [ "$EXPECT" = "enabled" ]; then
  body=$(curl -s -X POST "$BASE/pappers-hall/api" -H 'content-type: application/json' -d '{"method":"status","params":{}}')
  if printf '%s' "$body" | grep -q '"ok":true'; then pass "status payload" "$(printf '%s' "$body" | head -c 160)"; else fail "status payload" "$(printf '%s' "$body" | head -c 160)"; fi
fi

# 6) index.html 无插件引起的脚本错误标记（boot 图 JSON 可解析）
if printf '%s' "$boot" | grep -q '__DSH_BOOT__'; then pass "boot payload present"; else fail "boot payload present"; fi

echo
if [ "$fails" -eq 0 ]; then echo "NATIVE CHECK PASS ($EXPECT)"; else echo "NATIVE CHECK FAIL ($EXPECT): $fails"; fi
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
