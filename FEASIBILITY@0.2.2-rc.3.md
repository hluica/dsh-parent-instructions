# dsh-parent-instructions：子工作区继承父工作区指导 —— 可行性与进路报告（DSH 0.2.2-rc.3）

- 目标插件：`@local/dsh-parent-instructions`，目录 `local-plugins/dsh-parent-instructions/`
- 目标 DSH 版本：`0.2.2-rc.3`（`app.asar → dsh/package.json`）
- 报告日期：2026-11-15
- 当前状态：**已实现并本地安装**（2026-11-15）；Git 仓库已初始化并推送至 GitHub（PUBLIC）。
- 目标概述：
  1. 让**子工作区**（尤其自身带 `.git` 的嵌套工作区）在保留自身指导文本的同时，获得**父工作区链**中的 `AGENTS.md` 家族指导；
  2. 在**设置 → 通用**增加一行，用全局 `parent-root-marker` 定义“父工作区根”的识别方式；
  3. 不修改内置 `dsh-agent-instructions`、不覆盖 agent preset、不直接改写 profile。

> **后续更新（实现阶段，2026-11-15）**
>
> 本轮已生成 `package.json`、`cordis.patch.yml`、`index.js`、`client.js`、`locale/`、`icon.svg`、`scripts/`、`test/lifecycle.test.mjs` 与 `README.md`，并完成本地构建、校验与安装：
>
> - `npm run build` / `npm run verify` 全部通过（布局、依赖、清单、解析、Client 生命周期测试、Host 契约探针）。
> - `plugin_manager install_bundle` 返回 `application: applied`。
> - `Config.listConfigs` 显示 `@local/dsh-parent-instructions`，`parentRootMarker` 为 `x-cordis.volatile: true`。
> - Client `Slots.listSubTree{root:"settings.general.item"}` 显示 `parent-root-marker`、order `11.6`、active。
> - 新子会话实测：父级 `proj/AGENTS.md` 与中间层 `proj/local-plugins/AGENTS.md` 均进入 runtime context；子级 `CHILD_FIXTURE_RULE_GHI789` 只出现在内置基线，未在补充段重复。临时 fixture 已删除。
>
> 与报告的差异：
>
> - 未增加隐藏的 `builtinMarkers` 配置；v1 固定按 `.git` 计算内置项目根（见 §7 风险 1、§8 决策点 3）。
> - 预算固定为单文件 256 KiB、总 32 KiB、缓存上限 64 条，未暴露为设置。
> - Client 测试增加了模拟保存/重置，覆盖 `configForms.set/unset` 路径；用户已在真实设置页确认可用（2026-11-15）。
>
> Git：已初始化独立仓库并推送至 `https://github.com/hluica/dsh-parent-instructions`（默认分支 `main`，SSH 远端 `git@github.com:hluica/dsh-parent-instructions.git`）。

---

## 1. 结论摘要

| 问题 | 结论 |
| --- | --- |
| 需要修改内置的项目根算法吗？ | **不需要。** 采用**补充式** Host 插件：保留内置的 `.git → cwd` 链，只补上它没有覆盖的“内置项目根之上”的祖先指导。 |
| 怎么识别父工作区根？ | 从 `dirname(builtinRoot)` 开始向上，找到**最近的**包含全局 `parentRootMarker`（文件或目录）的祖先；找不到就不注入。 |
| 注入到模型的哪个位置？ | 用 `ctx.systemPrompt.context()` 贡献一段 **runtime context**；它由运行时物化为持久 user 角色快照，并统一包在 `<system-reminder>` 中。**不进入 system prompt**，也不伪造 `agent-instructions` 消息。 |
| 设置 UI 怎么做？ | 在 `settings.general.item` 注册一行（id `parent-root-marker`，order 11.6），通过 `ctx.configForms.get('dsh-parent-instructions')` 读写 Host Config 的 volatile 字段。 |
| 配置如何持久化？ | Host `Config` 中 `parentRootMarker` 声明为 `.volatile()`；表单写入 profile 的设置文档，Host 原地读取 `.get()`，无需重启。 |
| 是否有上游阻塞？ | **没有。** `systemPrompt.context`、`workingDirectory.get`、`configForms`、`settings.configure`、`settings.general.item` 槽位均为当前版本已存在并有既有插件先例的扩展面。 |
| 主要风险 | ① 内置项目根 markers 目前按 `.git` 假设，若用户另行覆盖 preset 改变 markers，补充链可能重叠/漏读；② runtime context 的语义与内置“Instructions from:”不同；③ 文本 provider 同步执行，需要缓存避免每步读盘。 |

**判定：方案 B（Host 补充插件）可行，建议按本报告实现。**

---

## 2. 背景：内置指导文本如何发现，以及嵌套工作区的问题

### 2.1 内置行为（`@deepseek-ai/dsh-agent-instructions`）

当前版本中，内置插件的发现顺序为：

```text
$DSH_HOME/AGENTS.md
$DSH_AGENTS_HOME/AGENTS.md
<projectRoot>/AGENTS.md
<projectRoot>/CLAUDE.md
<projectRoot>/AGENTS.local.md
<projectRoot>/CLAUDE.local.md
...（projectRoot → cwd 每一层目录同样四个文件）...
<cwd>/AGENTS.md
<cwd>/CLAUDE.md
<cwd>/AGENTS.local.md
<cwd>/CLAUDE.local.md
```

- `projectRoot` = 从 cwd 逐级上溯遇到的**第一个**包含 `.git`（`projectRootMarkers` 默认值）的目录；一路到 `/` 都没有标记时，`projectRoot = cwd`。
- 项目链**包含两端**：从 `projectRoot` 到 `cwd` 的每一层目录都加载；项目根以上的目录**不再读取**（用户全局两文件除外）。
- 首次请求注入一条持久基线；成功的 `read`/`write`/`edit` 触及更深目录时，下一次请求补入新适用的嵌套文件。
- 标记探测失败（权限/IO）会抛出原始错误，不会退回祖先。

结论：**子工作区目录只要自身含 `.git`，项目根就停在子工作区，父工作区的 `AGENTS.md` 不会被内置插件加载。** 当前 `dsh-*` 插件目录各自是独立 Git 仓库，因此以某个插件目录为工作区时，父级 `local-plugins/AGENTS.md` 不会生效。

### 2.2 为什么不在 preset 里改 `projectRootMarkers`

曾评估两条配置路径，结论是不适合本需求：

1. **改内置配置**：`agent-instructions` 的 host 行被 `dsh-web-app` 补丁禁用，实际实例声明在 `preset-standard` / `preset-ptc` / `preset-cordis` 的 `config.plugins` 中。Loader 补丁只能整体替换 `config`，不能只改其中一个子项；改一处标记必须复制整个 preset 插件列表，DSH 升级不会合并。
2. **`!!js` 解析基准漂移**：`standard` / `cordis` 的 `skill-filesystem.customSkillDirs` 使用声明 bundle 的 `baseUrl` 解析 `@deepseek-ai/dsh-agent-preset/package.json`；把声明复制到用户 bundle 后 `baseUrl` 变化，可能直接导致 preset 激活失败。
3. 该路径改变的是**全局根判定**，无法表达“只给嵌套工作区补父级”；而且会同时影响所有仓库。

因此采用**补充式 Host 插件**：内置链保持原样，本插件只补内置根**之上**的父级目录。

---

## 3. 可行性依据：使用的扩展面

### 3.1 插件形态：bundle 的 Host 半 + Client 半

本插件按工作区现有插件形态交付：

- 一个独立包目录，`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`；
- `cordis.patch.yml` 用 `insert` 增加一行 Host 插件；
- `exports["./client"]` 指向 `client.js`，`dsh.client` 声明 `platform: "web"`、`immediately: true` 与注入的包名；
- Host 半导出 `apply(ctx, config)`，可选导出 `Config`；
- Client 半由 `window.__ModuleLoader__.load({ id, factory(require) { ... } })` 注册。

`local-plugins/dsh-custom-css/` 与 `dsh-font-settings/` 是本版本可运行的 Host + Client 先例；本插件沿用其结构，不发明新的加载方式。

### 3.2 注入通道：`ctx.systemPrompt.context()`

`@deepseek-ai/dsh-system-prompt` 的 `PromptContext`：

```ts
export interface PromptContext {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
  readonly interpolate?: boolean
  readonly required?: boolean
}
```

文档明确其为“dynamic model context materialized as a durable user-role snapshot”。对实现重要的性质：

- `text` 可以是**provider**，每次组装/准入刷新时求值；必须是同步函数。
- `AssembleContext.agent` 由 `@deepseek-ai/dsh-agent` 扩展提供，可用于取当前会话；诊断组装时可能为 `undefined`。
- 运行时的 `runtime-context` 生产者把所有 context sections 合并为**一条 user 角色快照**，统一包上：

  ```text
  <system-reminder>
  The following information describes your current session:
  ...
  </system-reminder>
  ```

  因此本插件**不要**自己再包 `<system-reminder>`，只提供 sections 文本。
- `required: true` 使该段落即使在 `includeRuntimeContext: false` 时仍保留；这是“用户明确要求的工作区指导”应采用的形态。
- 该通道不进入 system prompt，不会改写会话第一条 system 消息；新增/变化只追加新的快照消息，符合 KV Cache 的仅追加策略。

### 3.3 当前工作目录：`ctx.workingDirectory.get(session)`

`@deepseek-ai/dsh-working-directory` 的服务契约包含同步的：

```ts
get(session: Session): string
```

它返回该 Session 的当前有效目录；本插件用它计算 `cwd`，与内置插件使用的 `ctx.workingDirectory.ensure(agent)` 语义一致（后者是异步版本，用于需要等待目录校验的路径）。文本 provider 是同步的，因此这里用 `get`。

### 3.4 设置 UI：`settings.general.item` + `configForms` + volatile Config

- 槽位 `settings.general.item` 是“通用”设置里的一行；当前活体占用者包括 `font-size` 11、`font` 11.25、`custom-css` 11.5、`transcript-view` 12 等。本插件使用独立 id `parent-root-marker`、order `11.6`，不遮蔽任何内置行。
- 槽位选项只需 `id`、`order`；owner 不传 props，行的标题、值、写入路径都由插件自己负责。
- 设置表单只展示**活动且可唯一定位**的 profile 条目中的 **volatile** 字段；因此 `parentRootMarker` 必须声明 `.volatile()`。
- `ctx.configForms.get(entryId)` 返回该 Host 条目的共享表单：`getSnapshot()` 读 `value`，`set(field, value)` / `unset(field)` 提交写入，`subscribe(listener)` 订阅接受值。`dsh-custom-css` 已用同一路径编辑自己的 `css` 字段。
- Host 半在 `apply` 中通过 `ctx.inject(['settings'], child => child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)))` 声明“自带页面、不要自动生成表单”；`dsh-custom-css` 是直接先例。
- `settings` 服务负责持久化到当前 profile 的 patch；写入被更高层覆盖时返回失败，UI 必须显示失败而不是假装保存成功。

#### 2026-11-15：设置行改为“标题控件一行、描述整行”

- **目的**：修掉设置行的失衡外观。通用设置的内容栏在宽视口下为 564 CSS px；旧实现把标题、描述、状态放在左列，输入框（220px）与两个按钮放在右列。右列固有宽度约 370px，左列只剩约 150px，60 余字的中文描述被折成 7 行，行高约 190px，纵向分栏位置明显偏向右侧。
- **修法**：`.dpi-entry` 改为纵向三行：
  1. `.dpi-head`：标题（`flex:1 1 140px`）与 `.dpi-control`（输入框 200px + 保存 + 恢复默认，右对齐、允许换行）；
  2. `.dpi-desc`：描述独占整行；
  3. `.dpi-status`：状态独占整行，继续保留 `aria-live="polite"` 与 `aria-describedby`。
  `.dpi-entry` 设为 `container-type:inline-size`，用 `@container (max-width:540px)` 切换为纵向：标题在上、控件行在下，输入框 `flex:1 1 160px` 且 `min-width:120px` 自适应扩展；按钮 `flex:0 0 auto` 且 `white-space:nowrap`，不足宽度时整组换行而不是压缩文字。用容器宽度而非视口宽度判断，是因为通用设置内容栏在宽视口下固定为 564px，窗口变窄时随面板收缩；浏览器布局在 <768px 还会切换为全屏，单一视口断点无法同时对准这些形态（macOS Desktop 保留侧栏，仅面板随视口收缩）。
- **依据**：`ui-settings-general` README 记载设置面板为 800×800 且内容栏由视口约束；其布局 CSS 为 `grid` 的 `188px minmax(0,1fr)` 加 24px 内容内边距，实际内容栏 564px。用户截图按 2× 比例换算，左列约 150px、行高约 190px。改后描述在 564px 宽下约 2 行，按同宽估算行高约 130px。
- **验证**：`npm test` 新增三行结构断言（标题+控件、描述、状态各占一层）与非法草稿的 `aria-invalid`/错误文案断言，全部通过；`npm run verify` 全部通过。另按 UI/UX 复查意见补了 `--dsw-focus-ring-color` 的 `--dsw-alias-state-business-primary` 回退（上游 `focus.css` 同款）、按钮 `box-sizing:border-box`、输入框 `aria-invalid`。真实浏览器截图/明暗主题并排对比仍需用户刷新页面后确认。
- **版本**：仅视觉排版调整，设置 id、order、读写路径、校验与状态机均未变化；按本工作区“外观修正也提升版本号”的惯例，插件版本由 `0.1.0` 提升为 `0.1.1`。README 的用法与设置语义无需变更。

### 3.5 Host Config 与 `.volatile()`

本插件 Host `Config` 计划为：

```ts
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  parentRootMarker: z.string().default('.dsh-parent-root').volatile(),
})
```

- `.volatile()` 让字段可在运行中更新，并由 `config.parentRootMarker.get()` 读取当前值；`ui-theme` 的 `textFontFamily` 等字段是同一模式。
- `Config` 的默认值保证首次安装即有一个可工作的标记名。
- `parentRootMarker` 是唯一面向 UI 的字段；候选文件名、预算等先作为内部常量，暂不暴露，避免设置面过宽。

### 3.6 构建与校验

工作区已有统一构建系统 `build-system/`，新插件按 `BUILD-SYSTEM.md` 采纳：

```bash
mkdir dsh-parent-instructions
node build-system/sync.mjs dsh-parent-instructions
```

它同步 `scripts/build.mjs`、`scripts/verify.mjs`、`scripts/lib/*`，并在缺失时从模板生成 `scripts/host-contract.mjs`。Host 半若 `import` `@deepseek-ai/schemastery`，需在 `package.json` 声明精确版本，用 `node scripts/build.mjs --pin <name>@<version>` 写入 `deps.lock.json`，再 `npm run build` 物化真实 `node_modules/`。`npm run verify` 会检查清单契约、依赖、解析、真实文件与插件自己的 Host/Client 契约。

---

## 4. 目标行为

### 4.1 定义

对每个 agent 的当前 `cwd`：

- **builtinRoot**：从 `cwd`（含）向上，最近的包含 `.git` 的目录；一路到 `/` 都没有 `.git` 时，`builtinRoot = cwd`。这是内置插件已经覆盖的边界。
- **parentRoot**：从 `dirname(builtinRoot)`（不含 builtinRoot 本身）开始向上，最近的包含 `parentRootMarker` 的目录；找不到则没有 `parentRoot`。
- **补充目录链**：`parentRoot → … → dirname(builtinRoot)`，包含两端，按“宽泛 → 具体”排序。
- **候选文件**：每个目录中的 `AGENTS.md`、`CLAUDE.md`、`AGENTS.local.md`、`CLAUDE.local.md`（与内置默认一致）。
- **生效条件**：`parentRootMarker` 非空且合法；`parentRoot` 存在；补充链至少有一个非空候选文件。
- **不生效**：没有标记、标记在 builtinRoot 或其下方、标记名为空/非法、没有可读文件。

`parentRootMarker` 是**全局**设置（一个 profile 一个值），不是 per-workspace；这是用户明确要求的形态。

### 4.2 示例

| cwd | builtinRoot | marker 位置 | 结果 |
| --- | --- | --- | --- |
| `proj/local-plugins`（无 `.git`，无祖先标记） | `proj/local-plugins` | 无 | 不补充；内置已加载 `proj/local-plugins/AGENTS.md` |
| `proj/local-plugins/dsh-foo`（有 `.git`） | `dsh-foo` | `local-plugins/.dsh-parent-root` | 补充 `local-plugins/AGENTS.md` |
| `proj/local-plugins/dsh-foo`（有 `.git`） | `dsh-foo` | `proj/.dsh-parent-root` | 补充 `proj/AGENTS.md` + `local-plugins/AGENTS.md` |
| `proj/local-plugins/dsh-bar`（无 `.git`，父级无 `.git`） | `local-plugins` | `proj/.dsh-parent-root` | 补充 `proj/AGENTS.md`；内置已覆盖 `local-plugins` 与 `dsh-bar` |
| 任意 | 任意 | 标记在 builtinRoot 或更深 | 不补充（内置已覆盖） |
| 任意 | 任意 | 标记名非法/空 | 不补充；设置 UI 显示“已禁用/无效” |

### 4.3 与内置链的去重边界

本插件只读取 `builtinRoot` **严格以上**的目录，因此与内置的项目链 (`builtinRoot → cwd`) 不重叠。两个例外需要记录：

1. 如果用户覆盖 preset，把内置 `projectRootMarkers` 从 `.git` 改成别的名字，本插件仍按 `.git` 计算 `builtinRoot`，可能重叠或漏读。v1 按**随发行版的默认 `.git`** 假设，README 明确说明；未来可增加隐藏 Config `builtinMarkers`。
2. 如果 `parentRootMarker` 恰好是 `README.md` 这类到处都有的名字，最近的祖先会命中；这是用户选择的标记语义，文档提示不要用常见文件名。

### 4.4 模型可见文本

每个 section 建议形如：

```text
Parent workspace instructions (from <marker> at <parentRoot>; broader than the current workspace, so closer instructions take precedence):

From: /abs/path/AGENTS.md

<content>

From: /abs/path/CLAUDE.md

<content>
```

- 使用绝对路径，避免“父根相对 cwd”的歧义。
- 不添加 `<system-reminder>` 框架；运行时上下文生产者统一包裹。
- 明确“更具体者优先”，与内置基线的提示语一致。

### 4.5 预算与去重

- 每个文件先按 UTF-8 读取；单文件上限建议 256 KiB，总补充预算建议 32 KiB（与内置每条链 64 KiB 分开，不共享）。
- 同一补充链内，去除首尾空白后内容相同的文件只保留最早（最宽泛）的一个。
- 总预算不足时，优先保留更具体的文件：先丢弃完整的宽泛文件，再截断最后一个（最具体）文件；截断按 UTF-8 字节边界回退，避免切坏多字节字符。
- 读不到的文件（权限、消失）跳过；不因为单个文件失败让 prompt 组装失败。

### 4.6 缓存与刷新

`systemPrompt.context` 的 provider 会在每次组装/准入刷新时同步调用。实现应在 Host 半维护一个按会话/路径的 memo：

- key：`cwd`、当前 `parentRootMarker`、补充链上每个候选文件的 `path + mtimeMs + size`；
- value：渲染后的 section 文本；
- 任一 key 分量变化则重算；无变化直接复用。
- 外部修改因此在下一次 prompt 组装时可见；不需要 watcher，也不需要 `read`/`write` touch。
- 缓存不持久化；恢复会话后第一次组装重算即可。

---

## 5. 核心进路

### 5.1 架构

```text
Host 半（index.js）
  Config: parentRootMarker (string, volatile, default '.dsh-parent-root')
  apply(ctx, config):
    - 可选 settings.configure({auto:false}, ctx.fiber)  // 自带设置行
    - systemPrompt.context({
        name: 'parent-workspace-instructions',
        order: 250,
        required: true,
        text: ({ agent }) => renderParent(agent, config.parentRootMarker.get())
      })
    - renderParent:
        cwd = ctx.workingDirectory.get(agent.session)
        builtinRoot = nearestAncestorWith(cwd, '.git') ?? cwd
        parentRoot = nearestAncestorWith(dirname(builtinRoot), marker)
        if (!parentRoot) return ''
        dirs = parentRoot → dirname(builtinRoot)（宽→具体）
        files = dirs × 四个候选，trim 去重，读文件，限预算
        return 文本（不含 <system-reminder>）

Client 半（client.js）
  - settings.general.item 注册一行：id 'parent-root-marker'，order 11.6
  - form = ctx.configForms.get('dsh-parent-instructions')
  - 读：form.getSnapshot().value.parentRootMarker
  - 写：form.set('parentRootMarker', normalized)
  - 重置：form.unset('parentRootMarker')
  - 校验、保存状态、locale、主题 CSS
```

### 5.2 Host 半细节

- **模块级 `inject`**：`export const inject = ['systemPrompt', 'workingDirectory']`；`settings` 用可选的 `ctx.inject(['settings'], ...)`，缺失时插件仍可按 profile 配置工作，只是没有设置表单。
- **Config**：见 §3.5；`parentRootMarker` 必须 `.volatile()`。
- **设置所有权**：`ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })`；与 `dsh-custom-css` 完全同构。
- **注册 context**：`ctx.effect(() => ctx.systemPrompt.context({...}))`，确保 dispose/HMR 时移除；`name` 全局唯一（`parent-workspace-instructions`）。
- **错误策略**：provider 内任何异常都返回 `''`，并记录一条 warning；绝不抛出导致 prompt 组装失败。
- **标记合法性**（Host 侧二次校验）：`trim()` 后非空；不含 `/`、`\`、NUL；不等于 `.` 或 `..`；长度 ≤ 128。非法即视为未配置。
- **标记类型**：文件或目录均可；用 `statSync`（跟随 symlink）判定存在。`stat` 失败按“不存在”处理；权限错误记 warning 并停止该次发现。
- **父根搜索**：从 `dirname(builtinRoot)` 开始逐级向上直到 `/`；找到第一个含标记的目录即停止；不继续向外。
- **读取**：`node:fs` 同步读取（Host 插件，非工具沙箱路径）；只读，不写。只读候选文件名，不递归。
- **不修改内置**：不监听/改写 `agent-instructions` 消息，不使用 `source.kind = 'agent-instructions'`，不触碰内置收件箱。

### 5.3 Client 半细节

- 模块形态：`window.__ModuleLoader__.load({ id: '@local/dsh-parent-instructions', factory(require) { const React = require('react'); ...; return { inject: ['slots','locale','configForms'], apply } } })`；factory 无副作用，资源注册放 `apply` 并用 `ctx.effect` 清理。
- `package.json` 的 `dsh.client.inject` 至少包含：
  - `@deepseek-ai/dsh-client-ui-slots`
  - `@deepseek-ai/dsh-client-locale`
  - `@deepseek-ai/dsh-client-ui-settings`（提供 `configForms`）
- 行注册：

  ```js
  ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register(
      { name: 'settings.general.item', id: 'parent-root-marker', order: 11.6 },
      ParentRootMarkerRow,
    ),
  )
  ```

- 组件：
  - 标题“父工作区标记”/“Parent workspace marker”；
  - 说明“在父工作区根放置同名文件或目录；留空关闭；只影响内置项目根之上的目录”；
  - 文本输入（placeholder `.dsh-parent-root`）、保存、恢复默认；
  - 状态行：已保存 / 保存中 / 保存失败 / 已禁用 / 无效（含原因）；
  - 保存时 `trim()`；空字符串允许（表示禁用），非空按 §5.2 规则校验；超过 128 字符拒绝；
  - Enter 提交；保存中禁用按钮；`aria-describedby` 关联说明与状态。
- 读取/订阅：

  ```js
  const form = ctx.configForms.get('dsh-parent-instructions')
  const read = () => form.getSnapshot()?.value?.parentRootMarker ?? DEFAULT
  const dispose = form.subscribe(() => setValue(read()))
  ```

  写入 `await form.set('parentRootMarker', next)`；返回 `false` 表示被更高层覆盖或拒绝，恢复显示并提示，不做乐观“已保存”。
- 重置：`form.unset('parentRootMarker')`，恢复 schema 默认值 `.dsh-parent-root`；不是“禁用”。
- 语言：行文案用 `ctx.locale.register('settings.parentInstructions', { zh, en })` 内联注册（与 `dsh-custom-css` 一致）；插件页显示名与描述放 `locale/zh.json`、`locale/en.json` 的 `meta.title` / `meta.description`。
- 样式：类名统一 `dpi-` 前缀；颜色/圆角用 `--dsw-alias-*`、`--dsw-radius-*` 令牌；输入框与按钮复用现有设置行的视觉尺度（高 36px / 32px、字号 14/13、分隔线 `--dsw-alias-border-l2`）。
- 不引入图标依赖；如后续需要展开/收起图标，再从 `@deepseek-ai/dsh-client-ui-primitives` 取。

### 5.4 配置与命名

| 项 | 值 |
| --- | --- |
| 包名 | `@local/dsh-parent-instructions` |
| 目录 | `local-plugins/dsh-parent-instructions/` |
| Loader 行 id / 设置命名空间 | `dsh-parent-instructions` |
| 设置行 id | `parent-root-marker` |
| 设置行 order | `11.6` |
| Config 字段 | `parentRootMarker`（volatile，默认 `.dsh-parent-root`） |
| Host context 名 | `parent-workspace-instructions` |
| context order | `250` |
| 插件版本 | `0.1.1`（首版 `0.1.0`；2026-11-15 设置行外观修正） |
| peer | `@deepseek-ai/dsh: ^0.2.2-rc.3` |

---

## 6. 备选方案对比

| 方案 | 注入位置 | 与内置冲突 | 设置 UI | 维护成本 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **B. Host 补充插件 + `systemPrompt.context`** | runtime context 快照 | 无（只读内置根之上） | `settings.general.item` + `configForms` | 低；只用公开服务 | **推荐** |
| `agent/pre-step` + 自建 user 消息 | 独立 user 消息 | 中；不能复用 `agent-instructions` source（内置按 kind 过滤收件箱） | 同上 | 中；需自己造 `UserMessage`、处理收件箱/恢复 | 备选，仅当必须显示为独立“Instructions from”消息 |
| `systemPrompt.section` | 系统提示词 | 高；内容变化会改写 system prompt，破坏前缀缓存 | 同上 | 中 | 不推荐 |
| 覆盖 preset 的 `projectRootMarkers` | 内置基线 | 全局改变根判定 | 无（preset 配置） | 高；整份 preset 列表冻结，`!!js` baseUrl 风险 | 仅当要全局替换 `.git` |
| 全局 `~/.dsh/AGENTS.md` / symlink | 内置基线 | 无 | 无 | 最低 | 适合稳定规则；不满足“按子工作区父根自动发现” |

选择 B 的关键原因：

1. **不碰内置的收件箱与 source kind**：内置 `agent-instructions` 的 `syncInbox` 会过滤所有同 kind 消息；再注入同 kind 会互相移除/替换。
2. **不进入 system prompt**：`PromptContext` 明确物化为 user 角色快照，变化仅追加。
3. **自带设置 UI 的成本最低**：`configForms` 已有跨插件编辑先例，且 volatile 字段原生支持即时生效。

---

## 7. 问题与解决办法

| # | 问题/风险 | 根因 | 修法/对策 |
| --- | --- | --- | --- |
| 1 | 内置根 markers 被用户改成非 `.git`，补充链重叠或漏读 | 本插件按发行版默认 `.git` 计算 `builtinRoot` | v1 文档明确假设；未来增加隐藏 Config `builtinMarkers`（默认 `['.git']`），或在发现时用内置消息的 `changes` 路径做二次去重 |
| 2 | 使用 `minimal` preset 时内置插件不存在，只有父级补充、没有仓库自身指导 | `minimal` 未声明 `agent-instructions` | 文档说明：本插件是补充，不替代内置；需要完整指导时使用 standard/ptc/cordis |
| 3 | runtime context 被 `includeRuntimeContext: false` 抑制 | 该段落属于可选上下文 | `required: true`；仍被 `complete` persona 影响时在 README 说明 |
| 4 | provider 同步执行，每步读盘 | `PromptContext.text` 是同步 provider | 按 mtime/size 做 memo；只在 key 变化时读文件 |
| 5 | 父根读取越过工作区沙箱/信任边界 | 需求本身就是读工作区之上 | 只读、只读固定候选名、不递归、不写；README 说明标记应放在可信父目录 |
| 6 | 设置写入被更高层覆盖，UI 显示“已保存”但实际没生效 | `configForms.set` 可能返回 false | 检查返回值；失败时恢复显示并提示“被 profile/更高层覆盖” |
| 7 | 表单里看不到 `parentRootMarker` | 设置表单只展示 volatile 字段 | 字段必须 `.volatile()`；构建探针断言 |
| 8 | 行 id/order 与上游冲突 | `settings.general.item` 是共享槽位 | 使用独立 id `parent-root-marker`，不遮蔽；order 11.6；构建期/运行期核查 |
| 9 | HMR/重复注册导致两行或重复 context | 注册未清理 | 所有 `slots.register`、`systemPrompt.context`、`settings.configure` 放 `ctx.effect`；Client factory 保持无副作用 |
| 10 | 父级文件很大，注入膨胀 | 无内置预算约束 | 单文件 256 KiB、总 32 KiB；宽泛先丢、最具体截断 |
| 11 | 标记名是常见文件名，误命中 | 用户配置 | UI 提示使用独特名字；默认 `.dsh-parent-root`；文档示例 |
| 12 | 父级目录含多个同内容 `AGENTS.md`/`CLAUDE.md` | 与内置相同的候选组语义 | trim 后内容去重，保留最早（宽泛）者 |
| 13 | 现有会话看不到变化 | 快照只在组装时更新 | 下一次请求前自动重算；无需重启；文档说明“新请求生效” |
| 14 | 读取权限失败导致整个 prompt 失败 | provider 抛出异常 | provider 全捕获，返回 `''`；记录 warning |
| 15 | 用户把标记放在 builtinRoot 内部，期待继承 | 语义边界 | 文档明确：标记必须**严格位于内置项目根之上**；UI 说明同一句 |

---

## 8. 需要确认的决策点

| # | 决策点 | 备选 | 建议 |
| --- | --- | --- | --- |
| 1 | 默认标记名 | `.dsh-parent-root` / `.dsh-workspace-root` / 其他 | **`.dsh-parent-root`**（语义明确、不暗示 GUI Workspace 实体） |
| 2 | 空值语义 | 空 = 禁用 / 空 = 恢复默认 | **空 = 禁用**；另有“恢复默认”按钮走 `unset` |
| 3 | 内置根 markers | 固定 `.git` / 增加隐藏 Config | **v1 固定 `.git`**；文档说明；后续再加 `builtinMarkers` 配置 |
| 4 | 注入通道 | `systemPrompt.context` / `agent/pre-step` 消息 / `systemPrompt.section` | **`systemPrompt.context`** |
| 5 | 设置形态 | 通用行 / 独立设置页 | **通用行**（单字段，符合 slot 语义） |
| 6 | 生效方式 | volatile 即时 / 普通字段重启 | **volatile 即时** |
| 7 | 父根搜索 | 最近标记 / 最外层标记 | **最近标记** |
| 8 | 展示路径 | 绝对路径 / 相对 cwd | **绝对路径** |
| 9 | 预算 | 固定 32 KiB / 暴露配置 | **v1 固定 32 KiB**，README 记录 |

---

## 9. 实施步骤（获批后执行）

1. **采纳构建系统**
   - `node build-system/sync.mjs dsh-parent-instructions`
   - 若 `scripts/host-contract.mjs` 由模板生成，替换其 TODO。
2. **写清单与补丁**
   - `package.json`：名称、版本 `0.1.0`、`type: module`、`exports`（`.` / `./client` / `./package.json` / `./locale/*.json`）、`dsh.bundle.patch`、`dsh.client`（`platform: web`、`immediately: true`、inject 三个包）、`files`、scripts、engines、peer、`@deepseek-ai/schemastery` 精确依赖。
   - `cordis.patch.yml`：插入行 `dsh-parent-instructions`，`name: '@local/dsh-parent-instructions'`，`config.parentRootMarker: .dsh-parent-root`。
3. **Host 半 `index.js`**
   - `Config`（volatile 字段）；`apply`；`settings.configure`；`systemPrompt.context`；发现/读取/去重/预算/渲染/缓存；错误吞掉并记日志。
4. **Client 半 `client.js`**
   - 模块加载器包装；`settings.general.item` 行；`configForms` 读写/订阅/重置；校验与状态；locale 注册；命名空间 CSS。
5. **资源与文案**
   - `locale/zh.json`、`locale/en.json`（插件页 `meta.title` / `meta.description`）；`icon.svg`（父/子节点或“父根标记”意象；原创、单图）。
6. **依赖与构建**
   - `node scripts/build.mjs --pin @deepseek-ai/schemastery@3.18.4`；
   - `npm run build`（物化真实文件并自动 verify）。
7. **契约探针 `scripts/host-contract.mjs`**
   - Host：导出 `apply`/`Config`；`Config({})` 默认 `.dsh-parent-root` 且字段 volatile；`apply` 调用了 `settings.configure({auto:false})`、注册了 `parent-workspace-instructions`（order 250、required true）；用临时目录验证 `builtinRoot`/`parentRoot`/候选/去重/预算/无标记/非法标记。
   - Client：在 Node `vm` 桩（React/DOM/configForms）下执行 `client.js`，断言行注册 `id/order`、读写字段、空值禁用、非法字符拒绝、没有直接写 `document`/`window` 的副作用。
8. **README 与版本**
   - README 首行声明：`最后实质性修改于Harness版本：0.2.2-rc.3`；
   - 写清使用、原理、设置、限制、构建、故障排查、版本契约。
9. **安装与运行时验证**
   - `plugin_manager` `install_bundle`，target 为本插件绝对目录（`link:` 就地安装，不复制）。
   - `Config.listConfigs` 查 `@local/dsh-parent-instructions`；`Slots.listSubTree` 查 `settings.general.item` 的 `parent-root-marker`。
10. **Git/GitHub**
    - 在本插件目录内 `git init`，`.gitignore` 至少 `.DS_Store`、`node_modules/`、`.cache/`、`*.log`；
    - 创建并推送同名仓库 `git@github.com:hluica/dsh-parent-instructions.git`，默认分支 `main`；
    - 提交实现与文档；不得在 `local-plugins/` 根目录初始化仓库。
11. **回填 FEASIBILITY**
    - 实现后在本文件顶部追加“实现阶段更新”，记录与报告的差异、验证结果与未验证项（沿用 `dsh-font-settings` 的体例）。

---

## 10. 验证与验收

### 10.1 构建与静态检查

- `npm run verify` 全部通过：无符号链接/Finder 替身/边角文件；依赖与 `deps.lock.json` 逐字节一致；清单契约（exports、dsh.bundle.patch、dsh.client、locale 锚点、icon、files[]）；Host/Client 源码可解析；Host 在全新进程可导入；本插件契约探针全部断言通过。
- `node build-system/sync.mjs --check` 无差异（5 个共享文件与参考副本一致）。

### 10.2 运行时检查

1. 新会话（子工作区 cwd 位于带 `.git` 的插件目录）：
   - runtime context 快照中出现 `Parent workspace instructions ...`；
   - 内置 `agent-instructions` 基线仍包含子工作区自身的 `AGENTS.md`；
   - 父级 `local-plugins/AGENTS.md` 不在内置基线中（因为 `.git` 截断），只在本插件的补充段出现。
2. 父根设置：
   - 设置 → 通用出现“父工作区标记”行；
   - 改为另一个存在的标记名并保存，下一次请求的父级段落切换；
   - 清空并保存，段落消失；
   - “恢复默认”恢复 `.dsh-parent-root`；
   - 输入 `../x`、`a/b`、`.` 等被拒绝并给出原因。
3. 无标记 / 标记在 builtinRoot 内：不出现补充段；无重复的 `local-plugins/AGENTS.md`。
4. 现有会话：修改标记后，下一次请求的快照更新；不需要重启 Host/刷新页面。
5. `minimal` preset：内置指导不存在，本插件只补充父级；README 已说明。
6. 子代理：以父 cwd 启动的子代理看到同样的补充；以子工作区 cwd 启动的子代理按自己的 `builtinRoot` 计算。
7. 失败路径：无权限文件、超大文件、缺失文件不导致请求失败；日志有 warning。

### 10.3 验收标准

- [ ] 子工作区（自身 `.git`）能看到父级链路指导，且不重复子工作区自身指导。
- [ ] 设置 UI 可定义/清空/恢复全局 `parentRootMarker`，保存失败有明确提示。
- [ ] 不修改内置插件、不覆盖 preset、不写 profile 之外的路径。
- [ ] `npm run build`、`npm run verify` 通过；README/FEASIBILITY 与实现一致。
- [ ] 新插件有独立 Git 仓库并推送到 `hluica/dsh-parent-instructions`。

---

## 11. 参考坐标

| 对象 | 路径 / 符号 |
| --- | --- |
| 内置发现与项目根 | `app.asar → dsh/node_modules/@deepseek-ai/dsh-agent-instructions/src/files.ts`：`findProjectRoot`、`ancestorChain`、`discoverInstructionFiles`、`loadBaselineInstructionSet` |
| 内置候选与默认值 | 同上 `src/config.ts`：`DEFAULT_PROJECT_ROOT_MARKERS`、`DEFAULT_INSTRUCTION_FILE_CANDIDATES`、`DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES` |
| 内置渲染框架 | 同上 `src/render.ts`：`buildInstructionText`、`AGENT_INSTRUCTIONS_INTRO` |
| 内置清单入口 | 同上 `src/index.ts`：`inject = ['agents','workingDirectory']`、`agent/pre-step`、`tools/result` |
| `PromptContext` | `app.asar → dsh/node_modules/@deepseek-ai/dsh-system-prompt/src/index.ts:78-90` |
| `AssembleContext.agent` | `app.asar → dsh/node_modules/@deepseek-ai/dsh-agent/src/runtime-types.ts:19-22` |
| runtime context 包装 | `app.asar → dsh/node_modules/@deepseek-ai/dsh-agent-loop/src/runtime-context.ts:164-179` |
| 工作目录服务 | `app.asar → dsh/node_modules/@deepseek-ai/dsh-working-directory/src/index.ts:141`（`get(session)`） |
| 设置表单与 volatile | `app.asar → dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/README.zh.md:32-40`；`dsh-settings/README.zh.md:33-39` |
| `settings.configure` | `app.asar → dsh/node_modules/@deepseek-ai/dsh-settings/src/index.ts:266` |
| 槽位活体目录 | `cordis_inspect_query` → Client `Slots.listSubTree{root:"settings.general.item"}`；本版本占用者含 `custom-css` 11.5、`transcript-view` 12 |
| 设置 UI 直接先例 | `local-plugins/dsh-custom-css/index.js`（`settings.configure`）、`client.js`（`configForms`、行注册、locale、清理） |
| 构建系统 | `local-plugins/BUILD-SYSTEM.md`；`build-system/scripts/*` |
| preset 层（为何不覆盖） | `app.asar → dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml:604`（禁用 host 行）、`presets/ptc.patch.yml:15-18`（preset 内声明）、`presets/standard.patch.yml:44`（`!!js` baseUrl） |
| 报告体例先例 | `local-plugins/dsh-font-settings/FEASIBILITY@0.2.1-rc.2.md`、`local-plugins/dsh-custom-css/FEASIBILITY@0.2.1-rc.3.md` |

---

## 12. 交付检查（按 `AGENTS.md`）

- [x] 代码变化已在当前 FEASIBILITY 文档中记录（实现阶段更新见顶部）。
- [x] README 已反映当前 DSH 版本的事实，首行版本声明正确。
- [x] 已按 `BUILD-SYSTEM.md` 完成 `npm run build` / `npm run verify`，全部通过。
- [x] 行为/接口/契约变化已评估版本号（首版 `0.1.0`）。
- [x] 插件特有的操作说明（设置、标记放置、限制、故障排查）已写入本插件 `README.md`。
- [x] 新插件已建立独立 Git 仓库并推送至同名 GitHub 仓库。

---

### 实现与仓库状态

实现产物已生成并本地安装；`README.md` 已记录使用、原理、构建与限制。用户已测试设置页与父级注入可用（2026-11-15）。临时父/子工作区 fixture 已删除。

独立 Git 仓库已在插件目录内初始化，默认分支 `main`，并推送至 `https://github.com/hluica/dsh-parent-instructions`（PUBLIC）。`.gitignore` 忽略 `.DS_Store`、`node_modules/`、`.cache/` 与 `*.log`；构建产物与本地缓存不进入提交。
