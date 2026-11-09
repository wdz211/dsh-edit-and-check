// @ts-check
/**
 * test/selftest.mjs — `@local/dsh-edit-and-check` 的自测（自写 TAP 风格计数，**不用 node --test**）。
 *
 * 跑法：`node test/selftest.mjs`
 *
 * 覆盖 9 条（对应任务书行为规则）：
 *   1. export default 事故守卫：`m.default ?? m` 里必须有 inject
 *   2. stub ctx 跑 apply()：恰好注册 1 个工具、名字对、output.render 是函数、parameters.type === 'object'
 *   3. 真跑：改 a.mjs + node --check 成功
 *   4. 语法错误的 new_string：check.ok === false、exit !== 0、整体不抛异常
 *   5. old_string 命中 2 次且 replace_all=false：edit.ok === false、错误含命中次数、文件未变
 *   6. old_string 不存在：edit.ok === false、文件未变
 *   7. 用例 5/6 里带副作用的 check_command 从未被执行（ran.txt 不存在）
 *   8. 无 check_command 时返回体没有 check 字段
 *   9. CRLF 文件替换后仍是全 CRLF（CRLF 数不变、裸 LF 数仍为 0）
 *
 * 末尾必须 process.exit(failed ? 1 : 0)：超时定时器/句柄若没清干净，不 exit 会挂住。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as m from '../index.js'

// ---------------------------------------------------------------------------
// 极小 TAP 计数器
// ---------------------------------------------------------------------------

let pass = 0
let fail = 0
let seq = 0
const failures = []

async function t(name, fn) {
  seq += 1
  try {
    await fn()
    pass += 1
    console.log(`ok ${seq} - ${name}`)
  } catch (err) {
    fail += 1
    const msg = String((err && err.message) || err)
    failures.push({ seq, name, msg })
    console.log(`not ok ${seq} - ${name}`)
    for (const line of msg.split('\n')) console.log(`  # ${line}`)
  }
}

/** 统计「裸 LF」（不是 CRLF 的一部分）。 */
function countLfOnly(text) {
  return (text.match(/(?<!\r)\n/g) || []).length
}

function countCrlf(text) {
  return (text.match(/\r\n/g) || []).length
}

// ---------------------------------------------------------------------------
// 预备：目录 + 工具函数（从 stub ctx 收集到的注册项里取）
// ---------------------------------------------------------------------------

const tmp = mkdtempSync(path.join(tmpdir(), 'edit-and-check-selftest-'))
// 危险命令里的路径一律用正斜杠 + 相对路径：本机 tmpdir 含中文用户名，
// 走 cmd.exe 的命令行会有编码风险，所以 check_command 只写相对文件名（cwd 已指向 tmp）。
const RAN = path.join(tmp, 'ran.txt')
// 一个必然留副作用的 check_command：只要被执行就一定创建 ran.txt（cwd = tmp）。
const SIDE_EFFECT_CHECK = `node -e "require('fs').writeFileSync('ran.txt','1')"`

const registered = []
const fakeTools = {
  register(def) {
    registered.push(def)
  },
}
/** 任务书指定的 stub ctx 形状（effect/on 是 no-op，所以 apply 里必须直接 register）。 */
const ctx = {
  get(name, strict) {
    if (name === 'tools') return fakeTools
    return undefined
  },
  effect() {},
  on() {},
}

const u = m.default ?? m
// 这一句必须在 try/catch 里：若插件误写了 `export default apply`，`u` 就是那个裸函数，
// `u.apply(ctx)` 走的是 Function.prototype.apply，ctx 成了 thisArg、第一个参数变 undefined，
// apply 内部立刻抛 —— 不兜住的话整个测试文件在模块级崩掉，计数器根本跑不起来，
// 表现成「0 条 not ok」（看起来像通过了）。这正是用例 1 要抓的那个事故。
let applyError = null
try {
  u.apply(ctx)
} catch (err) {
  applyError = err
}

/** 已注册的工具（用例 2 断言它存在，后续用例直接用它）。 */
const tool = registered[0]
/** 统一调用口：execute(args, exec)。 */
const run = (args) => tool.execute(args, {})

let ok = false
try {
  await t('1. export default 事故守卫：m.default ?? m 里有 inject', () => {
    assert.equal('inject' in u, true, `unwrapExports 后的对象没有 inject —— 很可能写了 export default apply`)
    assert.deepEqual(u.inject, ['tools'])
  })

  await t('2. apply() 注册 1 个工具，形态合规', () => {
    assert.equal(applyError, null, `apply() 抛了：${applyError && applyError.message}`)
    assert.equal(registered.length, 1, `期望注册 1 个工具，实际 ${registered.length}`)
    assert.equal(tool.name, 'edit_and_check')
    assert.equal(typeof tool.output?.render, 'function', 'output.render 必须是函数（缺了 tools.register 会 TypeError）')
    assert.equal(tool.parameters.type, 'object', 'parameters 根类型必须是 object')
    assert.deepEqual(tool.parameters.required, ['file_path', 'old_string', 'new_string'])
    assert.equal(typeof tool.execute, 'function')
    // render 的真实契约（2026-10-26 真机踩坑后补的）：调用形态是 render(args, value)，
    // 返回值必须是 content blocks 数组，它会被直接当作 result.content 使用。
    // 旧断言只查 typeof === 'string'，把 bug 当成了规格，所以真机一调就报
    // "content.some is not a function"。以下三条必须能区分新旧实现。
    const okBody = { edit: { ok: true, path: 'x', replaced: 1 }, check: { ok: true, exit: 0, durationMs: 5, stdout: 'fine' } }
    const rendered = tool.output.render({ file_path: 'x' }, okBody)
    assert.equal(Array.isArray(rendered), true, 'render 必须返回数组（DSH 会直接拿它当 result.content）')
    assert.equal(rendered.length > 0, true, 'render 返回的 content 不能为空')
    // 复刻 @deepseek-ai/dsh-tools/lib/index.js:1384 的那句判断——它就是要 content.some
    assert.equal(
      rendered.some((block) => block.type === 'image'),
      false,
      'content.some 必须可调用（正是这行在真机上炸的）',
    )
    assert.equal(typeof rendered[0].text, 'string', '每个 content block 必须有 text 字符串')
    assert.match(rendered[0].text, /已编辑/, '成功体必须体现编辑结果')

    // 参数位置守卫：结果只在第二个参数位。若实现又把第一个参数当结果读，
    // 传进来的只有 args（没有 edit 字段），就会渲染成「编辑失败：未知错误」。
    const argsOnly = tool.output.render({ file_path: 'x', old_string: 'a', new_string: 'b' }, undefined)
    assert.match(argsOnly[0].text, /编辑失败/, 'value 为空时应走失败分支，而不是把 args 当结果')
    assert.doesNotMatch(argsOnly[0].text, /已编辑/, '绝不能把第一个参数（args）当成执行结果')

    const failBody = { edit: { ok: false, error: 'boom' } }
    const failRendered = tool.output.render({ file_path: 'x' }, failBody)
    assert.equal(Array.isArray(failRendered), true)
    assert.match(failRendered[0].text, /boom/, '失败体必须带上错误原因')
  })

  // ---- 用例 3：真跑一次成功链路 ----
  const aPath = path.join(tmp, 'a.mjs')
  writeFileSync(aPath, 'export const x = 1\n', 'utf8')

  await t('3. 改文件 + node --check 成功', async () => {
    const r = await run({
      file_path: aPath,
      old_string: 'export const x = 1',
      new_string: 'export const x = 2',
      check_command: 'node --check a.mjs',
      cwd: tmp,
    })
    assert.equal(r.edit.ok, true, `edit 应成功，实际：${JSON.stringify(r.edit)}`)
    assert.equal(r.edit.replaced, 1)
    assert.equal(r.edit.path, aPath)
    assert.ok(r.check, '应带 check 字段')
    assert.equal(r.check.ok, true, `check 应通过，实际：${JSON.stringify(r.check)}`)
    assert.equal(r.check.exit, 0)
    assert.equal(typeof r.check.durationMs, 'number')
    assert.equal(readFileSync(aPath, 'utf8'), 'export const x = 2\n', '文件内容应已改变')
  })

  // ---- 用例 4：校验失败不算工具失败，且不抛 ----
  await t('4. 语法错误的 new_string：check.ok=false、exit!==0、整体不抛', async () => {
    let r
    await assert.doesNotReject(async () => {
      r = await run({
        file_path: aPath,
        old_string: 'export const x = 2',
        new_string: 'export const x = ;',
        check_command: 'node --check a.mjs',
        cwd: tmp,
      })
    }, '整个调用不得抛异常（fail-open）')
    assert.equal(r.edit.ok, true, '编辑本身应成功')
    assert.equal(r.check.ok, false, 'node --check 应报失败')
    assert.notEqual(r.check.exit, 0)
    assert.match(readFileSync(aPath, 'utf8'), /export const x = ;/, '文件应已被写入（编辑成功）')
    // 复原成合法内容，避免影响后面用例
    writeFileSync(aPath, 'export const x = 2\n', 'utf8')
  })

  // ---- 用例 5 + 7：多次命中的一侧 ----
  const dupPath = path.join(tmp, 'dup.txt')
  const dupOriginal = 'aaa\nTARGET\nbbb\nTARGET\nccc\n'
  writeFileSync(dupPath, dupOriginal, 'utf8')

  await t('5. old_string 命中 2 次且 replace_all=false：edit.ok=false + 错误含命中次数 + 文件未变', async () => {
    const r = await run({
      file_path: dupPath,
      old_string: 'TARGET',
      new_string: 'CHANGED',
      check_command: SIDE_EFFECT_CHECK,
      cwd: tmp,
    })
    assert.equal(r.edit.ok, false, '多次命中且未开 replace_all 应失败')
    assert.match(String(r.edit.error), /2/, `错误信息应含命中次数 2，实际：${r.edit.error}`)
    assert.match(String(r.edit.error), /命中/, '错误信息应说明命中次数')
    assert.equal(r.check, undefined, '编辑失败时不得执行 check_command')
    assert.equal(readFileSync(dupPath, 'utf8'), dupOriginal, '文件不得被改动')
  })

  // ---- 用例 5 的补充：replace_all=true 时应当成功（证明上面不是"永远失败") ----
  await t('5b. 同样的两处命中、replace_all=true 时成功替换全部', async () => {
    const r = await run({
      file_path: dupPath,
      old_string: 'TARGET',
      new_string: 'CHANGED',
      replace_all: true,
    })
    assert.equal(r.edit.ok, true, `replace_all 应成功，实际：${JSON.stringify(r.edit)}`)
    assert.equal(r.edit.replaced, 2)
    assert.equal(readFileSync(dupPath, 'utf8'), 'aaa\nCHANGED\nbbb\nCHANGED\nccc\n')
  })

  // ---- 用例 6 + 7：未命中的一侧 ----
  const missPath = path.join(tmp, 'miss.txt')
  const missOriginal = 'hello\nworld\n'
  writeFileSync(missPath, missOriginal, 'utf8')

  await t('6. old_string 不存在：edit.ok=false、错误含"未找到"、文件未变', async () => {
    const r = await run({
      file_path: missPath,
      old_string: 'NOT_PRESENT_anywhere',
      new_string: 'x',
      check_command: SIDE_EFFECT_CHECK,
      cwd: tmp,
    })
    assert.equal(r.edit.ok, false)
    assert.match(String(r.edit.error), /未找到/, `错误信息应说明未找到，实际：${r.edit.error}`)
    assert.equal(r.check, undefined, '编辑失败时不得执行 check_command')
    assert.equal(readFileSync(missPath, 'utf8'), missOriginal, '文件不得被改动')
  })

  // ---- 用例 7：副作用证据（放在 5/6 之后统一断言）----
  await t('7. 用例 5/6 的副作用 check_command 从未被执行（ran.txt 不存在）', () => {
    assert.equal(existsSync(RAN), false, `ran.txt 竟然存在 —— check_command 在编辑失败时仍被执行了`)
  })

  // ---- 用例 8：无 check_command 时没有 check 字段 ----
  await t('8. 不给 check_command 时返回体里没有 check 字段', async () => {
    const r = await run({
      file_path: missPath,
      old_string: 'world',
      new_string: 'WORLD',
    })
    assert.equal(r.edit.ok, true)
    assert.equal('check' in r, false, `不该有 check 字段，实际键：${Object.keys(r).join(',')}`)
    assert.equal(readFileSync(missPath, 'utf8'), 'hello\nWORLD\n')
  })

  // ---- 用例 9：CRLF 保持 ----
  await t('9. 全 CRLF 文件替换后仍是全 CRLF', async () => {
    const crlfPath = path.join(tmp, 'crlf.txt')
    const crlfOriginal = 'line1\r\nline2\r\nline3\r\n'
    writeFileSync(crlfPath, crlfOriginal, 'utf8')
    const beforeCrlf = countCrlf(crlfOriginal)
    const beforeLfOnly = countLfOnly(crlfOriginal)
    assert.equal(beforeCrlf, 3)
    assert.equal(beforeLfOnly, 0)

    const r = await run({
      file_path: crlfPath,
      old_string: 'line2',
      new_string: 'LINE2',
    })
    assert.equal(r.edit.ok, true, `edit 应成功，实际：${JSON.stringify(r.edit)}`)

    const after = readFileSync(crlfPath, 'utf8')
    assert.equal(after, 'line1\r\nLINE2\r\nline3\r\n', '内容应为 CRLF 版本')
    assert.equal(countCrlf(after), beforeCrlf, `CRLF 数应保持 ${beforeCrlf}，实际 ${countCrlf(after)}`)
    assert.equal(countLfOnly(after), 0, `不应出现裸 LF，实际 ${countLfOnly(after)}`)
  })

  // ---- 规则 4：文件不存在 → 失败且不跑 check ----
  await t('10. 文件不存在：edit.ok=false + 说明不存在 + 不跑 check_command', async () => {
    const ghost = path.join(tmp, 'no-such-file.txt')
    assert.equal(existsSync(ghost), false)
    const r = await run({
      file_path: ghost,
      old_string: 'a',
      new_string: 'b',
      check_command: SIDE_EFFECT_CHECK,
      cwd: tmp,
    })
    assert.equal(r.edit.ok, false)
    assert.match(String(r.edit.error), /不存在/, `错误信息应说明文件不存在，实际：${r.edit.error}`)
    assert.equal(r.check, undefined, '文件不存在时不得执行 check_command')
    assert.equal(existsSync(ghost), false, '不得凭空创建文件')
    assert.equal(existsSync(RAN), false, 'check_command 不得被执行（ran.txt 不该出现）')
  })

  // ---- 规则 8：相对 file_path 以 cwd 为基准 ----
  await t('11. 相对路径 + cwd：按 cwd 解析，不落到 process.cwd()', async () => {
    const relPath = 'relative-target.txt'
    writeFileSync(path.join(tmp, relPath), 'before\n', 'utf8')
    const r = await run({
      file_path: relPath,
      old_string: 'before',
      new_string: 'after',
      cwd: tmp,
    })
    assert.equal(r.edit.ok, true, `相对路径应被解析成功，实际：${JSON.stringify(r.edit)}`)
    // 断言解析结果确实指向 tmp 下的文件，而不是 process.cwd() 下的同名文件
    assert.equal(r.edit.path, path.join(tmp, relPath))
    assert.equal(readFileSync(path.join(tmp, relPath), 'utf8'), 'after\n')
    assert.equal(existsSync(path.join(process.cwd(), relPath)), false, '不应在 process.cwd() 下留下文件')
  })

  // ---- 规则 6：末尾换行与原文件一致 ----
  await t('12. 原文有末尾换行 → 替换后仍有（不会把末行吞掉）', async () => {
    const tailPath = path.join(tmp, 'tail.txt')
    writeFileSync(tailPath, 'first\nlast\n', 'utf8')
    const r = await run({
      file_path: tailPath,
      old_string: 'last',
      new_string: 'LAST',
    })
    assert.equal(r.edit.ok, true)
    const after = readFileSync(tailPath, 'utf8')
    assert.equal(after, 'first\nLAST\n', `末尾换行应保持，实际 ${JSON.stringify(after)}`)
  })

  // ---- 规则 1：真正的 IO 异常也只返回结构化错误（不抛）----
  await t('14. file_path 是目录（EISDIR）：不抛、返回读取失败', async () => {
    let r
    await assert.doesNotReject(async () => {
      r = await run({ file_path: tmp, old_string: 'a', new_string: 'b' })
    }, '读文件抛 EISDIR 时不得把异常漏给调用方')
    assert.equal(r.edit.ok, false)
    assert.match(String(r.edit.error), /读取文件失败/, `错误应是结构化文本，实际：${r.edit.error}`)
  })

  // ---- 附加哨兵：fail-open 兜底（参数非法也不抛）----
  await t('15. 参数完全非法（undefined）也不抛，返回结构化错误', async () => {
    let r
    await assert.doesNotReject(async () => {
      r = await run(undefined)
    })
    assert.equal(r.edit.ok, false)
    assert.equal(typeof r.edit.error, 'string')
  })

  ok = true
} finally {
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    // 清理失败不影响判定
  }
  const total = pass + fail
  console.log('')
  if (fail > 0) {
    console.log(`${total}/${total} 用例中失败 ${fail} 个`)
  }
  console.log(`${pass}/${total} passed`)
  // 必须显式 exit：不留挂住的句柄/定时器
  process.exit(fail > 0 ? 1 : 0)
}

// 理论上走不到（finally 里已 exit）；留着防止未来改动意外落到这里后静默通过。
if (!ok) process.exit(1)
