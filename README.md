# pi-team-extension

Agent Team coordination for [@earendil-works/pi](https://github.com/earendil-works/pi).

Adds peer-to-peer multi-agent collaboration to pi — a **team leader** coordinates **workers**, each in its own git worktree, communicating through named mailboxes. No oh-my-pi dependency.

## What it adds

pi ships a single-agent ReAct loop. This package adds:

- **Named team members** — a leader plus N workers, each with a role and tools
- **`send_message`** — any agent messages any other agent directly (no leader routing)
- **`broadcast`** — message all teammates at once
- **`team_tasks`** — shared task board with dependencies (`blocked_by`); leader adds, workers claim/complete
- **Git worktree isolation** — each worker writes in its own worktree under `.pi/worktrees/`, zero file conflicts
- **Contribution merge-back** — workers commit their changes; the leader merges each worker's branch back into main (serialized, `--no-ff`), or preserves the branch on conflict
- **Mailbox → steering bridge** — incoming messages land in pi's native `agent.steer()` queue, consumed on the next turn
- **Auto error notification** — a worker whose turn fails notifies the leader (mirrors CC agent-teams v2.1.198+)

## Install as a pi extension (preferred)

```bash
pi install lg320531124/pi-team-extension
pi list   # confirm it shows up
```

Then inside pi:

```
/team run test/team-demo.yml
```

The extension reuses pi's own model registry and API-key resolution — no separate `PI_API_KEY` needed. See [`docs/PI-EXTENSION-INTEGRATION.md`](docs/PI-EXTENSION-INTEGRATION.md) for details.

## Standalone CLI (alternative)

For consumers not running pi:

```bash
git clone https://github.com/lg320531124/pi-team-extension
cd pi-team-extension
bun install
export PI_API_KEY=sk-...
export PI_DEFAULT_MODEL=claude-sonnet-4-6
bun src/cli.ts run test/team-demo.yml
```

`package.json` uses `file:` links to `../pi/packages/{agent,ai,coding-agent}`. Adjust paths if your checkout differs.

## CLI

```bash
export PI_API_KEY=sk-...
export PI_DEFAULT_MODEL=claude-sonnet-4-6
pi-team run test/team-demo.yml
```

> **v1 caveat:** the CLI's model resolver is a placeholder. For a real run, use the programmatic API below and pass a resolver backed by pi's model catalog.

## Programmatic API

```ts
import { TeamCoordinator, parseTeamYaml } from "pi-team-extension";
import { readFile } from "node:fs/promises";

const yaml = await readFile("test/team-demo.yml", "utf8");
const teamDef = await parseTeamYaml(yaml);

const coordinator = new TeamCoordinator(
  teamDef,
  { apiKey: process.env.PI_API_KEY!, defaultModel: "claude-sonnet-4-6", cwd: process.cwd() },
  (id) => myModelCatalog.resolve(id),  // your pi Model resolver
);

coordinator.on("message", (m) => console.log(`[${m.from} → ${m.to}] ${m.content}`));
coordinator.on("agent_done", (name) => console.log(`✓ ${name}`));
coordinator.on("team_done", () => console.log("team complete"));

await coordinator.start();
```

## MCP tool injection

**Main session:** when pi starts in a project with a `.mcp.json`, its MCP servers are connected and their tools are registered in the main session as `mcp_<server>_<tool>` (prefix avoids collisions). Tools appear immediately and work like built-in tools.

**Team members:** team members also get the same MCP tools injected into their tool set, alongside the builtin and team tools.

Standard MCP config (`mcpServers` with `command`/`args` for stdio servers, or `type: http`/`url`):

```json
{
  "mcpServers": {
    "docs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-docs"] }
  }
}
```

When a team starts, each MCP server is connected (stdio via subprocess, HTTP via fetch) and its tools are injected into every member's tool set alongside the builtin and team tools. Servers are closed when the team stops. This works because the extension ships its own minimal MCP client — pi itself has no native MCP support.

## Natural-language team startup (`start_team` tool)

No YAML needed. Just tell pi to start an agent team — the main model calls the `start_team` tool automatically:

```
你用 pi: 开启 agent team，帮我把 README 重写一遍
pi 主模型: → start_team(goal="重写 README")
  → architect (leader) 自主分解任务 → coder/reviewer 干活
  → 完成后 worker 的代码改动自动 merge 回主分支
  → 返回成员产出 + 任务板 + merge 结果
```

Supported worker roles: `coder`, `reviewer`, `tester`, `writer`. Override via the tool's `workers` param or `model` param. The team runs blocking (like a long command); Ctrl+C interrupts and preserves worktrees with contributions.

## YAML definition

```yaml
team:
  name: code-review-squad
  leader:
    name: architect
    role: |
      You are the architect and TEAM LEADER. Decompose the goal into tasks,
      dispatch to workers, arbitrate, synthesize the result.
    model: claude-sonnet-4-6
  workers:
    coder:
      role: |
        You are a senior developer. Claim tasks, implement them, report back.
      task: Wait for the leader to assign you a task.
    reviewer:
      role: |
        You are a code reviewer. Review code the coder sends you.
      task: Wait for the coder to send you code.
```

Each worker gets its own git worktree by default, created under `.pi/worktrees/<worker>` on a stable `team/<worker>` branch. Set `worktree: false` to share the leader's cwd.

When a worker finishes, its worktree is classified by contribution:

- **clean** (no commits, no changes) → worktree removed automatically
- **committed** → branch merged back into your main branch (`git merge --no-ff`), then removed
- **uncommitted changes / merge conflict** → worktree **preserved** and reported — never force-deleted

Interrupted runs can resume: re-running the team reuses the existing `team/<worker>` worktree. Add `.pi/worktrees/` to your `.gitignore`.

## How it works

```
worker calls send_message(to="reviewer", content="...")
  → MessageBus.send() → reviewer's Mailbox.push()
  → 500ms poll drains Mailbox → reviewer's agent.steer({role:"user", ...})
  → pi ReAct loop drains steering queue next turn → reviewer sees the message
```

The leader is just another team member with `add` permission on the task board. Any agent can message any other agent — there is no message routing through the leader.

## Comparison

| Feature | CC agent-teams | agent-core TeamAgent | pi-team-extension |
|---|---|---|---|
| Depends on | Claude Code (built-in) | agent-core (built-in) | only `@earendil-works/pi` |
| Transport | steering queue (in-process) | ZMQ (cross-process) | EventEmitter + file mailbox |
| Member-to-member direct | yes | yes | yes |
| Task dependencies | yes | yes | yes (`blocked_by`) |
| Plan approval | yes (Plan Mode) | no | planned (reuse pi Plan Mode) |
| Worktree isolation | yes | ZMQ process | yes (git worktree per worker) |
| Cross-machine | no | yes | no (v2: ZMQ) |

## v1 limitations

- Same-process only (no cross-machine)
- Team composition fixed at YAML time (no dynamic teammate spawn)
- Team dissolves when the process exits (mailbox files auto-cleaned; worktrees preserved if they hold work)
- No split-pane TUI (single terminal)
- Model resolver must be wired by the caller (CLI ships a placeholder)

## License

MIT
