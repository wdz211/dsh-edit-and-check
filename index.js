/**
 * @local/dsh-edit-and-check — 把「edit 一次 + bash 校验一次」两次往返融成一次工具调用。
 *
 * 形态硬约束（违反会导致激活失败，逐条对应任务书）：
 *   1. 只用具名导出（name / inject / apply），**绝不写 `export default apply`** ——
 *      Loader 的 unwrapExports() 会优先取 default，若 default 是裸函数，name/inject 全丢，
 *      插件会在服务未就绪时被 apply 并报「缺少服务」。
 *   2. 启动期取服务用 `ctx.get('tools', false)`；属性访问（ctx.tools）在 inactive context 会抛
 *      `cannot get required service in inactive context`，默认 get 又因 fiber.state !== 2 返回 undefined。
 *   3. 不写会话事件、不留定时器（check 的超时定时器在子进程 close/timeout 时立刻 clear）、不改 DSH 配置。
 *   4. 全 ESM，零依赖（只用 node: 内置模块）。
 *
 * fail-open：`execute` 内部顶层 try/catch，任何异常都变成 `{ edit: { ok:false, error } }` 返回，
 * 绝不把异常抛给调用方（抛出去等于把一次工具调用变成一次会话级错误）。
 */

import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 插件身份（Loader 用它与 patch 行对应）。 */
export const name = 'dsh-edit-and-check'

/** 硬依赖只有 tools：没有它本插件没有任何有意义的半可用状态。 */
export const inject = ['tools']

/** 工具名。 */
export const TOOL_NAME = 'edit_and_check'

/** check_command 的超时（毫秒）。到点 kill 并返回 error:'timeout'。 */
const CHECK_TIMEOUT_MS = 120000

/** stdout / stderr 各保留末尾多少字符（别把几百 KB 输出整份塞回上下文）。 */
const OUTPUT_TAIL = 4000

/** render 里给模型看的输出片段上限。 */
const RENDER_TAIL = 800

/** 工具描述：短、点名使用时机、点名与内置 edit 的分工、点名相对路径陷阱。 */
const DESCRIPTION = [
  '一次性完成「文件局部替换 + 立刻跑校验命令」，把两步融成一次调用、省一次来回。',
  '当你刚改完一个文件、紧接着就要跑校验（node --check / 测试 / lint / grep 刚改的东西）时用这个工具；纯编辑、不需要校验时用内置 edit 即可。',
  'old_string 必须唯一命中（否则传 replace_all=true）；未命中或命中多次时不写文件、也不执行校验。',
  '路径按内置 edit 语义解析，但相对路径以 cwd（若给）或 process.cwd() 为基准 —— Desktop 下 process.cwd() 可能是 C:\\Windows\\System32，所以相对路径请给绝对路径或同时传 cwd。',
].join('')

const PARAMETERS = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description: '要改的文件：workspace 相对路径或绝对路径。语义同内置 edit。',
    },
    old_string: {
      type: 'string',
      description: '要被替换的字面文本。replace_all 不为 true 时必须唯一命中。',
    },
    new_string: {
      type: 'string',
      description: '替换文本；空串表示删除这段文本。',
    },
    replace_all: {
      type: 'boolean',
      description: '是否替换全部命中（默认 false，此时 old_string 必须唯一）。',
    },
    check_command: {
      type: 'string',
      description: '编辑成功后立刻执行的校验命令（shell 语法，可用 &&）。不给就不执行任何命令。',
    },
    cwd: {
      type: 'string',
      description: 'check_command 的执行目录；缺省为被编辑文件所在目录。也给相对 file_path 提供解析基准。',
    },
  },
  required: ['file_path', 'old_string', 'new_string'],
  additionalProperties: false,
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    edit: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        path: { type: 'string' },
        replaced: { type: 'number' },
        error: { type: 'string' },
      },
      required: ['ok'],
    },
    check: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        exit: { type: 'number' },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
        durationMs: { type: 'number' },
        error: { type: 'string' },
      },
      required: ['ok'],
    },
  },
  required: ['edit'],
  additionalProperties: false,
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 错误对象 → 一行文本（失败一律返回结构化字符串，不甩异常对象）。 */
function errText(err) {
  if (err === null || err === undefined) return 'unknown error'
  if (typeof err === 'string') return err
  if (typeof err.message === 'string' && err.message.length > 0) return err.message
  try {
    return String(err)
  } catch {
    return 'unknown error'
  }
}

/** 取末尾 n 个字符（超长输出只留尾巴，头部通常是刷屏的进度条）。 */
function tail(text, n) {
  const s = typeof text === 'string' ? text : ''
  return s.length > n ? s.slice(s.length - n) : s
}

/**
 * 日志口。真实运行时 ctx.logger 一定在；stub ctx / 极早期上下文下取不到就退化成无声，
 * 而不是让「日志对象不存在」把激活搞崩。激活期这一行不打在 debug 开关后面（否则全程静默）。
 */
function safeLogger(ctx) {
  try {
    const logger = ctx ? ctx.logger : undefined
    if (logger && typeof logger.info === 'function') return logger
  } catch {
    // inactive context 下属性访问可能抛，属预期。
  }
  return { info() {}, warn() {}, debug() {}, error() {} }
}

/** 检测文件主导行尾：CRLF 数多于「裸 LF」数就按 CRLF 处理，否则 LF。 */
function detectEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length
  const lfOnly = (text.match(/(?<!\r)\n/g) || []).length
  return crlf > lfOnly ? '\r\n' : '\n'
}

/** 统一到 LF 再做匹配（避免 old_string 写 \n 而文件是 CRLF 时"明明在却找不到"）。 */
function toLf(text) {
  return text.replace(/\r\n/g, '\n')
}

/** 按原文件主导行尾写回。入参必须是已归一化成 LF 的文本。 */
function applyEol(text, eol) {
  return eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text
}

/** 非重叠命中次数。 */
function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0
  let count = 0
  let idx = 0
  for (;;) {
    idx = haystack.indexOf(needle, idx)
    if (idx === -1) return count
    count += 1
    idx += needle.length
  }
}

// ---------------------------------------------------------------------------
// 两个阶段
// ---------------------------------------------------------------------------

/**
 * 阶段一：读全文 → 校验命中 → 替换 → 按原行尾风格写回。
 * 未命中 / 命中多次都在写盘之前返回，所以失败时文件一个字节都不动。
 */
async function applyEdit({ filePath, oldString, newString, replaceAll }) {
  const absPath = filePath

  let raw
  try {
    raw = await readFile(absPath, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: false, path: absPath, error: `文件不存在：${absPath}` }
    }
    return { ok: false, path: absPath, error: `读取文件失败：${errText(err)}` }
  }

  if (typeof oldString !== 'string' || oldString.length === 0) {
    return { ok: false, path: absPath, error: 'old_string 不能为空' }
  }

  const eol = detectEol(raw)
  const normalized = toLf(raw)
  const needle = toLf(oldString)
  const replacement = toLf(typeof newString === 'string' ? newString : '')

  const hits = countOccurrences(normalized, needle)
  if (hits === 0) {
    return { ok: false, path: absPath, error: `未找到 old_string（命中 0 次）：文件 ${absPath} 未改动` }
  }
  if (hits > 1 && replaceAll !== true) {
    return {
      ok: false,
      path: absPath,
      error: `old_string 命中 ${hits} 次，replace_all 不为 true 时不做替换：文件 ${absPath} 未改动`,
    }
  }

  const hadTrailingNewline = /\n$/.test(normalized)
  let next = replaceAll === true
    ? normalized.split(needle).join(replacement)
    : normalized.slice(0, normalized.indexOf(needle)) + replacement + normalized.slice(normalized.indexOf(needle) + needle.length)

  // 「末尾有没有换行」跟原文件保持一致。
  // 只做"补回"这一侧：原文有末尾换行而替换后没有，就补一个；
  // 反方向（原文没有、替换后多了）不强行删——那可能是用户有意 add 的尾行，删了反而丢了语义。
  if (hadTrailingNewline && !/\n$/.test(next)) next += '\n'

  const out = applyEol(next, eol)
  if (out === raw) {
    // 替换结果与原文逐字节相同：不写盘（避免把 mtime 改掉，也让调用方看得出"实际没变"）。
    return { ok: true, path: absPath, replaced: 0 }
  }

  try {
    await writeFile(absPath, out, 'utf8')
  } catch (err) {
    return { ok: false, path: absPath, error: `写入文件失败：${errText(err)}` }
  }

  return { ok: true, path: absPath, replaced: replaceAll === true ? hits : 1 }
}

/**
 * 杀掉一个 shell 启动的整棵进程树，**返回 Promise，杀完（或到护栏上限）才 resolve**。
 *
 * 为什么必须等：`taskkill` 是异步子进程，如果调用方（尤其是会 process.exit 的进程、
 * 或紧接着要做下一件事的工具调用）在它跑完之前就走人，taskkill 可能根本没执行到，
 * 孙子进程就留下来 —— 实测踩过：超时返回后立刻退出，`node -e "setTimeout(...)"` 的孙子进程成了孤儿。
 *
 * 为什么 Windows 必须走 taskkill /T：**`child.kill()` 只杀 cmd.exe**，它启动的子进程继续活着
 * 并持着 stdout/stderr 管道，于是 'close' 永远不触发，Promise 永不 resolve —— 实测那次调用
 * 挂了 120 秒没返回。护栏上限保证 taskkill 自己出问题时也不会把工具调用钉死。
 */
function killTree(child, capMs = 2000) {
  return new Promise((resolve) => {
    let done = false
    const finishOnce = () => {
      if (done) return
      done = true
      clearTimeout(cap)
      resolve()
    }
    const cap = setTimeout(finishOnce, capMs)

    try {
      if (process.platform === 'win32' && typeof child.pid === 'number') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.on('error', () => {
          try {
            child.kill('SIGKILL')
          } catch {
            // 忽略
          }
          finishOnce()
        })
        killer.on('exit', finishOnce)
        return
      }
      child.kill('SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // 忽略
      }
    }
    finishOnce()
  })
}

/**
 * 阶段二：跑校验命令。
 * `shell: true` 在 Windows 下即 cmd.exe（支持 &&），在类 Unix 下走 /bin/sh。
 * 退出码非 0 **不算工具失败**：那是"校验发现了问题"，是正常结果，如实返回 exit/stderr 即可。
 */
function runCheck(command, cwd) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let child

    const finish = (payload) => {
      if (settled) return
      settled = true
      resolve({
        ...payload,
        stdout: tail(stdout, OUTPUT_TAIL),
        stderr: tail(stderr, OUTPUT_TAIL),
        durationMs: Date.now() - startedAt,
      })
    }

    try {
      child = spawn(command, { shell: true, cwd, windowsHide: true })
    } catch (err) {
      finish({ ok: false, error: errText(err) })
      return
    }

    // 定时器只在子进程还活着时存在：close / error / timeout 三条路都会清掉，不留悬挂定时器。
    const timer = setTimeout(async () => {
      timedOut = true
      // 先摘掉管道（不再往 stdout/stderr 里攒数据），再杀整棵树并且**等它真的死掉**，
      // 最后才 resolve —— 顺序不能换：早于 taskkill 返回就 resolve，孙子进程会成孤儿（实测踩过）。
      try {
        if (child.stdout) child.stdout.destroy()
        if (child.stderr) child.stderr.destroy()
      } catch {
        // 忽略
      }
      await killTree(child)
      try {
        if (typeof child.unref === 'function') child.unref()
      } catch {
        // 忽略
      }
      finish({ ok: false, error: 'timeout' })
    }, CHECK_TIMEOUT_MS)

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.stdout.on('error', () => {})
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.stderr.on('error', () => {})
    }

    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ ok: false, error: errText(err) })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        finish({ ok: false, ...(typeof code === 'number' ? { exit: code } : {}), error: 'timeout' })
        return
      }
      finish({ ok: code === 0, ...(typeof code === 'number' ? { exit: code } : {}) })
    })
  })
}

// ---------------------------------------------------------------------------
// 工具实现（导出的纯函数，便于测试直接调用）
// ---------------------------------------------------------------------------

/**
 * 工具执行体。**顶层 try/catch：任何异常都不得抛到调用方。**
 * @param {Record<string, unknown>} args
 * @returns {Promise<{edit: {ok: boolean, path?: string, replaced?: number, error?: string}, check?: object}>}
 */
export async function editAndCheck(args) {
  try {
    const a = args && typeof args === 'object' ? args : {}

    if (typeof a.file_path !== 'string' || a.file_path.length === 0) {
      return { edit: { ok: false, error: 'file_path 必填且必须是非空字符串' } }
    }
    if (typeof a.old_string !== 'string') {
      return { edit: { ok: false, error: 'old_string 必填且必须是字符串' } }
    }
    if (typeof a.new_string !== 'string') {
      return { edit: { ok: false, error: 'new_string 必填且必须是字符串（删除时传空串）' } }
    }

    const cwdArg = typeof a.cwd === 'string' && a.cwd.length > 0 ? a.cwd : undefined
    // 相对路径：先按 cwd（若给），否则按 process.cwd() 解析。
    // Desktop 下 process.cwd() 可能是 C:\Windows\System32 —— 所以工具描述里要求给绝对路径或同时给 cwd。
    const absPath = path.resolve(cwdArg ?? process.cwd(), a.file_path)

    const edit = await applyEdit({
      filePath: absPath,
      oldString: a.old_string,
      newString: a.new_string,
      replaceAll: a.replace_all === true,
    })

    if (!edit.ok) return { edit }

    const checkCommand = typeof a.check_command === 'string' ? a.check_command.trim() : ''
    if (checkCommand.length === 0) return { edit }

    // check 的执行目录：显式 cwd > 被编辑文件所在目录。
    const checkCwd = cwdArg ?? path.dirname(absPath)
    const check = await runCheck(checkCommand, checkCwd)
    return { edit, check }
  } catch (err) {
    // fail-open 兜底：结构化错误对象，绝不 throw。
    return { edit: { ok: false, error: errText(err) } }
  }
}

// ---------------------------------------------------------------------------
// output.render —— DSH tools.register 的硬要求（缺了直接 TypeError）
// ---------------------------------------------------------------------------

/**
 * 把 edit / check 摘要成人类可读的几行。
 *
 * output.render 的真实契约（2026-10-26 逐行核对 dsh-tools 源码）：
 *   1. 调用形态是 `render(exec.arguments, value)` —— 第一个参数是本次入参，
 *      第二个才是 execute 的返回值（@deepseek-ai/dsh-tools/lib/index.js:3548）。
 *      把第一个参数当结果读，永远读到 undefined。
 *   2. 返回值必须是无损 JSON，且形态是 content blocks 数组 `[{ type: 'text', text }]`
 *      —— 它会被直接当作 result.content 使用，并在
 *      `result.content.some((block) => block.type === "image")`（同文件 :1384）处被遍历；
 *      返回字符串会在那里抛 "content.some is not a function"。
 *   3. 缺 render 会直接失败：同文件 :2881 要求 `typeof output.render === "function"`。
 */
function render(_args, value) {
  try {
    const lines = []
    const result = value !== null && typeof value === 'object' ? value : {}
    const edit = result.edit ? result.edit : {}
    if (edit.ok) {
      const n = typeof edit.replaced === 'number' ? edit.replaced : 0
      lines.push(`已编辑 ${edit.path ?? '(未知路径)'}（替换 ${n} 处）`)
    } else {
      lines.push(`编辑失败：${edit.error ?? '未知错误'}`)
    }

    const check = result ? result.check : undefined
    if (check) {
      const exit = typeof check.exit === 'number' ? check.exit : '未知'
      const ms = typeof check.durationMs === 'number' ? `${check.durationMs}ms` : '?'
      if (check.ok) {
        lines.push(`校验通过（exit ${exit}，耗时 ${ms}）`)
      } else if (check.error === 'timeout') {
        lines.push(`校验超时被终止（耗时 ${ms}）`)
      } else {
        lines.push(`校验失败（exit ${exit}，耗时 ${ms}）${check.error ? `：${check.error}` : ''}`)
      }
      const out = tail(`${check.stdout ?? ''}${check.stderr ?? ''}`.trim(), RENDER_TAIL)
      if (out.length > 0) {
        lines.push('输出（末段）：')
        for (const line of out.split('\n')) lines.push(`  ${line}`)
      }
    }

    return [{ type: 'text', text: lines.join('\n') }]
  } catch (err) {
    return [{ type: 'text', text: `edit_and_check 结果渲染失败：${errText(err)}` }]
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function apply(ctx) {
  const tools = ctx.get('tools', false)
  if (!tools || typeof tools.register !== 'function') {
    // 不注册任何工具，但必须显式喊出来（激活期日志不放在 debug 开关后面）。
    safeLogger(ctx).warn('[edit-and-check] tools 服务不可用：不注册任何工具')
    return
  }

  tools.register({
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(args) {
      return editAndCheck(args)
    },
  })

  safeLogger(ctx).info(`[edit-and-check] 已注册工具 ${TOOL_NAME}`)
}
