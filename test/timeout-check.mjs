// @ts-check
/**
 * test/timeout-check.mjs —— 单独验证 check_command 的超时分支（跑法：`node test/timeout-check.mjs`）。
 *
 * 为什么单独一个文件：真实超时是 120 秒，塞进 selftest 会让每次回归多花两分钟。
 * 做法是「把 index.js 复制到临时目录 → 只把 CHECK_TIMEOUT_MS 常量改小 → 用那个副本跑一次必挂的命令」，
 * 断言四件事：① 600ms 左右就返回（不是等 120 秒）② check.error === 'timeout'
 * ③ 编辑本身已成功（超时不影响已落的编辑）④ 进程能自然退出（没有残留管道/定时器把事件循环钉住）。
 *
 * 第 ④ 条是必须的：Windows 上 child.kill() 只杀 cmd.exe，孙子进程继续持着 stdout/stderr，
 * 'close' 永不触发 → Promise 永不 resolve → 工具调用挂死。这个文件就是那条修复的回归门。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 孙子进程的唯一标记：让「它还在不在」可以在进程表里被精确问到，不靠猜。 */
const MARKER = 'EAC_TIMEOUT_PROBE_7f3c'

/**
 * 数「命令行里带这个标记的 node 进程」有几个。
 * 为什么要问操作系统而不是看 Node 侧对象：`child.killed === true` 只表示信号发出去了，
 * 完全不说明那个真实进程死活 —— 而 Windows 上「只杀 cmd.exe、孙子还活着」正是被这一点掩盖的。
 */
function countProcessesByMarker(marker) {
  const script = [
    '$n = (Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'"',
    `  | Where-Object { $_.CommandLine -like '*${marker}*' } | Measure-Object).Count;`,
    'Write-Output $n',
  ].join(' ')
  const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
  return Number.parseInt(out.trim(), 10) || 0
}

const PLUGIN_DIR = path.join(import.meta.dirname, '..')
const TIMEOUT_OVERRIDE_MS = 600
/** 断言「确实是被超时打断的」而不是被别的什么拖住：上限给得很宽，只为抓挂死。 */
const HARD_LIMIT_MS = 15000

let pass = 0
let fail = 0
let seq = 0

async function t(name, fn) {
  seq += 1
  try {
    await fn()
    pass += 1
    console.log(`ok ${seq} - ${name}`)
  } catch (err) {
    fail += 1
    console.log(`not ok ${seq} - ${name}`)
    for (const line of String((err && err.message) || err).split('\n')) console.log(`  # ${line}`)
  }
}

const work = mkdtempSync(path.join(tmpdir(), 'edit-and-check-timeout-'))

try {
  // 1) 复制一份 index.js，把超时常量改小
  const src = readFileSync(path.join(PLUGIN_DIR, 'index.js'), 'utf8')
  const anchor = 'const CHECK_TIMEOUT_MS = 120000'
  assert.ok(src.includes(anchor), `源码里找不到超时常量锚点：${anchor}`)
  const patched = src.replace(anchor, `const CHECK_TIMEOUT_MS = ${TIMEOUT_OVERRIDE_MS}`)
  const patchedPath = path.join(work, 'index.mjs')
  writeFileSync(patchedPath, patched, 'utf8')
  writeFileSync(
    path.join(work, 'package.json'),
    JSON.stringify({ name: 'timeout-probe', type: 'module', private: true }),
    'utf8',
  )

  const mod = await import(pathToFileURL(patchedPath).href)

  await t(`1. 必挂命令在 ${TIMEOUT_OVERRIDE_MS}ms 后被判定超时（error === 'timeout'）`, async () => {
    const file = path.join(work, 'target.txt')
    writeFileSync(file, 'hello\n', 'utf8')

    const startedAt = Date.now()
    const r = await mod.editAndCheck({
      file_path: file,
      old_string: 'hello',
      new_string: 'world',
      // 睡 200 秒：正常路径下必然超时
      check_command: 'node -e "setTimeout(()=>{}, 200000)"',
    })
    const elapsed = Date.now() - startedAt

    assert.equal(r.edit.ok, true, `编辑本身应成功：${JSON.stringify(r.edit)}`)
    assert.equal(readFileSync(file, 'utf8'), 'world\n', '编辑成果应已落盘（超时不影响它）')
    assert.ok(r.check, '应带 check 字段')
    assert.equal(r.check.error, 'timeout', `应如实报超时，实际：${JSON.stringify(r.check)}`)
    assert.equal(r.check.ok, false)
    assert.equal(typeof r.check.durationMs, 'number')
    assert.ok(elapsed < HARD_LIMIT_MS, `超时判定耗时 ${elapsed}ms，超过硬上限 ${HARD_LIMIT_MS}ms（疑似挂死）`)
    assert.ok(
      elapsed >= TIMEOUT_OVERRIDE_MS - 50,
      `耗时 ${elapsed}ms 早于设定超时 ${TIMEOUT_OVERRIDE_MS}ms，说明不是走超时分支`,
    )
    console.log(`  # 实测耗时 ${elapsed}ms（超时设定 ${TIMEOUT_OVERRIDE_MS}ms）`)
  })

  await t('2. 超时后仍能正常跑下一次调用（无残留状态）', async () => {
    const file = path.join(work, 'target2.txt')
    writeFileSync(file, 'one\n', 'utf8')
    const r = await mod.editAndCheck({
      file_path: file,
      old_string: 'one',
      new_string: 'two',
      check_command: 'node --check package.json 2>&1 || true',
      cwd: work,
    })
    assert.equal(r.edit.ok, true)
    assert.ok(r.check, '第二次调用仍应跑 check')
    assert.equal(typeof r.check.durationMs, 'number')
  })

  // 第三条是这一整个文件存在的原因：Windows 上「只杀 cmd.exe」会留下孙子进程。
  // 判据不看退出码，而是去问操作系统「那个带标记的 node 还在不在」。
  await t('3. 超时后孙子进程真的没了（不留孤儿进程）', async () => {
    const file = path.join(work, 'target3.txt')
    writeFileSync(file, 'alpha\n', 'utf8')
    const r = await mod.editAndCheck({
      file_path: file,
      old_string: 'alpha',
      new_string: 'beta',
      // 带唯一标记，便于在进程表里精确定位它是本次的孙子
      check_command: `node -e "setTimeout(()=>{}, 200000)/*${MARKER}*/"`,
    })
    assert.equal(r.check?.error, 'timeout', `应先判定超时，实际：${JSON.stringify(r.check)}`)

    if (process.platform !== 'win32') {
      console.log('  # 非 Windows：孤儿进程判据只在 win32 上量（POSIX 上 SIGKILL 直接对进程组生效）')
      return
    }
    await new Promise((r2) => setTimeout(r2, 1200))
    const count = countProcessesByMarker(MARKER)
    assert.equal(count, 0, `还有 ${count} 个带标记的 node 进程活着 —— 超时只杀了 cmd.exe，孙子进程成了孤儿`)
  })
} finally {
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    // 清理失败不影响判定
  }
  const total = pass + fail
  console.log('')
  console.log(`${pass}/${total} passed`)
  // 必须显式 exit：本文件专门验证「不留残留句柄」，自己更不能靠事件循环自然退出
  process.exit(fail > 0 ? 1 : 0)
}
