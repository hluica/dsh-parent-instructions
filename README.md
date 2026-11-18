# @local/dsh-parent-instructions — 父工作区指导

最后实质性修改于Harness版本：0.2.2-rc.3

让**子工作区**（尤其是自身带 `.git` 的嵌套工作区）在保留自身指导文本的同时，额外获得**父工作区链**中的 `AGENTS.md` 家族指导。

内置的 `@deepseek-ai/dsh-agent-instructions` 在会话工作目录下向上找最近的 `.git`，从该根加载到 cwd 为止。子工作区一旦自己是一个 Git 仓库，项目根就停在子工作区，父级的 `AGENTS.md` 不会被加载。本插件是**补充式**的：不修改内置插件，只在运行时上下文中追加“内置项目根之上”的父级目录，并允许在设置中定义父工作区根的标记。

---

## 使用

1. 打开 **设置 → 通用**，找到 **「父工作区标记」**。
2. 在**父工作区根**放置一个与标记同名的文件或目录，默认是 `.dsh-parent-root`。
3. 在子工作区（自身带 `.git`）中新建会话。会话会在内置基线之外，额外收到从父根到子工作区之上这一段的 `AGENTS.md` 家族文件。

示例：

```text
proj/                         .dsh-parent-root
  AGENTS.md                   ← 父级规则，会补充给子工作区
  local-plugins/
    dsh-foo/                  .git
      AGENTS.md               ← 内置插件自己的项目链，仍由内置插件加载
```

在 `dsh-foo` 中工作时：

- 内置插件加载 `dsh-foo/AGENTS.md`；
- 本插件加载 `proj/AGENTS.md` 与 `local-plugins/AGENTS.md`（若存在）；
- 两段不重复，因为本插件只读取内置项目根**严格之上**的目录。

### 设置语义

| 值                         | 行为                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `.dsh-parent-root`（默认） | 在父目录链中找最近的同名文件或目录                                                                                 |
| 其他合法名                 | 改用该名字；名字按文件系统规则匹配（通常区分大小写），不能含 `/`、`\`、控制字符，不能是 `.` 或 `..`，最多 128 字符 |
| 空值                       | 关闭补充（保留内置行为）                                                                                           |
| 恢复默认                   | 清除 profile 覆盖，回到 schema 默认值                                                                              |

修改后对**下一次请求**生效，不需要重启 Host。标记本身必须放在内置项目根**之上**；放在子工作区内部不会生效，因为那一段已由内置插件负责。

---

## 工作原理

```text
cwd → 最近的 .git 祖先 = builtinRoot        （与内置默认规则一致）
    → 从 dirname(builtinRoot) 向上找最近的 parentRootMarker
    → 读 parentRoot 到 dirname(builtinRoot) 每一层的
       AGENTS.md / CLAUDE.md / AGENTS.local.md / CLAUDE.local.md
    → 去重、限 32 KiB、渲染为一段 runtime context
```

- 注入走 `ctx.systemPrompt.context()`：它被运行时物化为**持久 user 角色快照**，和 working directory、时间、技能目录等一起被包在 `<system-reminder>` 中；**不进入 system prompt**。
- 不伪造 `agent-instructions` 消息，也不改动内置插件的收件箱；因此不会与内置插件的 source-kind 过滤互相移除。
- 文本 provider 是同步的：读取路径、mtime、size 作为缓存键，文件未变时直接复用上次渲染结果。
- 文件按 UTF-8 读取；单文件超过 256 KiB 跳过；总文本超过 32 KiB 时先丢弃较宽泛的文件，再截断最具体的文件。
- 相同（去除首尾空白后）内容只保留最早出现的一份，与内置插件的候选组去重语义一致。
- 读取失败、权限错误、标记非法都返回空段落，不会让 prompt 组装失败。

### 模型看到的内容

```text
Parent workspace instructions (from .dsh-parent-root at /path/to/proj; broader than the current workspace, so closer instructions take precedence):

From: /path/to/proj/AGENTS.md

...父级内容...
```

外层由运行时上下文统一包裹 `<system-reminder>`；插件本身不添加框架。

---

## 结构

| 文件                                                     | 作用                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| `index.js`                                               | Host 半：`Config`、发现、去重、预算、缓存、`systemPrompt.context` |
| `client.js`                                              | Client 半：设置 → 通用的一行、`configForms` 读写、校验与状态      |
| `cordis.patch.yml`                                       | bundle 挂载声明（行 id `dsh-parent-instructions`）                |
| `locale/zh.json`、`locale/en.json`                       | 插件页显示名与描述                                                |
| `icon.svg`                                               | 插件页面图标                                                      |
| `test/lifecycle.test.mjs`                                | Client 生命周期与校验测试                                         |
| `scripts/host-contract.mjs`                              | Host 契约探针（发现/去重/预算/注册参数）                          |
| `scripts/`、`node_modules/`、`.cache/`、`deps.lock.json` | 构建系统与依赖物化产物                                            |

---

## 依赖与构建

Host 半 `import z from '@deepseek-ai/schemastery'`，而 profile 不提供这个包，所以插件自带一份真实文件（不是符号连接）。`node_modules/` 是**产物**，由 `npm run build` 从 `deps.lock.json` 生成。

| 命令              | 作用                                              |
| ----------------- | ------------------------------------------------- |
| `npm run build`   | 物化依赖，然后自动跑 `verify`                     |
| `npm run verify`  | 布局/依赖/清单/解析 + Client 测试 + Host 契约探针 |
| `npm run rebuild` | 即 `build --force`                                |
| `npm run clean`   | 删除 `node_modules/` 与 `.cache/`                 |
| `npm test`        | 只跑 Client 生命周期测试                          |

构建系统来自工作区参考副本 `build-system/`。`scripts/build.mjs`、`scripts/verify.mjs`、`scripts/lib/*` 与参考副本逐字节一致；`scripts/host-contract.mjs` 是本插件自己的文件，不随同步覆盖。修改构建系统时应改参考副本并运行 `node build-system/sync.mjs`，不要直接改这里。

Host 契约探针会在临时目录里构造“父根标记 + 中间层 + 带 `.git` 的子工作区”，断言：

- 只读取内置项目根之上的目录；
- 最近的标记优先；
- 空/非法/缺失标记不注入；
- 标记在子工作区内部不生效；
- 目录也可作为标记；
- 同内容候选去重、总预算 ≤ 32 KiB；
- 注入定义是 `required: true`、`interpolate: false`，且不拥有 `<system-reminder>` 框架。

---

## 安装与验证

通过插件管理器安装本目录（`link:` 就地安装，不复制）：

```text
plugin_manager: action=install_bundle, target=<local-plugins/dsh-parent-instructions 绝对路径>
```

安装后：

1. **插件** 页应出现「父工作区指导」，条目 `dsh-parent-instructions` 为运行中。
2. `Settings → General` 应出现「父工作区标记」行；若页面未刷新，刷新一次 Web 页面。
3. 在父根放置 `.dsh-parent-root`，在带 `.git` 的子工作区新建会话；新会话的 runtime context 应包含 `Parent workspace instructions`。
4. 修改标记并保存后，下一次请求应切换父级段落；留空后消失。
5. `npm run verify` 应全部通过。

---

## 故障排查

### 设置里没有「父工作区标记」

- 确认插件已安装且 Host 条目处于运行状态；
- 刷新页面（Client 半在页面加载时注册）；
- 运行 `npm run verify`，确认 Client 测试与槽位参数通过。

### 有标记但没有父级段落

- 标记必须在**内置项目根之上**：如果 cwd 自身或更近的祖先是 `.git`，标记要放在该 `.git` 目录的父级或更高；
- 确认标记是文件或目录，且名字与设置完全一致（区分大小写）；
- 父级目录里必须至少有一个 `AGENTS.md` / `CLAUDE.md` / `AGENTS.local.md` / `CLAUDE.local.md`；
- 当前 preset 若是 `minimal`，内置插件本身不加载项目链；本插件仍只补充父级，不会补子工作区自身。

### 保存失败

设置表单可能被更高层（profile patch / home patch / 命令行 overlay）覆盖；表单会显示「保存失败：设置可能被更高层覆盖」，此时需要检查 `~/.dsh/profiles/<profile>/cordis.patch.yml` 中 `dsh-parent-instructions` 的配置。

### 与内置根不重叠的前提

本插件按**随发行版 preset 的默认 `.git`** 计算内置项目根。如果你通过覆盖 preset 改了内置的 `projectRootMarkers`，补充链可能重叠或漏读；README 会随该契约变化更新。

---

## 已知限制

- **只补父级，不替代内置**：子工作区自身的 `AGENTS.md` 仍由内置插件加载；`minimal` preset 没有内置项目链，本插件不会补。
- **全局设置**：`parentRootMarker` 是 profile 级设置，不是每个 Workspace 一份。
- **读取工作区之外**：这是需求本身；插件只读固定候选名、不递归、不写文件。父级目录应可信；最终组件是 symlink 的候选文件会被解析并读取目标。
- **没有 watcher**：父级文件的变化在下一次 prompt 组装时通过 mtime/size 缓存键发现；不依赖 `read`/`write` touch。
- **runtime context 语义**：内容进入“当前会话信息”快照，而不是独立的 “Instructions from:” 消息；它是 user 角色快照，不进入 system prompt。
- **预算固定**：单文件 256 KiB、总 32 KiB；暂不暴露为设置。
- **绝对路径**：模型看到的父级来源路径是绝对路径，便于区分层级。

---

## 运行期版本契约

`peerDependencies` 声明 `@deepseek-ai/dsh: ^0.2.2-rc.3`。DSH 的版本闸门使用 `semver.satisfies(runtime, range, { includePrerelease: true })`；不满足时会跳过该 bundle。未来大版本变化时按插件页提示处理版本豁免。

---

## 许可证

MIT License，详见 [LICENSE](./LICENSE)。
