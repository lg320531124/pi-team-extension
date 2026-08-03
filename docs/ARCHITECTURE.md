# pi-team-extension — Agent Team 协调扩展 for @earendil-works/pi

> 给 pi 加上多 Agent 团队协作：Leader 分派任务、Worker 认领执行、成员间直发消息、共享任务板、Git worktree 隔离。

## 目录

> [!note]+ 📑 目录
>
> - [[#一、项目概览]]
>   - [[#1.1 解决了什么]]
>   - [[#1.2 基本信息]]
> - [[#二、架构设计]]
>   - [[#2.1 整体架构图]]
>   - [[#2.2 核心数据流]]
>   - [[#2.3 模块清单]]
> - [[#三、核心模块]]
>   - [[#3.1 TeamCoordinator — 团队编排器]]
>   - [[#3.2 TeamAgentSession — 轻量 Agent 包装]]
>   - [[#3.3 MessageBus — 进程内消息总线]]
>   - [[#3.4 Mailbox — 每成员邮箱队列]]
>   - [[#3.5 GitWorktree — 文件隔离]]
>   - [[#3.6 schema.ts — YAML 解析与校验]]
>   - [[#3.7 MCP 工具注入]]
>   - [[#3.8 OpenViking 长期记忆]]
> - [[#四、集成方式]]
>   - [[#4.1 pi Extension 模式（推荐）]]
>   - [[#4.2 独立 CLI 模式]]
>   - [[#4.3 Programmatic API]]
> - [[#五、YAML 团队定义]]
> - [[#六、竞品对比]]
> - [[#七、v1 限制与路线图]]

---

## 一、项目概览

### 1.1 解决了什么

pi 本身是单 Agent ReAct 循环。这个扩展给它加上**多 Agent 对等协作**：

- **命名成员**：一个 Leader + N 个 Worker，各自有角色和工具集
- **直发消息**：`send_message(to="reviewer", content="...")` — 任何 agent 发消息给任何 agent，不经过 Leader 路由
- **广播**：`broadcast("全体注意…")` 一发全收
- **共享任务板**：`team_tasks` 工具 — Leader 加任务、Worker 认领/完成，支持 `blocked_by` 依赖
- **Git worktree 隔离**：每个 Worker 在自己的 worktree 里写文件，零冲突
- **Mailbox → steering 桥**：消息到达后经 pi 原生 `agent.steer()` 注入，下一轮 ReAct 被消费
- **自动错误通知**：Worker 执行报错后自动通知 Leader（对标 CC agent-teams v2.1.198+）

### 1.2 基本信息

| 维度 | 信息 |
|------|------|
| 仓库 | [github.com/lg320531124/pi-team-extension](https://github.com/lg320531124/pi-team-extension) |
| 版本 | 0.1.0 |
| 语言 | TypeScript (ES2022, ESM) |
| 运行时 | Bun / Node.js |
| 依赖 | 仅 `@earendil-works/pi`（pi-agent-core、pi-ai、pi-coding-agent），**不依赖 oh-my-pi** |
| 类型 | 完全在 pi 类型系统之上，无第三方 agent 框架 |
| 许可 | MIT |
| 包管理 | bun (lock: `bun.lock`) |

[[#目录|↑ 返回目录]]

---

## 二、架构设计

### 2.1 整体架构图

```
┌──────────────────────────────────────────────────────────────┐
│                      TeamCoordinator                         │
│                                                              │
│  构造函数: TeamDefinition + TeamConfig + ModelResolver       │
│  start() → 初始化 state → 注册 Mailbox → 建 Session → 并发跑 │
│  stop()  → 停所有 session → 清理 worktree → 删 mailbox 文件 │
│                                                              │
│  ┌──────────────────────────────────────────────────┐       │
│  │                 MessageBus                        │       │
│  │  - mailboxes: Map<name, Mailbox>                 │       │
│  │  - history: TeamMessage[]                        │       │
│  │  - sentCount: Map<name, number> (防死循环)        │       │
│  │                                                  │       │
│  │  send(from, to, content)    → Mailbox.push()     │       │
│  │  broadcast(from, content)   → 所有非自己 Mailbox │       │
│  │  register/unregister/has/roster                  │       │
│  └──────┬───────────────────────────────────────────┘       │
│         │                                                    │
│  ┌──────▼────────────────────────────────────┐              │
│  │         N 个 Mailbox                       │              │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐ │              │
│  │  │ leader   │  │ worker-1 │  │ worker-2 │ │              │
│  │  │ mailbox  │  │ mailbox  │  │ mailbox  │ │              │
│  │  │          │  │          │  │          │ │              │
│  │  │ queue[]  │  │ queue[]  │  │ queue[]  │ │              │
│  │  │ + JSON   │  │ + JSON   │  │ + JSON   │ │              │
│  │  │ file     │  │ file     │  │ file     │ │              │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘ │              │
│  └───────┼──────────────┼──────────────┼───────┘              │
│          │ drain()      │ drain()      │ drain()              │
│          ▼              ▼              ▼                      │
│  ┌───────────────────────────────────────────────┐           │
│  │        TeamAgentSession × N                    │           │
│  │                                               │           │
│  │  ┌────┐  500ms timer  ┌──────────────────┐   │           │
│  │  │Agent│◄─────────────│ Mailbox → steer() │   │           │
│  │  │     │              │ (steering bridge)  │   │           │
│  │  └────┘               └──────────────────┘   │           │
│  │                                               │           │
│  │  Tools: bash + read/write/edit/grep/find/ls  │           │
│  │       + send_message + broadcast + team_tasks │           │
│  │                                               │           │
│  │  CWD:  leader → repo root                    │           │
│  │        worker  → 自己的 git worktree 路径      │           │
│  └───────────────────────────────────────────────┘           │
│                                                              │
│  Worker 有自己的 GitWorktree                                 │
│  ┌──────────────────────────────────────┐                    │
│  │  git worktree add -b team/{name}     │                    │
│  │    <repo>/.pi/worktrees/{name}       │                    │
│  │                                      │                    │
│  │  contributionState() →               │                    │
│  │    clean → cleanup() 删             │                    │
│  │    committed → merge 回主分支 → 删   │                    │
│  │    modified/冲突 → 保留              │                    │
│  └──────────────────────────────────────┘                    │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 核心数据流

```
Worker 调 send_message(to="reviewer", content="PR 看完了")
  → createSendMessageTool handler
  → MessageBus.send(from="coder", to="reviewer", content="PR 看完了")
  → 检查 sender 消息上限（maxMessagesPerAgent）
  → reviewer 的 Mailbox.push(msg)
  → 内存 queue + JSON 文件持久化 (~/.pi-teams/{team}/inboxes/reviewer.json)
  → MessageBus emit("message")
  → TeamCoordinator 转发给外部监听者

500ms 后:
  → TeamAgentSession 的 bridgeTimer 触发
  → Mailbox.drain() 清空队列，返回所有待处理消息
  → 每条消息转为 AgentMessage { role: "user", content: "[team] coder says: PR 看完了" }
  → agent.steer(message) 注入
  → pi ReAct loop 下一轮消费 → reviewer 看到消息，开始干活
```

### 2.3 模块清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/index.ts` | 37 | 公共 API 导出（所有类型、类、函数） |
| `src/extension.ts` | 146 | pi Extension 入口，注册 `/team` 命令 |
| `src/cli.ts` | 113 | 独立 CLI（`pi-team run`），给非 pi 用户 |
| `src/team/coordinator.ts` | 290 | 编排器：建 Session、连 Mailbox、并发跑、生命周期管理 |
| `src/team/session.ts` | 170 | 轻量 Agent 包装：system prompt 拼装 + mailbox bridge + 错误通知 |
| `src/team/message-bus.ts` | 99 | 进程内消息路由：send/broadcast/register/历史记录/发送计数 |
| `src/team/mailbox.ts` | 86 | 每成员邮箱：内存队列 + JSON 文件持久化 + capacity 限制 |
| `src/team/worktree.ts` | ~150 | Git worktree v2：`.pi/worktrees/` 隔离、稳定分支、贡献分类（contributed/modified/clean）、安全清理 |
| `src/team/schema.ts` | 266 | YAML 解析和校验：优先 `yaml` 包，回退手写解析器 |
| `src/team/types.ts` | 131 | 所有 TS 类型定义（TeamDefinition/TeamState/TeamMessage/TeamTask 等） |
| `src/team/tools/send-message.ts` | -- | `send_message` AgentTool 实现 |
| `src/team/tools/broadcast.ts` | -- | `broadcast` AgentTool 实现 |
| `src/team/tools/team-tasks.ts` | -- | `team_tasks` AgentTool 实现（Leader 加任务/Worker 认领完成） |
| `src/team/mcp.ts` | -- | 轻量 MCP client + 工具注入：连接 stdio/HTTP 服务器，`mcp_<server>_<tool>` 前缀，`loadMcpServers` / `loadGlobalMcpServers` / `mergeMcpServers` / `McpClient` |
| `src/team/default-team.ts` | -- | `start_team` 工具的默认团队构造（按角色的默认 worker 拆分） |
| `src/memory/openviking.ts` | 163 | OpenViking 长期记忆：`ovRecall`（召回）/ `ovCapture`（捕获）/ `loadOvConfig` / `ovHealthy` / 熔断器 |

[[#目录|↑ 返回目录]]

---

## 三、核心模块

### 3.1 TeamCoordinator — 团队编排器

`src/team/coordinator.ts:45`

整个扩展的入口类。继承 `EventEmitter`，向外暴露四个事件：`message`、`agent_done`、`agent_error`、`team_done`。

**构造函数**接收三个参数：
- `TeamDefinition` — YAML 解析出的团队定义
- `TeamConfig` — 运行时配置（apiKey、defaultModel、cwd、mailbox 容量、消息上限、轮询间隔）
- `modelResolver` — 把 `"claude-sonnet-4-6"` 这种字符串 ID 解析为 pi 的 `Model` 对象。调用方注入，扩展本身不耦合任何模型注册表

**`start()` 流程**（70 行，清晰线性）：

```
1. new MessageBus()
2. new Mailbox(leader) + N × new Mailbox(worker) → bus.register()
3. 从 modelResolver 解析 Leader 模型
4. new TeamAgentSession(leader) — 传入 builtinTools + teamTools + mailbox + messageBus
5. 标记 leader handle.status = "running"
6. 对每个 Worker：
   a. 如果 worktree !== false → GitWorktree.find() 复用或 create() → 新 worktree 路径（`.pi/worktrees/<worker>`，分支 `team/<worker>`）
   b. 从 modelResolver 解析 Worker 模型
   c. new TeamAgentSession(worker) — builtinTools 的 cwd 指向 worktree 路径
   d. 标记 worker handle.status = "running"
7. Promise.allSettled([leader.run, worker1.run, worker2.run, ...])
8. 全部完成后 emit("team_done")
```

**关键设计决策**：

- **worktree 创建失败不崩整个 team**（`coordinator.ts:155-161`）：如果 cwd 不是 git 仓库导致 worktree 创建失败，回退到共享 cwd + emit `agent_error` + 继续跑，不抛异常
- **Leader 和 Worker 并发执行**：不是先跑 Leader 再跑 Worker。MessageBus 负责路由，谁先开始干活由模型推理速度决定。pi 的 Agent ReAct 循环互不阻塞
- **任务板 tasks 数组是共享引用**（`coordinator.ts:251-258`）：Leader 和所有 Worker 的 `team_tasks` 工具共享同一个 `TeamTask[]`。并发读写靠 in-process 单线程保证安全
- **stop() 按序清理**：先停 session → 清 worktree → 删 mailbox 文件。Worker 先停的 worktree 不会被后停的 Worker 用到——每个 Worker 有独立的 GitWorktree 实例

[[#目录|↑ 返回目录]]

### 3.2 TeamAgentSession — 轻量 Agent 包装

`src/team/session.ts:44`

**为什么不用 oh-my-pi 的 AgentSession？**

oh-my-pi 的 `AgentSession`（16KB）打包了 session 持久化、compaction、auto-retry、extension runner、bash history、settings manager——大部分对 team 模式冗余。`TeamCoordinator` 自己管生命周期（start/stop/error recovery），不需要另一个 session manager。

这个包装只做三件事：
1. 构建 system prompt（角色 + 团队上下文 + 通信/任务指引 + 初始任务）
2. 创建 pi `Agent` 实例，注册所有工具
3. 运行 Mailbox → steering bridge（定时器轮询 → drain → steer）

**System Prompt 构建**（`session.ts:105-125`）：

```
{role}                          ← YAML 里定义的角色描述

{leaderHint}                    ← "你是 TEAM LEADER，拆分任务、分派、仲裁"
                                ← 或 "你是 WORKER，认领任务、做完、汇报"

Your name: {name}
Other team members: {others}    ← 花名册
Working directory: {cwd}

Communication: send_message / broadcast 用法说明
Tasks: team_tasks 用法说明

Initial task: {task}            ← YAML 里定义的初始任务
```

**Mailbox → steering bridge**（`session.ts:127-139`）：

这是消息注入的核心机制。`setInterval(pollIntervalMs)` 定时：
1. `mailbox.drain()` 清空队列
2. 每条消息构造为 `AgentMessage { role: "user", content: "[team] {from} says: {content}" }`
3. `agent.steer(message)` 注入 pi 的 steering 队列

pi ReAct 循环每轮开始时会 `drain()` steering 队列，所以消息在下一轮自然被消费。不需要改 pi 的 Agent 源码。

**自动错误通知**（`session.ts:84-97`）：

订阅 agent 事件。当 `agent_end` 事件到达且 `agent.state.errorMessage` 非空时，如果自己是 Worker，自动通过 MessageBus 给 Leader 发一条 `[system] turn ended with error: ...` 消息。对标 CC agent-teams v2.1.198+ 的行为。

**设计权衡**：
- 用 `setInterval` 轮询而非事件驱动，是**显式选择 v1 简单方案**。ZMQ pub-sub 或 node EventEmitter 链式触发在单进程下也能做，但团队一开始跑就是 N 个并发 session，用 setInterval 避免 mailbox 写入方和 draining 方的锁竞争
- `agent.prompt(initialPrompt)` 只 kick off 一次。后续的 steering 消息通过 agent.steer() 注入后，pi 自己的 ReAct 循环会继续处理。Agent 状态机保证：done → steer 有消息 → agent.continue() 唤醒

[[#目录|↑ 返回目录]]

### 3.3 MessageBus — 进程内消息总线

`src/team/message-bus.ts:16`

v1 实现是进程内 EventEmitter。API 设计为传输无关——`send/broadcast/register` 签名固定，未来换 ZMQ 只改内部实现。

**核心方法**：

| 方法 | 行为 |
|------|------|
| `register(name, mailbox)` | 注册 agent → mailbox 映射 |
| `send(from, to, content, maxPerAgent?)` | 点对点发送。检查发送者消息上限（防死循环），构造 TeamMessage，push 到接收者 mailbox |
| `broadcast(from, content, maxPerAgent?)` | 发给除自己以外的所有注册成员 |
| `roster()` | 返回所有已注册的 agent 名 |
| `sentBy(name)` | 查询某 agent 已发送消息数 |

**消息上限机制**（`message-bus.ts:49-54`）：

```ts
const count = (this.sentCount.get(from) ?? 0) + 1;
if (maxPerAgent !== undefined && count > maxPerAgent) {
  throw new Error(`Agent "${from}" exceeded message cap (${maxPerAgent}). Possible infinite loop.`);
}
```

这是防 Agent 陷入"来回发消息"死循环的保险。默认每 agent 200 条 `TeamConfig.maxMessagesPerAgent`。因为这工具是给 LLM 作为 tool 用的，上限触发时 LLM 会收到工具调用异常 → 模型自然中断通信循环。

**Mailbox 容量限制**：除了发送上限，接收端也有容量限制（默认 10 条 `TeamConfig.mailboxCapacity`）。mailbox 满时 `push()` 返回 false，调用方（send）返回 false，LLM 看到工具返回失败 → 知道对方信箱已满 → 等待或换策略。

[[#目录|↑ 返回目录]]

### 3.4 Mailbox — 每成员邮箱队列

`src/team/mailbox.ts:24`

对标 CC agent-teams 的 `~/.claude/teams/{team}/inboxes/{agent}.json`。这里持久化到 `~/.pi-teams/{team}/inboxes/{agent}.json`。

**存储格式**：JSONL（每行一个 JSON 对象），`appendFile` 追加写入。

**容量控制**：`push()` 时检查 `queue.length >= capacity`，满了返回 false。这是"一个 agent 的收件箱不能无限堆积"的硬限制。

**持久化语义**：
- `push()` 先写内存队列，再 `appendFile` 写入文件。文件写入是 best-effort（catch 了异常），**内存队列才是权威数据源**
- `drain()` 只清内存队列，不碰文件。下一次 `push()` 会追加新行，所以文件是增量日志而非当前状态快照
- `clearFile()` 在 team shutdown 时调用，`rm(filePath, { force: true })` 删整个文件

**恢复场景**：如果进程崩溃，`~/.pi-teams/{team}/inboxes/*.json` 里有未投递的消息。v1 未实现 replay（见路线图），但文件格式设计为 JSONL 就是为了支持逐行读取恢复。

[[#目录|↑ 返回目录]]

### 3.5 GitWorktree — 文件隔离

`src/team/worktree.ts:26`

最简方案，~70 行。oh-my-pi 的 `isolation-runner.ts`（16KB）支持 nested repos、baseline capture、delta patch、merge back——对 team v1 过度设计。这里只需"给每个 Worker 一个不受打扰的工作目录"。

**创建**（`worktree.ts:36-47`）：

```bash
git worktree add --detach -b team/{workerName}/{snowflake} /tmp/pi-team-{workerName}-{snowflake}
```

- `--detach`：不跟踪上游分支，Worker 改的东西不会意外推送到 origin
- `-b`：建新分支，命名带时间戳。Worker 的改动都在这个分支上，如果需要回溯可以 checkout
- 路径在 `/tmp`：临时目录，重启自动清理

**清理**（`worktree.ts:56-69`）：

```bash
git worktree remove --force {path}  # 先删 worktree 目录
git branch -D {branch}               # 再删分支
```

两步都可能因为路径/分支已被手动删除而失败，所以都 catch 了异常。

**captureDeltaPatch()**（`worktree.ts:50-53`）：Worker 完成后可选调用，`git diff HEAD` 输出统一 diff。Leader 可以收集所有 Worker 的 patch 做合并。

[[#目录|↑ 返回目录]]

### 3.6 schema.ts — YAML 解析与校验

`src/team/schema.ts:23`

**解析策略**：优先 `import("yaml")`（动态导入，不在 dependencies 里），如果不可用，回退到手写解析器。

**为什么手写解析器？** YAML 只在 TeamCoordinator 构造时解析一次，不是热路径。团队定义文件的 YAML 子集非常小（嵌套 map + `|` 块标量 + 简单标量），不需要完整的 YAML 1.2 解析器。手写解析器实现 100 行，比引入 `js-yaml` 依赖小得多。`yaml` 包在 `devDependencies` 里（用于测试），生产环境可选。

**手写解析器处理的 YAML 子集**（`handRollYaml:164`）：

| 语法 | 支持 | 示例 |
|------|------|------|
| 嵌套 map（2 空格缩进） | ✓ | `leader:\n  name: architect` |
| 块标量 `key: \|` | ✓ | `role: \|\n  You are...` |
| 序列 `- item` | ✓ | 基本支持 |
| 空行/注释跳过 | ✓ | `# comment` 行被跳过 |
| 引用 `&anchor` / `*alias` | ✗ | 不需要 |
| 流式集合 `{a: b}` | ✗ | 不需要 |
| 多行字符串 `>` | ✗ | 不需要 |
| 标签 `!!str` | ✗ | 不需要 |

**校验**：`validateTeam → validateLeader + validateWorker` 三层。关键规则：
- `leader.name` 不能和任何 worker 名重复
- `role` 必填，`task` 可选
- `thinkingLevel` 只能从 `["minimal","low","medium","high","xhigh","max"]` 中选
- Worker 的 `task` 有默认值：`"Wait for the leader to assign work via send_message or team_tasks."`

[[#目录|↑ 返回目录]]

---

### 3.7 MCP 工具注入

`src/team/mcp.ts` + `src/extension.ts:registerMainSessionMcpTools`

pi 本身没有原生 MCP 支持，扩展自带一个极简 MCP client 来补上这个能力，并把 MCP 工具注入到主会话和每个团队成员的工具集中。

**服务器来源**：项目 `.mcp.json` 的 `mcpServers` + 全局 Claude Code config 里的服务器。`loadGlobalMcpServers()` 读取全局配置，`mergeMcpServers()` 把两者合并去重。

**连接与注入**：stdio 服务器用子进程启动，HTTP 用 `fetch`；每台服务器连接有 8s 上限。工具以 `mcp_<server>_<tool>` 命名注册，避免不同服务器间的工具名冲突。

**最佳努力**：`registerMainSessionMcpTools` 在 `session_start` 时阻塞等待（确保首轮前工具已注册），但某台服务器连接失败会被 `log + 跳过`，绝不停会话或团队启动。

### 3.8 OpenViking 长期记忆

`src/memory/openviking.ts` + `src/extension.ts`

OpenViking（"Context Database for AI Agents"）提供长期语义记忆（本地 REST 服务器，默认 `http://127.0.0.1:1933`）。本模块给 pi 与 Claude Code hooks 插件相同的能力。

```
before_agent_start → ovRecall(query) →  [长期记忆] 注入（非可执行参考上下文）
turn_end          → ovCapture(sessionId, user, assistant) → 写 session + commit
每 3–4s 超时        → 失败后 30s 融合器（circuit breaker）→ 记忆故障绝不阻塞会话
```

**配置**：环境变量优先于 `~/.openviking/ovcli.conf`（详见 README「OpenViking long-term memory」）。`OPENVIKING_MEMORY_ENABLED=0` 可关闭；关闭后召回/捕获均跳过。

**关键设计**：
- 召回的记忆注入为 `[长期记忆]` 文本块，显式标注为非可执行参考上下文（不是新用户输入），避免模型把它当后续用户输入而偏离当前问题。
- session id 稳定按项目目录哈希（`pi-<cwdHash>`），让记忆跨会话累积在同一 session 里。
- 所有请求短超时 + 熔断，记忆是 best-effort，绝不拖慢或破坏对话。

[[#目录|↑ 返回目录]]

---

## 四、集成方式

### 4.1 pi Extension 模式（推荐）

`src/extension.ts`

pi 的扩展加载机制：`package.json` 声明 `"pi": { "extensions": ["./src/extension.ts"] }`，pi 的 `core/extensions/loader.ts:readPiManifest` 读取这个字段，import 默认导出，调用它并传入 `ExtensionAPI`。

```bash
pi install lg320531124/pi-team-extension
pi list   # 确认已加载
```

然后 pi 内部：

```
/team run test/team-demo.yml
```

**优势**：直接用 pi 的模型注册表（不需要单独配 `PI_API_KEY`）、pi 的模型选择器（`/model` 切模型立即生效）、pi 的 UI 通知系统。`modelResolver` 通过 `ctx.modelRegistry.find()` / `ctx.modelRegistry.getAll()` 实现，完全复用 pi 的 provider 配置。

**/team 命令处理流程**（`extension.ts:26-144`）：

```
1. 解析子命令 — 只支持 "run"，其他报 "Usage: /team run <file.yml>"
2. resolve(ctx.cwd, yamlPath) — 相对路径转绝对
3. readFile + parseTeamYaml → TeamDefinition
4. 从 ctx.model 拿当前模型 + ctx.modelRegistry.getApiKeyAndHeaders 拿 API key
5. 构建 modelResolver — 支持 "provider/id" 格式和纯 "id" 模糊搜索
6. new TeamCoordinator + 绑定事件（message/agent_done/agent_error/team_done → ctx.ui.notify）
7. coordinator.start()
```

### 4.2 独立 CLI 模式

`src/cli.ts`

给不跑 pi 的用户。命令行：

```bash
export PI_API_KEY=sk-...
export PI_DEFAULT_MODEL=claude-sonnet-4-6
pi-team run test/team-demo.yml
```

支持三个命令：`run`（启动 team）、`status`/`stop`（v1 未实现，team 状态在进程内）。

**v1 限制**：CLI 的 modelResolver 是 placeholder（`cli.ts:92-97`），始终返回 undefined。因为 CLI 不在 pi 进程内，无法访问 pi 的 model 注册表。CLI 主要用于开发和测试，生产建议走 Extension。

### 4.3 Programmatic API

```ts
import { TeamCoordinator, parseTeamYaml } from "pi-team-extension";

const yaml = await readFile("test/team-demo.yml", "utf8");
const teamDef = await parseTeamYaml(yaml);

const coordinator = new TeamCoordinator(
  teamDef,
  { apiKey: "...", defaultModel: "claude-sonnet-4-6", cwd: process.cwd() },
  (id) => myModelCatalog.resolve(id),  // 你的 pi Model resolver
);

coordinator.on("message", (m) => console.log(`[${m.from} → ${m.to}] ${m.content}`));
coordinator.on("agent_done", (name) => console.log(`✓ ${name}`));
coordinator.on("team_done", () => console.log("team complete"));

await coordinator.start();
```

所有公共类型都有导出，包括 `TeamAgentSession`、`GitWorktree`、`MessageBus`、`Mailbox`、`parseTeamYaml`、以及独立的工具函数 `createSendMessageTool/createBroadcastTool/createTeamTasksTool`。

[[#目录|↑ 返回目录]]

---

## 五、YAML 团队定义

```yaml
team:
  name: code-review-squad
  description: "三人代码审查队"

  leader:
    name: architect
    role: |
      You are the architect and TEAM LEADER.
      Decompose the goal into tasks, dispatch to workers,
      arbitrate disagreements, and synthesize the final result.
    model: claude-sonnet-4-6
    thinkingLevel: high
    # task 不写，默认 "Decompose the goal into tasks and dispatch them to workers."

  workers:
    coder:
      role: |
        You are a senior developer. Claim coding tasks,
        implement them with tests, and report to the leader.
      task: Wait for the leader to assign you a task.
      model: claude-sonnet-4-6
      # worktree 不写，默认 true → 自己的 git worktree

    reviewer:
      role: |
        You are a code reviewer. Review code the coder sends you,
        call out bugs and suggest improvements.
      task: Wait for the coder to send you code.
      thinkingLevel: medium
      worktree: false  # 不需要改文件，共享 leader cwd
```

**字段说明**：

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `team.name` | ✓ | -- | 团队名，用于 worktree 分支名和 mailbox 路径 |
| `team.description` | -- | -- | 文档用途，不影响运行 |
| `leader.name` | ✓ | -- | Leader 的名字，不能和 worker 名重复 |
| `leader.role` | ✓ | -- | 系统 prompt 正文（角色描述） |
| `leader.task` | -- | 自动生成 | 初始任务。Leader 默认 "Decompose the goal…" |
| `leader.model` | -- | config.defaultModel | 模型 ID，如 `"claude-sonnet-4-6"` |
| `leader.thinkingLevel` | -- | -- | 推理深度，可选 `minimal`/`low`/`medium`/`high`/`xhigh`/`max` |
| `workers.{name}.role` | ✓ | -- | 系统 prompt 正文 |
| `workers.{name}.task` | -- | 自动生成 | 初始任务。Worker 默认 "Wait for the leader…" |
| `workers.{name}.model` | -- | config.defaultModel | 模型 ID |
| `workers.{name}.thinkingLevel` | -- | -- | 推理深度 |
| `workers.{name}.worktree` | -- | `true` | 是否创建独立 git worktree |

[[#目录|↑ 返回目录]]

---

## 六、竞品对比

| 维度 | **pi-team-extension** | **CC agent-teams** | **agent-core TeamAgent** |
|------|----------------------|-------------------|-------------------------|
| 依赖 | 仅 `@earendil-works/pi` | Claude Code (内置) | agent-core (内置) |
| 传输 | EventEmitter + 文件 mailbox | steering 队列 (in-process) | ZMQ (跨进程) |
| 成员直发消息 | ✓ `send_message` | ✓ `SendMessage` | ✓ `messager.send` |
| 广播 | ✓ `broadcast` | ✗ | ✓ `publish` |
| 共享任务板 | ✓ `team_tasks` + `blocked_by` | ✓ 共享任务表 (文件锁) | ✓ `TeamBackend` task DB |
| 计划审批 | 规划中（复用 pi Plan Mode） | ✓ Plan Mode | ✗ |
| Worktree 隔离 | ✓ `git worktree` per worker | ✓ worktrees | ZMQ 进程隔离 |
| 跨机 | ✗ (v2: ZMQ) | ✗ | ✓ |
| 进程模型 | 单进程并发 | 单进程 | 多进程 `spawn_mode="process"` |
| 持久化 | JSONL 文件 (best-effort) | 文件锁 + config dir | SQLite/Redis team DB |
| 安装方式 | `pi install` 扩展 / 独立 CLI | 内置（需 env var） | SDK API |
| 代码量 | ~1000 行 | -- | ~数万行 |
| 实验性 | 是 | 是（需 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`） | 稳定 GA |

**定位差异**：
- CC agent-teams 是产品内置（CLI 对用户暴露），pi-team-extension 是社区扩展（pi 对开发者暴露）
- agent-core TeamAgent 是框架 SDK（面向应用层），pi-team-extension 是终端工具（直接给 pi 用户用）
- pi-team-extension 最接近 CC agent-teams 的定位——轻量、单进程、面向终端用户——但以无侵入扩展方式实现，不要 env var 开关

[[#目录|↑ 返回目录]]

---

## 七、v1 限制与路线图

### 当前限制

| 限制 | 说明 | 影响 |
|------|------|------|
| 单进程 | 所有 agent 同一 Node 进程，pi Agent 并行各自跑 | 无法跨机分布式 team |
| 团队静态 | YAML 写死成员，运行时不能动态加 teammate | 无法像 CC 那样动态 spawn |
| 进程退出即解散 | 无进程外持久化运行时。worktree 和 mailbox 文件自动清理 | 无法 pause/resume team |
| 无 TUI 分屏 | 单终端，无 split-pane 多 agent 视图 | 调试不方便 |
| modelResolver 需外部注入 | CLI 是 placeholder，生产需 pi extension 模式 | CLI 不能独立跑 |
| workspace meta 不完整 | 无 `WorkspaceMetaTool`（对标 CC agent-teams 的 workspace 感知） | Worker 不知道 Leader 的文件变更 |
| mailbox JSON 文件不 replay | 崩溃后未投递消息不会自动恢复 | 崩溃时可能丢消息 |
| team_tasks 无并发锁 | 多 Worker 同时改任务板靠单线程安全，但存在竞态窗口 | 极低概率脏读 |

### 路线图

| 版本 | 目标 |
|------|------|
| v0.2 | 修复 CLI modelResolver（通过 pi 模型配置的 JSON 文件 + 环境变量组合实现可用的 modelResolver） |
| v0.3 | mailbox 文件 replay（启动时从 `~/.pi-teams/{team}/inboxes/*.json` 恢复未投递消息）、team state 快照保存 |
| v0.5 | 动态 spawn teammate（`spawn_worker` 工具，Leader 运行时添加 worker）、工具体系扩展 |
| v1.0 | split-pane TUI（复用 pi TUI 的多面板能力）、`/team status` 和 `/team stop` 命令、完整错误恢复链 |
| v2.0 | ZMQ 跨机 transport + 分布式 worker spawn + `team.db` 持久化 |

[[#目录|↑ 返回目录]]

---

> 📚 导航: [GitHub 仓库](https://github.com/lg320531124/pi-team-extension) · [pi 项目](https://github.com/earendil-works/pi)
>
> 最后更新：2026-07-27 | 基于源码 `4a2bfa6` (main branch)