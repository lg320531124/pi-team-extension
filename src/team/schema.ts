/**
 * YAML team definition parsing + validation.
 *
 * No external YAML dependency in the hot path — we hand-roll a minimal
 * parser tolerant of the subset used by team definitions (nested maps,
`block scalars via `|`, string/number scalars). If a caller has `yaml`
available, `parseTeamYaml` prefers it; otherwise falls back to the
built-in parser.
 */
import type { TeamDefinition, TeamLeaderDef, TeamWorkerDef } from "./types.js";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

const VALID_THINKING: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export class TeamSchemaError extends Error {
	constructor(message: string, readonly path: string) {
		super(`${path}: ${message}`);
		this.name = "TeamSchemaError";
	}
}

/** Parse a YAML string into a validated TeamDefinition. */
export async function parseTeamYaml(content: string): Promise<TeamDefinition> {
	const raw = await parseYaml(content);
	if (typeof raw !== "object" || raw === null) {
		throw new TeamSchemaError("root must be a mapping", "<root>");
	}
	const team = (raw as Record<string, unknown>).team;
	if (typeof team !== "object" || team === null) {
		throw new TeamSchemaError("missing `team` mapping", "<root>");
	}
	return validateTeam(team as Record<string, unknown>);
}

function validateTeam(team: Record<string, unknown>): TeamDefinition {
	const name = requireString(team, "name", "team");
	const description = optionalString(team, "description", "team");

	const leaderRaw = team.leader;
	if (typeof leaderRaw !== "object" || leaderRaw === null) {
		throw new TeamSchemaError("missing `team.leader` mapping", "team.leader");
	}
	const leader = validateLeader(leaderRaw as Record<string, unknown>, "team.leader");

	const workersRaw = team.workers;
	if (typeof workersRaw !== "object" || workersRaw === null) {
		throw new TeamSchemaError("missing `team.workers` mapping", "team.workers");
	}
	const workers: Record<string, TeamWorkerDef> = {};
	for (const [workerName, wRaw] of Object.entries(workersRaw)) {
		if (typeof wRaw !== "object" || wRaw === null) {
			throw new TeamSchemaError(`worker "${workerName}" must be a mapping`, `team.workers.${workerName}`);
		}
		workers[workerName] = validateWorker(
			wRaw as Record<string, unknown>,
			`team.workers.${workerName}`,
		);
	}

	if (leader.name in workers) {
		throw new TeamSchemaError(
			`leader name "${leader.name}" collides with a worker name`,
			"team.leader.name",
		);
	}

	return { name, description, leader, workers };
}

function validateLeader(raw: Record<string, unknown>, path: string): TeamLeaderDef {
	const leaderName = requireString(raw, "name", path);
	const role = requireString(raw, "role", path);
	const task = optionalString(raw, "task", path);
	const model = optionalString(raw, "model", path);
	const thinkingLevel = optionalThinking(raw, "thinkingLevel", path);

	const def: TeamLeaderDef = {
		name: leaderName,
		role,
		...(task !== undefined ? { task } : {}),
		...(model !== undefined ? { model } : {}),
		...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
	};
	return def;
}

function validateWorker(raw: Record<string, unknown>, path: string): TeamWorkerDef {
	const role = requireString(raw, "role", path);
	const task = optionalString(raw, "task", path);
	const model = optionalString(raw, "model", path);
	const thinkingLevel = optionalThinking(raw, "thinkingLevel", path);

	const def: TeamWorkerDef = {
		role,
		task: task ?? "Wait for the leader to assign work via send_message or team_tasks.",
		...(model !== undefined ? { model } : {}),
		...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
		worktree: raw.worktree === undefined ? true : Boolean(raw.worktree),
	};
	return def;
}

function requireString(obj: Record<string, unknown>, key: string, path: string): string {
	const v = key === "__key__" ? undefined : obj[key];
	if (typeof v !== "string" || v.trim() === "") {
		throw new TeamSchemaError(`required string "${key}" is missing or empty`, path);
	}
	return v;
}

function optionalString(
	obj: Record<string, unknown>,
	key: string,
	path: string,
): string | undefined {
	const v = obj[key];
	if (v === undefined) return undefined;
	if (typeof v !== "string") {
		throw new TeamSchemaError(`"${key}" must be a string`, path);
	}
	return v;
}

function optionalThinking(
	obj: Record<string, unknown>,
	key: string,
	path: string,
): ThinkingLevel | undefined {
	const v = obj[key];
	if (v === undefined) return undefined;
	if (typeof v !== "string" || !VALID_THINKING.includes(v as ThinkingLevel)) {
		throw new TeamSchemaError(
			`"${key}" must be one of ${VALID_THINKING.join(", ")}`,
			path,
		);
	}
	return v as ThinkingLevel;
}

/**
 * Minimal YAML parser. Prefers the `yaml` npm package if importable,
 * otherwise falls back to a hand-rolled parser handling the team-definition
 * subset (indentation-based nested maps, `|` block scalars, plain scalars,
 * inline lists via `- item`).
 */
async function parseYaml(content: string): Promise<unknown> {
	try {
		// ponytail: dynamic import — `yaml` is optional. If absent, fall back.
		const mod = await import("yaml");
		return mod.parse(content);
	} catch {
		return handRollYaml(content);
	}
}

/**
 * Hand-rolled YAML subset parser. Handles:
 *  - nested mappings via 2-space indentation
 *  - `key: value` plain scalars
 *  - `key: |` block scalars (folded via dedent)
 *  - `- item` sequences (string items only)
 * Not a general YAML parser — only what team definitions use.
 */
function handRollYaml(content: string): unknown {
	const lines = content.split(/\r?\n/);
	let i = 0;
	return parseBlock(lines, i, 0).value;

	function parseBlock(lines: string[], startIdx: number, indent: number): { value: unknown; next: number } {
		// Peek to decide mapping vs sequence vs scalar.
		let idx = startIdx;
		// skip blank/comment lines
		while (idx < lines.length && (lines[idx].trim() === "" || lines[idx].trim().startsWith("#"))) {
			idx++;
		}
		if (idx >= lines.length) return { value: undefined, next: idx };

		const firstLine = lines[idx];
		const firstIndent = leadingSpaces(firstLine);
		if (firstIndent < indent) return { value: undefined, next: idx };

		const trimmed = firstLine.trimStart();
		if (trimmed.startsWith("- ")) {
			// sequence
			const arr: unknown[] = [];
			while (idx < lines.length) {
				const line = lines[idx];
				if (line.trim() === "" || line.trim().startsWith("#")) { idx++; continue; }
				const li = leadingSpaces(line);
				if (li < firstIndent) break;
				if (li > firstIndent) break;
				const item = line.trimStart().slice(2);
				arr.push(parseScalar(item));
				idx++;
			}
			return { value: arr, next: idx };
		}

		// mapping
		const obj: Record<string, unknown> = {};
		while (idx < lines.length) {
			const line = lines[idx];
			if (line.trim() === "" || line.trim().startsWith("#")) { idx++; continue; }
			const li = leadingSpaces(line);
			if (li < firstIndent) break;
			if (li > firstIndent) {
				// unexpected deeper line without a parent key — skip defensively
				idx++;
				continue;
			}
			const colonIdx = findColon(line.trimStart());
			if (colonIdx === -1) { idx++; continue; }
			const key = line.trimStart().slice(0, colonIdx).trim();
			const rest = line.trimStart().slice(colonIdx + 1).trim();
			idx++;
			if (rest === "|" || rest === "|-") {
				// block scalar: gather deeper lines
				const blockLines: string[] = [];
				let blockIndent = -1;
				while (idx < lines.length) {
					const bl = lines[idx];
					if (bl.trim() === "") { blockLines.push(""); idx++; continue; }
					const bi = leadingSpaces(bl);
					if (bi <= firstIndent) break;
					if (blockIndent === -1) blockIndent = bi;
					blockLines.push(bl.slice(blockIndent));
					idx++;
				}
				obj[key] = blockLines.join("\n").replace(/\s+$/, "") + "\n";
			} else if (rest === "") {
				// nested block
				const child = parseBlock(lines, idx, firstIndent + 2);
				obj[key] = child.value;
				idx = child.next;
			} else {
				obj[key] = parseScalar(rest);
			}
		}
		return { value: obj, next: idx };
	}

	function leadingSpaces(s: string): number {
		const m = s.match(/^( *)/);
		return m ? m[1].length : 0;
	}

	function findColon(s: string): number {
		// first `: ` or trailing `:`
		const idx = s.indexOf(": ");
		if (idx !== -1) return idx;
		if (s.endsWith(":")) return s.length - 1;
		return -1;
	}

	function parseScalar(s: string): unknown {
		if (s === "true") return true;
		if (s === "false") return false;
		if (/^-?\d+$/.test(s)) return Number(s);
		// strip surrounding quotes
		if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
			return s.slice(1, -1);
		}
		return s;
	}
}
