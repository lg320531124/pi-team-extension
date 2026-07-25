# pi Extension Integration

`pi-team-extension` ships as a first-class [pi](https://github.com/earendil-works/pi) extension. After install, the `/team` command is available inside pi.

## How pi discovers the extension

pi's extension loader (`core/extensions/loader.ts:readPiManifest`) reads `package.json` and looks for the `pi` field:

```json
{
  "pi": {
    "extensions": ["./src/extension.ts"]
  }
}
```

Each entry is a TypeScript module whose default export is a factory:

```ts
export default function teamExtension(pi: ExtensionAPI): void { ... }
```

The factory receives `ExtensionAPI` and registers commands, tools, and event handlers. `pi-team-extension` registers one command: `/team`.

## Install

```bash
pi install lg320531124/pi-team-extension
```

This clones the repo into pi's extensions directory and writes it to `settings.json`. Verify:

```bash
pi list
# pi-team-extension  ...  enabled
```

## Use

Inside pi's interactive mode:

```
/team run path/to/team.yml
```

The path resolves against the current working directory. See `test/team-demo.yml` for a 3-agent code-review squad template.

## What the extension wires up

When `/team run` fires, the extension:

1. Parses the YAML team definition (`parseTeamYaml`).
2. Resolves the **default model** from `ctx.model` (the model pi is currently using).
3. Resolves the **API key** from `ctx.modelRegistry.getApiKeyAndHeaders(model)` — so the team reuses whatever you configured via `/login` or env vars. No separate `PI_API_KEY`.
4. Builds a `modelResolver` that splits `provider/id` strings and calls `ctx.modelRegistry.find(provider, modelId)`; bare ids fall back to a registry-wide search via `getAll()`.
5. Constructs `TeamCoordinator`, wires its events to `ctx.ui.notify(...)`, and starts it.

Each worker agent runs in its own git worktree (unless `worktree: false` in the YAML). Messages between agents route through the in-process `MessageBus` and land in each agent's mailbox, which a 500 ms bridge drains into pi's native `agent.steer()` queue.

## Troubleshooting

- **Extension didn't load**: start pi with `-ne` (no extensions) to confirm pi itself runs, then re-install. The hint prints on load failure: `Hint: Start without extensions using "pi -ne"`.
- **`/team` not found**: run `pi list` — if the extension is disabled, enable it via `pi config`.
- **No API key**: `/login <provider>` or set the provider's env var. The extension surfaces the error: `No API key for provider "X"`.
- **No model selected**: `/model <pattern>` first. `/team` refuses to run without a current model.

## Standalone CLI vs extension

| | Extension (`pi install`) | Standalone (`pi-team run`) |
|---|---|---|
| Model resolution | pi's `ModelRegistry` | `PI_DEFAULT_MODEL` env + caller resolver |
| API key | pi's auth (`/login`, env) | `PI_API_KEY` env |
| UI | `ctx.ui.notify` (in pi TUI) | stdout |
| Best for | pi users | non-pi consumers / CI |

The extension is the preferred path. The standalone CLI in `src/cli.ts` is kept for consumers that don't run pi.
