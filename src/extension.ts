/**
 * pi extension entry point.
 *
 * Register the `/team` command inside pi so users can run:
 *   pi install lg320531124/pi-team-extension
 *   /team run demo.yml
 *
 * Discovery: package.json declares `"pi": { "extensions": ["./src/extension.ts"] }`.
 * pi's loader (core/extensions/loader.ts:readPiManifest) reads this field and
 * imports the default export, calling it with the ExtensionAPI.
 *
 * This complements the standalone `pi-team` CLI (src/cli.ts) — the extension is
 * the preferred path for pi users; the CLI is for non-pi consumers.
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TeamCoordinator } from "./team/coordinator.js";
import { parseTeamYaml } from "./team/schema.js";

export default function teamExtension(pi: ExtensionAPI): void {
	pi.registerCommand("team", {
		description: "Agent team coordination. Usage: /team run <file.yml>",
		async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
			const trimmed = args.trim();
			const [sub, ...rest] = trimmed.split(/\s+/);
			if (sub !== "run") {
				ctx.ui.notify("Usage: /team run <file.yml>", "warning");
				return;
			}
			const yamlArg = rest[0];
			if (!yamlArg) {
				ctx.ui.notify("Usage: /team run <file.yml> — missing YAML path", "warning");
				return;
			}
			const yamlPath = resolve(ctx.cwd, yamlArg);

			let content: string;
			try {
				content = await readFile(yamlPath, "utf8");
			} catch (e) {
				ctx.ui.notify(
					`Cannot read ${yamlPath}: ${e instanceof Error ? e.message : String(e)}`,
					"error",
				);
				return;
			}

			let teamDef;
			try {
				teamDef = await parseTeamYaml(content);
			} catch (e) {
				ctx.ui.notify(
					`Parse error: ${e instanceof Error ? e.message : String(e)}`,
					"error",
				);
				return;
			}

			// Resolve the default model + API key from pi's own registry so the
			// extension reuses whatever the user has configured (env, /login, etc.).
			const defaultModel = ctx.model;
			if (!defaultModel) {
				ctx.ui.notify(
					"No model selected. Use /model to pick one before /team run.",
					"error",
				);
				return;
			}

			let apiKey = "";
			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(defaultModel);
				if (auth.ok) {
					apiKey = auth.apiKey ?? "";
				} else {
					ctx.ui.notify(
						`No API key for provider "${defaultModel.provider}": ${auth.error ?? "unknown"}`,
						"error",
					);
					return;
				}
			} catch (e) {
				ctx.ui.notify(
					`Auth resolution failed: ${e instanceof Error ? e.message : String(e)}`,
					"error",
				);
				return;
			}

			// modelResolver: split "provider/id" or fall back to the session model.
			const modelResolver = (id: string): Model<any> | undefined => {
				const slashIdx = id.indexOf("/");
				if (slashIdx >= 0) {
					const provider = id.slice(0, slashIdx);
					const modelId = id.slice(slashIdx + 1);
					return ctx.modelRegistry.find(provider, modelId);
				}
				// No provider prefix → best-effort search across providers.
				for (const m of ctx.modelRegistry.getAll()) {
					if (m.id === id) return m;
				}
				return undefined;
			};

			const coordinator = new TeamCoordinator(
				teamDef,
				{
					apiKey,
					defaultModel: defaultModel.id,
					cwd: ctx.cwd,
				},
				modelResolver,
			);

			// safeNotify swallows stale-ctx errors gracefully — agent completion
			// events may fire after the command handler returns (print mode,
			// session replacement) when ctx is no longer valid.
			const safeNotify = (type: "info" | "warning" | "error", msg: string) => {
				try { ctx.ui.notify(msg, type); } catch { /* ctx may be stale */ }
			};
			coordinator.on("message", (m) => {
				safeNotify("info", `[${m.from} → ${m.to}] ${m.content.slice(0, 120)}`);
			});
			coordinator.on("agent_done", (name) => {
				safeNotify("info", `✓ ${name} done`);
			});
			coordinator.on("agent_error", (name, err) => {
				safeNotify("error", `✗ ${name}: ${err}`);
			});
			coordinator.on("team_done", () => {
				safeNotify("info", "team complete");
			});

			ctx.ui.notify(`Starting team "${teamDef.name}"…`, "info");
			try {
				await coordinator.start();
			} catch (e) {
				ctx.ui.notify(
					`Team failed: ${e instanceof Error ? e.message : String(e)}`,
					"error",
				);
				await coordinator.stop();
			}
		},
	});
}
