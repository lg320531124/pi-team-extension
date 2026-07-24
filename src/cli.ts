#!/usr/bin/env node
/**
 * pi-team CLI: run / status / stop a team from a YAML definition.
 *
 * Minimal hand-rolled argv parsing — no commander dependency.
 */
import { readFile } from "node:fs/promises";
import { argv, cwd, exit } from "node:process";
import { TeamCoordinator } from "./team/coordinator.js";
import { parseTeamYaml } from "./team/schema.js";
import type { TeamConfig } from "./team/types.js";

async function main(): Promise<void> {
	const args = argv.slice(2);
	const cmd = args[0];

	if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
		printHelp();
		return;
	}

	switch (cmd) {
		case "run":
			await runTeam(args[1]);
			break;
		case "status":
			console.error("status: not implemented in v1 (team state lives in-process)");
			exit(1);
		case "stop":
			console.error("stop: not implemented in v1 (Ctrl-C the running process)");
			exit(1);
		default:
			console.error(`Unknown command: ${cmd}`);
			printHelp();
			exit(1);
	}
}

function printHelp(): void {
	console.log(`pi-team — Agent Team coordination for pi

Usage:
  pi-team run <team.yml>     Start a team from a YAML definition
  pi-team status             (v1: not implemented — state is in-process)
  pi-team stop               (v1: Ctrl-C the running process)
  pi-team help               Show this help

Environment:
  PI_API_KEY        LLM provider API key
  PI_DEFAULT_MODEL  Default model id if a member omits 'model'
  PI_MODEL_PROVIDER Provider hint for model resolution (v1: see README)`);
}

async function runTeam(yamlPath?: string): Promise<void> {
	if (!yamlPath) {
		console.error("Usage: pi-team run <team.yml>");
		exit(1);
	}

	let content: string;
	try {
		content = await readFile(yamlPath, "utf8");
	} catch (e) {
		console.error(`Cannot read ${yamlPath}: ${e instanceof Error ? e.message : String(e)}`);
		exit(1);
	}

	let teamDef;
	try {
		teamDef = await parseTeamYaml(content);
	} catch (e) {
		console.error(`Parse error: ${e instanceof Error ? e.message : String(e)}`);
		exit(1);
	}

	const apiKey = process.env.PI_API_KEY ?? "";
	const defaultModel = process.env.PI_DEFAULT_MODEL ?? "";
	if (!apiKey || !defaultModel) {
		console.error("PI_API_KEY and PI_DEFAULT_MODEL must be set.");
		exit(1);
	}

	const config: TeamConfig = {
		apiKey,
		defaultModel,
		cwd: cwd(),
	};

	// v1 model resolver: delegates to pi's model catalog. Caller wires the real
	// resolver when using TeamCoordinator programmatically; the CLI uses a
	// placeholder that must be replaced before running.
	const coordinator = new TeamCoordinator(teamDef, config, (id) => {
		// ponytail: placeholder resolver — wire pi's model catalog here.
		// Returning undefined forces TeamCoordinator to throw with a clear message.
		void id;
		return undefined;
	});

	coordinator.on("message", (m) => {
		console.log(`[${m.from} → ${m.to}] ${m.content.slice(0, 120)}`);
	});
	coordinator.on("agent_done", (name) => console.log(`✓ ${name} done`));
	coordinator.on("agent_error", (name, err) => console.error(`✗ ${name} error: ${err}`));
	coordinator.on("team_done", () => console.log("team complete"));

	await coordinator.start();
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : String(e));
	exit(1);
});
