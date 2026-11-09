// 变异测试：把 render 退回「返回字符串 + 只吃一个参数」的旧形态，
// 验证 selftest 会变红。用法：node test/mutate-render.mjs
// 纪律：每个替换都必须断言真的发生了 —— 否则「变异无效」会被误读成「断言有效」。
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'index.js')
const BAK = path.join(HERE, '.index.js.mutbak')

const original = readFileSync(SRC, 'utf8')
copyFileSync(SRC, BAK)

let mutated = original
let hits = 0

function mustReplace(from, to, label) {
  const before = mutated
  mutated = mutated.replace(from, to)
  if (mutated === before) throw new Error(`变异未命中：${label}\n期望找到：${from}`)
  hits++
}

try {
  // 变异 1：返回数组 → 返回纯字符串（真机上会炸 content.some）
  mustReplace(
    "    return [{ type: 'text', text: lines.join('\\n') }]",
    "    return lines.join('\\n')",
    '成功分支的返回值',
  )
  // 变异 2：失败分支同样退回字符串
  mustReplace(
    "    return [{ type: 'text', text: `edit_and_check 结果渲染失败：${errText(err)}` }]",
    "    return `edit_and_check 结果渲染失败：${errText(err)}`",
    '失败分支的返回值',
  )
  // 变异 3：签名退回单参数（模拟「把第一个参数当结果」的旧写法）
  mustReplace('function render(_args, value) {', 'function render(value) {', 'render 签名')

  writeFileSync(SRC, mutated, 'utf8')
  console.log(`[mutate] 3/3 处替换生效（hits=${hits}）`)

  let out = ''
  let code = 0
  try {
    out = execFileSync(process.execPath, [path.join(HERE, 'selftest.mjs')], { encoding: 'utf8' })
  } catch (e) {
    code = e.status ?? 1
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`
  }

  const failed = out.split('\n').filter((l) => l.startsWith('not ok'))
  console.log(`[mutate] selftest exit=${code}, 失败项 ${failed.length} 个`)
  for (const line of failed) console.log('  ' + line)

  if (failed.length === 0) {
    console.error('[mutate] FAIL —— 变异后 selftest 仍全绿，说明断言无法区分新旧实现')
    process.exitCode = 1
  } else {
    console.log('[mutate] PASS —— 断言成功抓住了退回旧实现的回归')
  }
} finally {
  copyFileSync(BAK, SRC)
  unlinkSync(BAK)
  console.log('[mutate] 已恢复 index.js')
}
