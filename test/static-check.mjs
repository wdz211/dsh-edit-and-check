// 静态硬约束扫描：为汇报提供可复现的证据
import { readFileSync } from 'node:fs'
import * as m from '../index.js'

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

// 1) 真正的 export default 语句（行首为 export default），注释里的提及不算
const realDefault = src.split(/\r?\n/).filter((l) => /^\s*export\s+default\b/.test(l))
console.log('真正的 export default 语句行数（必须 0）：', realDefault.length)
if (realDefault.length) console.log(realDefault)

// 2) 具名导出
const u = m.default ?? m
console.log('具名导出：name =', u.name, '| inject =', JSON.stringify(u.inject))
console.log("'inject' in u =", 'inject' in u)
console.log('有 default 导出：', 'default' in m)

// 3) description 长度（≤400）
const i = src.indexOf('const DESCRIPTION = [')
const j = src.indexOf("].join('')", i)
const body = src.slice(i, j)
const parts = [...body.matchAll(/'([^']*)'/g)].map((x) => x[1])
const text = parts.join('')
console.log('description 字符数：', text.length, text.length <= 400 ? '(<=400 OK)' : '(超 400!)')
console.log('description：', text)

// 4) 启动期取服务方式：只允许 ctx.get(name, false)，不得出现 ctx.tools
const attrAccess = src.split(/\r?\n/).filter((l) => /ctx\.tools\b/.test(l) && !/^\s*(\*|\/\/)/.test(l.trim()))
console.log('ctx.tools 属性访问行数（必须 0）：', attrAccess.length)
const getCalls = [...src.matchAll(/ctx\.get\(/g)].length
console.log("ctx.get( 调用次数：", getCalls, '| 带 false 的：', [...src.matchAll(/ctx\.get\([^)]*false\s*\)/g)].length)

// 5) 零依赖：只允许 node: 内置模块
const imports = [...src.matchAll(/^import .*?from '([^']+)'/gm)].map((x) => x[1])
console.log('import 的模块：', JSON.stringify(imports))
console.log('全部是 node: 内置？', imports.every((s) => s.startsWith('node:')))
