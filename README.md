# dsh-edit-and-check

> One tool call that edits a file literally, then immediately runs a check command — two round-trips fused into one.

## 这是什么

Agent 改代码的动作几乎总是一对：先做一次字面替换，紧接着跑一条校验（`node --check`、测试、lint、
或 grep 刚改的那几行）。这两步拆成两次工具调用，代价是两趟模型往返——一趟改、一趟验，
中间还要模型自己"记得"去验。忘了验，就会把没验证的改动当成做完了报出去。

`edit_and_check` 把这两步合成一次调用：`old_string` 命中唯一就落盘，落盘成功才执行 `check_command`，
返回体同时带 `edit`（改没改、改了几处、路径）和 `check`（退出码、stdout/stderr 末尾、耗时）。
它给的是 agent 自己用——尤其是那种"改完立刻要知道有没有弄坏"的小步迭代。

在 DSH 里它不是内置 `edit` 的替代品：纯编辑、不需要校验时该用内置 `edit`；只有"改完就得验"的场景
才值得走这一条。这个分工写进了工具描述里，因为它直接决定模型会不会在简单场景多绕一圈。

## 前置条件

**这是 DeepSeek Harness Desktop 的插件，不是独立的 npm 库。** 它唯一的硬依赖是宿主的 `tools`
服务（`export const inject = ['tools']`），没有宿主就没有注册处，插件跑不起来。
`test/` 下的脚本可以离线跑，但那验证的是业务逻辑，不是它的插件可用性。

额外一条：**不要 `export default apply`**。Loader 靠具名导出 `name` / `inject` / `apply` 认插件，
加一个 default 导出会把它们搞丢（`test/static-check.mjs` 有一条断言守着这件事）。

## 安装

把仓库目录 link/junction 进 profile 的 `node_modules`，再在 `cordis.patch.yml` 里加一行（**没有 config**：
传一个本插件没声明过的 config 反而可能触发 schema 校验失败）：

```yaml
- insert:
    - id: edit-and-check
      name: 'dsh-edit-and-check'
```

目录示例（`<dsh-home>` 是 DSH 家目录）：

```
<dsh-home>/profiles/desktop/node_modules/dsh-edit-and-check  ->  <本仓库>
```

改 `cordis.patch.yml` 属于 load-once 的配置变更，**必须整 App 重启**；只改 `index.js` 用宿主自带的刷新机制即可。

## 配置

无配置项。工具行为是固定的，配置面为零——多一个可调参数就多一条"配错了但没人知道"的路。

## 对外能力

只有一个工具 `edit_and_check`。

| 入参 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `file_path` | string | ✅ | 要改的文件：workspace 相对路径或绝对路径 |
| `old_string` | string | ✅ | 要被替换的字面文本；`replace_all` 不为 true 时必须**唯一命中** |
| `new_string` | string | ✅ | 替换文本；空串表示删除这段文本 |
| `replace_all` | boolean | — | 是否替换全部命中（默认 false） |
| `check_command` | string | — | 编辑成功后立刻执行的校验命令（shell 语法，可用 `&&`）。不给就只改不验 |
| `cwd` | string | — | `check_command` 的执行目录（缺省 = 被编辑文件所在目录）；也给相对 `file_path` 提供解析基准 |

返回体（`output.schema` 是 `additionalProperties: false`，多一个键就会被宿主拒收）：

| 字段 | 含义 |
|---|---|
| `edit.ok` | 是否改动成功 |
| `edit.path` / `edit.replaced` / `edit.error` | 改到的路径 / 替换处数 / 失败原因 |
| `check.ok` / `check.exit` / `check.durationMs` | 校验结果、退出码、耗时 |
| `check.stdout` / `check.stderr` / `check.error` | 各留**末尾 4000 字符**；`error` 形如 `timeout` |

行为契约（每一条都有测试守着）：

1. **未命中或命中多处 → 一个字节都不写，也不执行 `check_command`。**
   "改了一半再发现歧义"比"没改"更糟：调用方会以为自己看见了全部结果。
2. **编辑失败 → 立刻 return，不跑校验。** 对着没改成的文件跑校验只会得到一条误导性的绿。
3. **行尾原样保留。** 文件原本是 CRLF，替换完还是 CRLF；原来末尾有换行，替换后仍然有。
   编辑工具把 CRLF 抹成 LF，会在 diff 里造出一整片假改动。
4. **退出码非 0 不算工具失败。** 那是"校验发现了问题"，是正常结果，如实返回 exit 与 stderr 即可。
5. **超时 120 秒**：到点杀掉整条进程树并返回 `error: 'timeout'`，不会把工具调用钉死。

## 已知限制

- **`old_string` 必须唯一**，否则传 `replace_all=true`。这是从内置 `edit` 继承的语义，故意的：
  模糊匹配等于让工具替调用方猜意图。
- **相对路径的坑**：相对路径以 `cwd`（若给）或 `process.cwd()` 为基准。DSH Desktop 下
  `process.cwd()` 可能根本不是你以为的工作区，所以相对路径要么给绝对路径、要么同时传 `cwd`。
- **超时杀进程树只有 Windows 是彻底的**：Windows 走 `taskkill /T /F`，并且**等它真的返回**才
  resolve（早于它返回就 resolve，孙子进程会成孤儿——实测踩过）。类 Unix 只对这个直接子进程
  `SIGKILL`；如果 `check_command` 内部又起了后台子进程，理论上可能留下孤儿。
- **输出只留末尾**：`stdout`/`stderr` 各 4000 字符（render 里更短，800）。这是刻意的——
  把几百 KB 输出整份塞回上下文，会为了一条 lint 报错烧掉整个窗口。
- **它不是 `apply_patch`**：只做单点/全量字面替换，没有 diff 语义、没有多文件事务、没有回滚。
  改错了得自己改回来。
- **`check_command` 走 shell**（Windows 下 `cmd.exe`，类 Unix 下 `/bin/sh`），所以 `&&` 可用，
  但也意味着命令字符串由调用方负责——别把不可信文本拼进去。

## 开发

```bash
node test/selftest.mjs        # 15 条断言：命中/未命中/多处/CRLF/末行/EISDIR/相对路径/非法入参
node test/static-check.mjs    # 静态硬约束：无 export default、零依赖、description 长度、ctx.get(name,false)
node test/timeout-check.mjs   # 超时链路 3 条：到点返回、确实杀掉、不留孤儿（孤儿判据只在 win32 上量）
bash test/mutants.sh          # 变异测试：注入 4 种退化，确认对应断言真的会变红
```

`test/mutants.sh` 是这个仓库最值得看的一部分：它把插件复制到临时目录，分别注入
`export default apply`、去掉"编辑失败提前 return"、抹掉行尾还原、退回"超时只 kill shell"四种退化，
然后确认对应测试**变红**。没有这一步，"有 15 条断言"和"有 15 条真会失败的断言"是分不清的。
（变异 D 必须用 `timeout 40` 兜住，否则那条退化会把执行环境一起挂死。）

CI 跑的是 `node test/selftest.mjs` + 全量语法检查。变异测试不进 CI：它要 bash + python +
`powershell`，属于本地设计守卫，不属于每次提交的必跑项。

## 许可

MIT。无第三方上游代码，故无 ATTRIBUTION.md。
