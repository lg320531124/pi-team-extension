# pi-team-extension

Agent Team coordination for [@earendil-works/pi](https://github.com/earendil-works/pi).

Adds peer-to-peer multi-agent collaboration to pi — a **team leader** coordinates **workers**, each in its own git worktree, communicating through named mailboxes. No oh-my-pi dependency.

## What it adds

pi ships a single-agent ReAct loop. This package adds:

- **Named team members** — a leader plus N workers, each with a role and tools
- **`send_message`** — any agent messages any other agent directly (no leader routing)
- **`broadcast`** — message all teammates at once
- **`team_tasks`** — shared task board with dependencies (`blocked_by`); leader adds, workers claim/complete
- **Git worktree isolation** — each worker writes in its own worktree, zero file conflicts
- **Mailbox → steering bridge** — incoming messages land in pi's native `agent.steer()` queue, consumed on the next turn
- **Auto error notification** — a worker whose turn fails notifies the leader (mirrors CC agent-teams v2.1.198+)

## Install

```bash
# From inside the pi monorepo (workspace link), or standalone:
cd pi-team-extension
npm install   # or bun install
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

Each worker gets its own git worktree by default. Set `worktree: false` to share the leader's cwd.

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
- Team dissolves when the process exits (worktrees + mailbox files auto-cleaned)
- No split-pane TUI (single terminal)
- Model resolver must be wired by the caller (CLI ships a placeholder)

## License

MIT
