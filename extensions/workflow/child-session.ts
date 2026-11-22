// An in-process child Pi session: what a workflow's delegate() (delegate.ts) and the explore tool's
// explorer (extensions/explore) run. No project extensions, skills, prompt templates or context
// files; the caller's own extension factories; compaction and retries on; the short prompt cache;
// the model checked against what its endpoint serves before the first request.

import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionUIContext, type InlineExtension, type ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CACHE_RETENTION, servedModel, type Thinking } from "./models.ts";

export interface ChildSessionOptions {
	cwd: string;
	agentDir: string;
	runtime: ModelRuntime;
	/** "provider/id". */
	model: string;
	thinking: Thinking;
	sessionManager: SessionManager;
	extensionFactories: InlineExtension[];
	/** The tools the session has active; Pi's defaults without. */
	tools?: string[];
	/** Replaces Pi's default system prompt. */
	systemPrompt?: string;
	uiContext?: ExtensionUIContext;
}

export async function createChildSession(o: ChildSessionOptions): Promise<AgentSession> {
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 3 }, cacheRetention: CACHE_RETENTION });
	const resourceLoader = new DefaultResourceLoader({
		cwd: o.cwd,
		agentDir: o.agentDir,
		settingsManager,
		...(o.systemPrompt ? { systemPrompt: o.systemPrompt } : {}),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: o.extensionFactories,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: o.cwd,
		agentDir: o.agentDir,
		model: await servedModel(o.runtime, o.model),
		thinkingLevel: o.thinking,
		modelRuntime: o.runtime,
		resourceLoader,
		...(o.tools ? { tools: o.tools } : {}),
		sessionManager: o.sessionManager,
		settingsManager,
	});
	await session.bindExtensions(o.uiContext ? { uiContext: o.uiContext } : {});
	return session;
}

/** A new child session file next to the parent's, naming it as parent; in memory without a session directory. */
export const childSessionManager = (cwd: string, sessionDir: string | undefined, parentSessionFile: string | undefined): SessionManager =>
	sessionDir ? SessionManager.create(cwd, sessionDir, { parentSession: parentSessionFile }) : SessionManager.inMemory(cwd);
