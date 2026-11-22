// Minimal zero-dependency MCP stdio server (newline-delimited JSON-RPC 2.0).
//
// Mirrors vendor/pi-lens/mcp/server.ts: stdout carries ONLY JSON-RPC frames; console.log is
// redirected to stderr defensively so no transitively imported module can corrupt the transport.

import { createInterface } from "node:readline";

export interface McpToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
	content: { type: "text"; text: string }[];
	isError?: boolean;
}

export interface McpServerConfig {
	name: string;
	version: string;
	listTools: () => McpToolDefinition[];
	callTool: (name: string, args: Record<string, unknown>) => Promise<McpCallResult>;
}

interface JsonRpcRequest {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2024-11-05";

/** Handle a single JSON-RPC message; returns `undefined` for notifications. */
export async function handleJsonRpc(config: McpServerConfig, message: JsonRpcRequest): Promise<Record<string, unknown> | undefined> {
	const { id, method, params } = message;
	const isNotification = id === undefined;

	if (!method) {
		if (isNotification) return undefined;
		return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request: missing method" } };
	}

	if (method === "notifications/initialized" || method === "notifications/cancelled") {
		return undefined;
	}

	if (method === "initialize") {
		const requestedVersion = typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION;
		return {
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: requestedVersion,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: config.name, version: config.version },
			},
		};
	}

	if (method === "ping") {
		return { jsonrpc: "2.0", id, result: {} };
	}

	if (method === "tools/list") {
		return { jsonrpc: "2.0", id, result: { tools: config.listTools() } };
	}

	if (method === "tools/call") {
		const toolName = typeof params?.name === "string" ? params.name : "";
		const toolArgs = params?.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
		if (!toolName) {
			return { jsonrpc: "2.0", id, error: { code: -32602, message: "Missing tool name" } };
		}
		try {
			const result = await config.callTool(toolName, toolArgs);
			return { jsonrpc: "2.0", id, result };
		} catch (error) {
			return {
				jsonrpc: "2.0",
				id,
				result: {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					isError: true,
				},
			};
		}
	}

	if (isNotification) return undefined;
	return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

/** Run the MCP server over `stdin` / `stdout`. */
export function serveStdio(config: McpServerConfig): void {
	// Defensively reroute console.log to stderr so stdout remains pure JSON-RPC.
	console.log = (...args: unknown[]) => {
		process.stderr.write(`${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
	};

	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
	rl.on("line", (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let parsed: JsonRpcRequest;
		try {
			parsed = JSON.parse(trimmed) as JsonRpcRequest;
		} catch (error) {
			process.stdout.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${error instanceof Error ? error.message : String(error)}` } })}\n`,
			);
			return;
		}
		handleJsonRpc(config, parsed)
			.then((response) => {
				if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
			})
			.catch((error) => {
				if (parsed.id !== undefined) {
					process.stdout.write(
						`${JSON.stringify({ jsonrpc: "2.0", id: parsed.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })}\n`,
					);
				}
			});
	});
}
