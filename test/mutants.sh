#!/usr/bin/env bash
# 变异验证：把插件复制到临时目录，注入四种退化，确认对应测试会变红。
# 目的：证明这些断言不是空跑（「改坏它，测试会不会红」是唯一能区分「真有守卫」与「看起来有守卫」的办法）。
set -u
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK=$(mktemp -d)
FAILED=0

prep() {
  rm -rf "$WORK/plug"
  mkdir -p "$WORK/plug/test"
  cp "$SRC/index.js" "$WORK/plug/index.js"
  cp "$SRC/package.json" "$WORK/plug/package.json"
  cp "$SRC/test/selftest.mjs" "$WORK/plug/test/selftest.mjs"
  cp "$SRC/test/timeout-check.mjs" "$WORK/plug/test/timeout-check.mjs"
}

report() {
  local label="$1" log="$2" expect="$3"
  local bad
  bad=$(grep -c '^not ok' "$log" || true)
  if [ "$bad" -ge 1 ] && grep -q "$expect" "$log"; then
    echo "PASS-MUTANT  [$label] 变红 $bad 条，命中预期：$expect"
    grep '^not ok' "$log" | sed 's/^/    /'
  else
    echo "FAIL-MUTANT  [$label] 期望变红但没有（not ok=$bad，expect=$expect）"
    FAILED=1
  fi
}

# 变异 A：误写 export default apply（Loader 会丢掉 name/inject）
prep
printf '\nexport default apply\n' >> "$WORK/plug/index.js"
( cd "$WORK/plug" && node test/selftest.mjs > "$WORK/a.log" 2>&1 )
report "A export default apply" "$WORK/a.log" "1\. export default 事故守卫"

# 变异 B：编辑失败后仍执行 check_command（去掉提前 return）
prep
python - "$WORK/plug/index.js" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
old = "    if (!edit.ok) return { edit }"
assert old in s, 'anchor B not found'
s = s.replace(old, "    if (!edit.ok && !a.check_command) return { edit }")
open(p, 'w', encoding='utf-8', newline='').write(s)
PY
( cd "$WORK/plug" && node test/selftest.mjs > "$WORK/b.log" 2>&1 )
report "B 编辑失败仍跑 check" "$WORK/b.log" "7\. 用例 5/6 的副作用"

# 变异 C：写回时不恢复原行尾（CRLF 被抹成 LF）
prep
python - "$WORK/plug/index.js" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
old = "  return eol === '\\r\\n' ? text.replace(/\\n/g, '\\r\\n') : text"
assert old in s, 'anchor C not found'
s = s.replace(old, "  return text")
open(p, 'w', encoding='utf-8', newline='').write(s)
PY
( cd "$WORK/plug" && node test/selftest.mjs > "$WORK/c.log" 2>&1 )
report "C 行尾不还原" "$WORK/c.log" "9\. 全 CRLF"

# 变异 D：退回「超时只 kill shell、不杀进程树、也不立刻 resolve」的老写法
#   → Windows 上 cmd.exe 被杀但孙子 node.exe 活着、'close' 永不触发，整次调用挂死。
#   这条必须用 shell timeout 兜住，否则沙箱自己会被挂住的进程拖死。
prep
python - "$WORK/plug/index.js" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
old = "      await killTree(child)"
assert old in s, 'anchor D not found'
s = s.replace(old, "      try { child.kill('SIGKILL') } catch {}")
open(p, 'w', encoding='utf-8', newline='').write(s)
PY
( cd "$WORK/plug" && timeout 40 node test/timeout-check.mjs > "$WORK/d.log" 2>&1 )
d_exit=$?
if [ "$d_exit" -ne 0 ] && ! grep -q '3/3 passed' "$WORK/d.log"; then
  echo "PASS-MUTANT  [D 超时不杀进程树] 变红/挂死被 timeout 兜住（exit=$d_exit）"
  sed 's/^/    /' "$WORK/d.log" | head -12
else
  echo "FAIL-MUTANT  [D 超时不杀进程树] 期望变红/挂死，实际 exit=$d_exit 且 3/3 全绿"
  FAILED=1
fi
# 变异 D 留下的孤儿进程自己清掉，别污染后面的观测
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'EAC_TIMEOUT_PROBE' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1 || true

rm -rf "$WORK"
echo
if [ "$FAILED" -eq 0 ]; then echo "ALL MUTANTS KILLED"; else echo "SOME MUTANTS SURVIVED"; fi
exit "$FAILED"
