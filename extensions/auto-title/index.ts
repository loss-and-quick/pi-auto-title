import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const SAVE_TYPE = "auto-title";
const EXTENSION_NAME = "auto-title";
const DEFAULT_MAX_CHARS = 60;
const LOCAL_EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const TITLE_PROMPT = `You generate concise coding session titles.
Return exactly one title and nothing else.
Rules:
- Use the same language as the user when obvious.
- Keep technical terms, filenames, package names, and identifiers intact.
- Prefer 3 to 7 words.
- No quotes, bullets, markdown, emoji, or trailing punctuation.
- Be specific, not generic.`;

type TitleSource = "llm" | "fallback" | "manual";
type ModelSetting = "current" | string | false | null;
type TitleModel = NonNullable<ExtensionContext["model"]>;

interface SavedTitleState {
	title: string;
	source: TitleSource;
	createdAt: string;
	prompt?: string;
	reason?: string;
}

interface RawAutoTitleConfig {
	enabled?: boolean;
	model?: ModelSetting;
	fallbackModels?: ModelSetting[];
	maxChars?: number;
}

interface ResolvedAutoTitleConfig {
	enabled: boolean;
	model: ModelSetting;
	fallbackModels: ModelSetting[];
	maxChars: number;
}

function getDefaultConfig(): ResolvedAutoTitleConfig {
	return {
		enabled: true,
		model: "current",
		fallbackModels: [],
		maxChars: DEFAULT_MAX_CHARS,
	};
}

function mergeConfig(
	base: ResolvedAutoTitleConfig,
	override: RawAutoTitleConfig | undefined,
): ResolvedAutoTitleConfig {
	if (!override) return base;

	return {
		enabled: override.enabled ?? base.enabled,
		model: override.model ?? base.model,
		fallbackModels: Array.isArray(override.fallbackModels)
			? override.fallbackModels.filter(
					(item): item is ModelSetting =>
						item === null ||
						item === false ||
						item === "current" ||
						typeof item === "string",
				)
			: base.fallbackModels,
		maxChars:
			typeof override.maxChars === "number" && override.maxChars > 0
				? Math.floor(override.maxChars)
				: base.maxChars,
	};
}

function readConfigFile(configPath: string): RawAutoTitleConfig | undefined {
	if (!existsSync(configPath)) return undefined;

	try {
		const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
		return raw as RawAutoTitleConfig;
	} catch {
		return undefined;
	}
}

function getConfigPaths(): string[] {
	const projectConfig = path.join(
		process.cwd(),
		".pi",
		"extensions",
		EXTENSION_NAME,
		"config.json",
	);
	const agentDir = process.env.PI_CODING_AGENT_DIR
		? path.resolve(process.env.PI_CODING_AGENT_DIR)
		: path.join(homedir(), ".pi", "agent");
	const globalConfig = path.join(
		agentDir,
		"extensions",
		EXTENSION_NAME,
		"config.json",
	);
	const bundledConfig = path.join(LOCAL_EXTENSION_DIR, "config.json");

	return [bundledConfig, globalConfig, projectConfig];
}

function loadConfig(): ResolvedAutoTitleConfig {
	let config = getDefaultConfig();
	for (const configPath of getConfigPaths()) {
		config = mergeConfig(config, readConfigFile(configPath));
	}
	return config;
}

function capitalizeFirst(text: string): string {
	if (!text) return text;
	return text[0].toLocaleUpperCase() + text.slice(1);
}

function sanitizeTitle(
	raw: string | undefined,
	maxChars: number,
): string | undefined {
	if (!raw) return undefined;

	let line =
		raw
			.replace(/\r/g, "\n")
			.split("\n")
			.find((part) => part.trim())
			?.trim() ?? "";
	line = line.replace(/^(title|session title)\s*[:\-–—]\s*/i, "");
	line = line.replace(/^[-*•\d.)\s]+/, "");
	line = line.replace(/^['"`“”‘’]+|['"`“”‘’]+$/g, "");
	line = line.replace(/\s+/g, " ").trim();
	line = line.replace(/[\s,;:.!?–—-]+$/u, "");

	if (!line) return undefined;
	if (line.length > maxChars) {
		line = line
			.slice(0, maxChars)
			.replace(/\s+\S*$/, "")
			.trim();
	}
	if (!line) return undefined;

	return capitalizeFirst(line);
}

function stripPromptNoise(prompt: string): string {
	return prompt
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/(^|\s)@\S+/g, " ")
		.replace(/(^|\s)!!?\S+/g, " ")
		.replace(/^\/\S+\s*/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function formatSyntheticFallbackDate(date: Date): string {
	const year = String(date.getFullYear());
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function buildSyntheticTitle(
	prompt: string | undefined,
	cwd: string,
	maxChars: number,
): string {
	const cleaned = stripPromptNoise(prompt ?? "")
		.replace(
			/^(please|pls|can you|could you|would you|help me|i need you to|i need to|let'?s)\b[\s,:-]*/i,
			"",
		)
		.replace(/^(давай|сделай|нужно|надо|можешь)\b[\s,:-]*/i, "")
		.trim();

	const firstChunk =
		(cleaned.split(/\n+/).find(Boolean) ?? cleaned)
			.split(/[.!?]\s+|[:;]\s+/)
			.find(Boolean)
			?.trim() ?? "";

	let words = firstChunk.split(/\s+/).filter(Boolean).slice(0, 8);

	const candidate = sanitizeTitle(words.join(" "), maxChars);
	if (candidate) return candidate;

	const datedFallback = sanitizeTitle(
		`New Session ${formatSyntheticFallbackDate(new Date())}`,
		maxChars,
	);
	if (datedFallback) return datedFallback;

	return (
		sanitizeTitle(path.basename(cwd) || "New Session", maxChars) ??
		"New Session"
	);
}

function extractText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!value) return "";
	if (Array.isArray(value))
		return value
			.map((item) => extractText(item))
			.filter(Boolean)
			.join("\n");
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string")
			return record.text;
		if (record.content !== undefined) return extractText(record.content);
		if (typeof record.text === "string") return record.text;
	}
	return "";
}

function extractMessageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const record = message as Record<string, unknown>;
	return extractText(record.content ?? record.text);
}

function findFirstUserPrompt(ctx: ExtensionContext): string | undefined {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message as {
			role?: string;
			content?: unknown;
			text?: string;
		};
		if (message.role !== "user") continue;
		const text = extractMessageText(message).trim();
		if (text) return text;
	}
	return undefined;
}

function findLatestSavedState(
	ctx: ExtensionContext,
): SavedTitleState | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== SAVE_TYPE) continue;
		const data = entry.data as SavedTitleState | undefined;
		if (data?.title) return data;
	}
	return undefined;
}

function getLatestAssistantText(
	messages: unknown[] | undefined,
): string | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as {
			role?: string;
			content?: unknown;
			text?: string;
		};
		if (message?.role !== "assistant") continue;
		const text = extractMessageText(message).trim();
		if (text) return text;
	}
	return undefined;
}

function buildLLMInput(
	prompt: string,
	assistantText: string | undefined,
	maxChars: number,
): string {
	const sections = [
		`Generate a session title of at most ${maxChars} characters.`,
		"User prompt:",
		prompt.trim(),
	];

	if (assistantText?.trim()) {
		sections.push("", "Assistant response excerpt:", assistantText.trim());
	}

	return sections.join("\n");
}

function resolveTitleModel(
	ctx: ExtensionContext,
	setting: ModelSetting,
): TitleModel | undefined {
	if (setting === false || setting === null) return undefined;
	if (setting === undefined || setting === "current") {
		if (!ctx.model) {
			throw new Error("no active model selected");
		}
		return ctx.model;
	}

	const slashIndex = setting.indexOf("/");
	if (slashIndex <= 0 || slashIndex === setting.length - 1) {
		throw new Error(`invalid auto-title model setting: ${setting}`);
	}

	const provider = setting.slice(0, slashIndex);
	const modelId = setting.slice(slashIndex + 1);
	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) {
		throw new Error(`auto-title model not found: ${setting}`);
	}

	return model;
}

function getModelAttempts(config: ResolvedAutoTitleConfig): ModelSetting[] {
	if (config.model === false || config.model === null) return [];
	const rawAttempts = [config.model ?? "current", ...config.fallbackModels];
	const attempts: ModelSetting[] = [];
	const seen = new Set<string>();

	for (const attempt of rawAttempts) {
		const key =
			attempt === null ? "null" : attempt === false ? "false" : String(attempt);
		if (seen.has(key)) continue;
		seen.add(key);
		attempts.push(attempt);
	}

	return attempts;
}

export default function (pi: ExtensionAPI) {
	let config = loadConfig();
	let savedState: SavedTitleState | undefined;
	let seedPrompt: string | undefined;
	let isGenerating = false;

	const refreshConfig = () => {
		config = loadConfig();
	};

	const persistAndApply = (
		title: string,
		source: TitleSource,
		prompt: string | undefined,
		reason?: string,
	) => {
		savedState = {
			title,
			source,
			createdAt: new Date().toISOString(),
			prompt,
			reason,
		};
		pi.setSessionName(title);
		pi.appendEntry(SAVE_TYPE, savedState);
	};

	const restoreState = (ctx: ExtensionContext) => {
		refreshConfig();
		savedState = findLatestSavedState(ctx);
		seedPrompt = savedState?.prompt ?? findFirstUserPrompt(ctx);

		const currentName = pi.getSessionName();
		if (!currentName && savedState?.title) {
			pi.setSessionName(savedState.title);
		} else if (currentName && !savedState) {
			savedState = {
				title: currentName,
				source: "manual",
				createdAt: new Date().toISOString(),
				prompt: seedPrompt,
				reason: "session already had a title",
			};
		}
	};

	const runHiddenTitle = async (
		ctx: ExtensionContext,
		model: TitleModel,
		prompt: string,
		assistantText: string | undefined,
	): Promise<string | undefined> => {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			throw new Error(auth.error);
		}
		if (!auth.apiKey) {
			throw new Error(`no API key for ${model.provider}/${model.id}`);
		}

		const userMessage: UserMessage = {
			role: "user",
			content: [
				{
					type: "text",
					text: buildLLMInput(prompt, assistantText, config.maxChars),
				},
			],
			timestamp: Date.now(),
		};

		const response = await complete(
			model,
			{ systemPrompt: TITLE_PROMPT, messages: [userMessage] },
			{ apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal },
		);

		if (response.stopReason === "aborted") {
			throw new Error("title generation aborted");
		}

		const text = response.content
			.filter(
				(content): content is { type: "text"; text: string } =>
					content.type === "text" && typeof content.text === "string",
			)
			.map((content) => content.text)
			.join("\n");

		return sanitizeTitle(text, config.maxChars);
	};

	const generateTitle = async (
		ctx: ExtensionContext,
		prompt: string,
		assistantText: string | undefined,
		options?: { forceFallback?: boolean },
	): Promise<SavedTitleState> => {
		refreshConfig();
		const syntheticTitle = buildSyntheticTitle(
			prompt,
			process.cwd(),
			config.maxChars,
		);
		const failures: string[] = [];

		if (!options?.forceFallback) {
			for (const setting of getModelAttempts(config)) {
				try {
					const model = resolveTitleModel(ctx, setting);
					if (!model) continue;
					const title = await runHiddenTitle(ctx, model, prompt, assistantText);
					if (title) {
						persistAndApply(
							title,
							"llm",
							prompt,
							failures.length > 0
								? `model fallback used after: ${failures.join(" | ")}`
								: undefined,
						);
						return savedState as SavedTitleState;
					}
					failures.push(`${String(setting)}: empty or invalid title`);
				} catch (error) {
					failures.push(
						`${String(setting)}: ${error instanceof Error ? error.message : "title generation failed"}`,
					);
				}
			}
		}

		persistAndApply(
			syntheticTitle,
			"fallback",
			prompt,
			options?.forceFallback
				? "forced synthetic fallback"
				: failures.join(" | ") || "LLM disabled by config",
		);
		return savedState as SavedTitleState;
	};

	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		refreshConfig();
		if (!config.enabled || savedState?.title || pi.getSessionName()) return;
		const prompt = event.prompt.trim();
		if (!prompt) return;
		seedPrompt = seedPrompt ?? prompt;
		if (!savedState) restoreState(ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		refreshConfig();
		if (
			!config.enabled ||
			isGenerating ||
			savedState?.title ||
			pi.getSessionName()
		)
			return;

		const prompt = seedPrompt ?? findFirstUserPrompt(ctx);
		if (!prompt) return;

		isGenerating = true;
		try {
			await generateTitle(ctx, prompt, getLatestAssistantText(event.messages));
		} finally {
			isGenerating = false;
		}
	});

	pi.registerCommand("auto-title", {
		description: "Show or manage automatic session title generation",
		handler: async (args, ctx) => {
			refreshConfig();
			const input = args.trim();
			const currentTitle = pi.getSessionName();
			const prompt =
				seedPrompt ?? savedState?.prompt ?? findFirstUserPrompt(ctx);

			if (!input || input === "status") {
				if (!config.enabled) {
					ctx.ui.notify("Auto-title is disabled in config.json", "warning");
					return;
				}

				if (currentTitle) {
					const suffix = savedState ? ` (${savedState.source})` : "";
					ctx.ui.notify(`Session title: ${currentTitle}${suffix}`, "info");
				} else {
					ctx.ui.notify("No session title set yet", "info");
				}
				return;
			}

			if (input === "regenerate") {
				if (!prompt) {
					ctx.ui.notify(
						"No user prompt found to build a title from",
						"warning",
					);
					return;
				}
				const next = await generateTitle(ctx, prompt, undefined);
				ctx.ui.notify(
					`Regenerated title: ${next.title} (${next.source})`,
					"info",
				);
				return;
			}

			if (input === "fallback") {
				const fallbackPrompt = prompt ?? currentTitle ?? "New Session";
				const next = await generateTitle(ctx, fallbackPrompt, undefined, {
					forceFallback: true,
				});
				ctx.ui.notify(`Synthetic title: ${next.title}`, "info");
				return;
			}

			if (input.startsWith("set ")) {
				const requested = sanitizeTitle(input.slice(4), config.maxChars);
				if (!requested) {
					ctx.ui.notify("Usage: /auto-title set <title>", "warning");
					return;
				}
				persistAndApply(requested, "manual", prompt, "set via /auto-title");
				ctx.ui.notify(`Session titled: ${requested}`, "info");
				return;
			}

			ctx.ui.notify(
				"Usage: /auto-title [status|regenerate|fallback|set <title>]",
				"warning",
			);
		},
	});
}
