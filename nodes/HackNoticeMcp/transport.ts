/**
 * MCP Streamable HTTP Transport (client side)
 *
 * PURPOSE
 * ----
 * Tiny, dependency-free implementation of the client half of the
 * Model Context Protocol (MCP) "Streamable HTTP" transport, used by the
 * HackNotice MCP node to talk to a running hacknotice-mcp-server
 * (`mcp-server`). We deliberately do NOT depend on
 * `@modelcontextprotocol/sdk` — that package is pure ESM and this
 * community-node package compiles to CommonJS (n8n loader requirement).
 *
 * KEY CONCEPTS
 * ----
 * - All MCP traffic is JSON-RPC 2.0 over HTTP, with one POST per message.
 * - The server returns either:
 *     a) `Content-Type: application/json` with a single JSON-RPC response, or
 *     b) `Content-Type: text/event-stream` (SSE) where `data:` events carry
 *        JSON-RPC messages; the response we want is the one whose `id`
 *        matches the request.
 * - The first call (`initialize`) establishes a session. mcp-server returns
 *   the new session id in the `Mcp-Session-Id` response header. Subsequent
 *   requests must echo that header. `DELETE` ends the session.
 * - This module is invoked from `supplyData` (AI Agent tool discovery and
 *   invocation). The context exposes `helpers.httpRequestWithAuthentication`,
 *   which injects `HackNoticeMcpApi` credential headers (integration key).
 */
import type {
	IExecuteFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	ISupplyDataFunctions,
} from 'n8n-workflow';

import { HACKNOTICE_MCP_ENDPOINT_URL } from './constants';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SESSION_HEADER = 'mcp-session-id';
const CREDENTIAL_NAME = 'hackNoticeMcpApi';
/** MCP calls can be slow (many tools / cold prod-api); avoid n8n default short timeouts. */
const MCP_HTTP_TIMEOUT_MS = 120_000;

/** JSON-RPC 2.0 success/error envelopes (subset we actually use). */
export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}
export interface JsonRpcResponse<T = unknown> {
	jsonrpc: '2.0';
	id: number | string;
	result?: T;
	error?: JsonRpcError;
}

/** A single MCP tool descriptor as returned by `tools/list`. */
export interface McpToolDescriptor {
	name: string;
	/** Human-readable label from the MCP server (preferred for UI dropdowns). */
	title?: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

/** Shape of a `tools/call` result envelope (per MCP spec). */
export interface McpToolCallResult {
	content?: Array<Record<string, unknown>>;
	structuredContent?: unknown;
	isError?: boolean;
	[k: string]: unknown;
}

/** n8n contexts that expose HTTP helpers + credential injection. */
type RequestCapableContext = IExecuteFunctions | ILoadOptionsFunctions | ISupplyDataFunctions;

/**
 * Parses an MCP Streamable HTTP response body, regardless of whether it
 * was returned as a single JSON document or as one-or-more SSE `data:`
 * events. Returns the JSON-RPC envelope whose id matches `expectedId`.
 *
 * mcp-server (built on `StreamableHTTPServerTransport`) chooses between
 * the two encodings based on whether streaming is needed. We have to
 * handle both.
 */
function decodeMcpResponse(
	body: unknown,
	contentType: string,
	expectedId: number,
): JsonRpcResponse {
	const ct = (contentType || '').toLowerCase();
	const text =
		typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : JSON.stringify(body ?? '');

	if (ct.includes('text/event-stream')) {
		const blocks = text.split(/\r?\n\r?\n/);
		for (const block of blocks) {
			const dataLines = block
				.split(/\r?\n/)
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice(5).trim());
			if (dataLines.length === 0) continue;
			try {
				const parsed = JSON.parse(dataLines.join('\n')) as JsonRpcResponse;
				if (parsed && (parsed.id === expectedId || parsed.id === String(expectedId))) {
					return parsed;
				}
			} catch {
				// Skip malformed events; keep scanning.
			}
		}
		throw new Error(`MCP SSE response did not contain a JSON-RPC reply for id=${expectedId}`);
	}

	const parsed: JsonRpcResponse =
		typeof body === 'object' && body !== null
			? (body as JsonRpcResponse)
			: (JSON.parse(text) as JsonRpcResponse);
	return parsed;
}

/** Reads a header value case-insensitively from a Node-style header bag. */
function readHeader(headers: unknown, name: string): string | undefined {
	if (!headers || typeof headers !== 'object') return undefined;
	const lower = name.toLowerCase();
	for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
		if (k.toLowerCase() === lower) {
			if (Array.isArray(v)) return v[0] as string | undefined;
			if (typeof v === 'string') return v;
		}
	}
	return undefined;
}

/**
 * Stateful MCP client: holds a single session id across `initialize` →
 * `tools/list` / `tools/call` → `close`. Construct it once per node
 * execution (or once per `supplyData` discovery / tool call) and discard.
 */
export class McpStreamableHttpClient {
	private sessionId: string | undefined;
	private nextId = 1;
	private readonly endpointUrl = HACKNOTICE_MCP_ENDPOINT_URL;

	constructor(private readonly ctx: RequestCapableContext) {}

	/** Issues `initialize` + `notifications/initialized`. Returns server info. */
	async open(): Promise<{ serverInfo?: Record<string, unknown> }> {
		await this.ctx.getCredentials(CREDENTIAL_NAME);

		const id = this.nextId++;
		const initParams = {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: 'n8n-nodes-hacknotice-mcp', version: '1.0.0' },
		};

		const { envelope, sessionId } = await this.post(id, 'initialize', initParams);
		if (envelope.error) {
			throw new Error(`MCP initialize failed: ${envelope.error.message}`);
		}
		// sessionId is only present when the server runs in stateful mode. The
		// HackNotice MCP server uses stateless mode (sessionIdGenerator: undefined),
		// so the header may be absent — that is expected and not an error.
		this.sessionId = sessionId;

		await this.notify('notifications/initialized', {});

		return { serverInfo: envelope.result as Record<string, unknown> | undefined };
	}

	/** Fetches the full tool list. */
	async listTools(): Promise<McpToolDescriptor[]> {
		const id = this.nextId++;
		const { envelope } = await this.post(id, 'tools/list', {});
		if (envelope.error) {
			throw new Error(`MCP tools/list failed: ${envelope.error.message}`);
		}
		const result = (envelope.result ?? {}) as { tools?: McpToolDescriptor[] };
		return Array.isArray(result.tools) ? result.tools : [];
	}

	/** Calls a single tool by name with the supplied arguments object. */
	async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
		const id = this.nextId++;
		const { envelope } = await this.post(id, 'tools/call', { name, arguments: args });
		if (envelope.error) {
			throw new Error(`MCP tool '${name}' failed: ${envelope.error.message}`);
		}
		return (envelope.result ?? {}) as McpToolCallResult;
	}

	/**
	 * Best-effort session termination via `DELETE`. Errors are swallowed:
	 * if the server already cleaned the session up there is nothing to do,
	 * and we never want a cleanup failure to mask the real result.
	 */
	async close(): Promise<void> {
		if (!this.sessionId) return;
		try {
			await this.ctx.helpers.httpRequestWithAuthentication.call(this.ctx, CREDENTIAL_NAME, {
				method: 'DELETE' as IHttpRequestMethods,
				url: this.endpointUrl,
				headers: { [SESSION_HEADER]: this.sessionId },
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				json: false,
				timeout: MCP_HTTP_TIMEOUT_MS,
			});
		} catch {
			// Intentional: see method JSDoc.
		} finally {
			this.sessionId = undefined;
		}
	}

	/**
	 * Sends a JSON-RPC notification (no response expected, no `id`).
	 * mcp-server returns HTTP 202.
	 */
	private async notify(method: string, params: unknown): Promise<void> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
		};
		if (this.sessionId) headers[SESSION_HEADER] = this.sessionId;

		const payload = JSON.stringify({ jsonrpc: '2.0', method, params });

		await this.ctx.helpers.httpRequestWithAuthentication.call(this.ctx, CREDENTIAL_NAME, {
			method: 'POST' as IHttpRequestMethods,
			url: this.endpointUrl,
			body: payload,
			headers,
			json: false,
			timeout: MCP_HTTP_TIMEOUT_MS,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		});
	}

	/**
	 * Sends a JSON-RPC request and returns the matching response envelope
	 * along with any `Mcp-Session-Id` returned in headers (initialize only).
	 */
	private async post(
		id: number,
		method: string,
		params: unknown,
	): Promise<{ envelope: JsonRpcResponse; sessionId?: string }> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
		};
		if (this.sessionId) headers[SESSION_HEADER] = this.sessionId;

		const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });

		const response = (await this.ctx.helpers.httpRequestWithAuthentication.call(
			this.ctx,
			CREDENTIAL_NAME,
			{
				method: 'POST' as IHttpRequestMethods,
				url: this.endpointUrl,
				body: payload,
				headers,
				json: false,
				timeout: MCP_HTTP_TIMEOUT_MS,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
			},
		)) as { statusCode: number; headers: Record<string, unknown>; body: unknown };

		if (response.statusCode >= 400) {
			const bodyPreview =
				typeof response.body === 'string'
					? response.body.slice(0, 500)
					: JSON.stringify(response.body ?? '').slice(0, 500);
			throw new Error(
				`MCP HTTP ${response.statusCode} for ${method}: ${bodyPreview || '(empty body)'}`,
			);
		}

		const contentType = readHeader(response.headers, 'content-type') ?? '';
		const sessionId = readHeader(response.headers, SESSION_HEADER);
		const envelope = decodeMcpResponse(response.body, contentType, id);
		return { envelope, sessionId };
	}
}
