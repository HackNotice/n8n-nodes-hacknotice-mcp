/**
 * HackNotice MCP — AI Agent tool node
 *
 * PURPOSE
 * ----
 * n8n community node that acts as an MCP **client** against HackNotice's
 * hacknotice-mcp-server (Streamable HTTP, JSON-RPC 2.0). Exposes either a
 * curated set of high-intent tools or the full MCP catalogue, with a
 * module-level TTL cache so the `tools/list` HTTP call is only made once per
 * credential per 5 minutes, not on every LLM iteration.
 *
 * KEY CONCEPTS
 * ----
 * - No Main input/output — only `NodeConnectionTypes.AiTool`.
 * - CURATED DEFAULT: The default exposure mode returns a small group of
 *   shortcut tools (for example, third-party watchlist alerts) plus a few
 *   high-value raw MCP tools. This gives the LLM clear function-call targets
 *   and avoids random clarification loops.
 * - FULL CATALOGUE MODE: Users can switch to exposing all MCP tools. The
 *   catalogue is still cached by integrationKey with a 5-minute TTL.
 * - `execute()` is required even though this node never runs on the main
 *   canvas. n8n's workflow execution engine includes sub-nodes in the
 *   directed graph (across ALL connection types) for partial/re-run
 *   execution plans. When a node has `supplyData` but NO `execute`,
 *   workflow-execute.js line 729 throws `UnexpectedError` before
 *   supplyData() is ever called. Every built-in tool node carries a stub
 *   execute() for this reason.
 * - logWrapper() from @n8n/ai-utilities intercepts tool invocations to
 *   call ctx.addInputData / addOutputData, making the node show as
 *   "executed" in the n8n canvas once a tool is actually called.
 *
 * DATA SOURCES
 * ----
 * - hacknotice-mcp-server via McpStreamableHttpClient (transport.ts)
 */
// @langchain/core and @n8n/ai-utilities are provided by the n8n host at runtime — not package dependencies.
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { DynamicStructuredTool } from '@langchain/core/tools';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import { getConnectionHintNoticeField, logWrapper } from '@n8n/ai-utilities';
import {
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type ISupplyDataFunctions,
	NodeConnectionTypes,
	NodeOperationError,
	type SupplyData,
} from 'n8n-workflow';

import { McpStreamableHttpClient, type McpToolDescriptor } from './transport';
import { buildZodSchema, extractErrorText, sanitizeDescription } from './zodHelpers';

// ---------------------------------------------------------------------------
// Module-level catalogue cache
// ---------------------------------------------------------------------------
// n8n re-invokes supplyData() on EVERY LLM iteration of the AI Agent's ReAct
// loop. Without caching, each iteration opens an MCP session and calls
// tools/list — typically 3 HTTP round-trips × 10 iterations = 30 network
// calls per user request and execution times > 90 s.
//
// The cache is keyed by integrationKey so different credentials never share
// state. TTL of 5 minutes keeps the catalogue fresh without hammering the
// MCP server.
// ---------------------------------------------------------------------------

interface CachedCatalogue {
	tools: McpToolDescriptor[];
	instructions: string | undefined;
	fetchedAt: number;
}

const CATALOGUE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const catalogueCache = new Map<string, CachedCatalogue>();

const CURATED_RAW_TOOL_NAMES = new Set([
	'hacknotice_third_party_watchlist_get_watchlist_domains',
	'hacknotice_third_party_watchlist_search_domain',
	'hacknotice_first_party_alerts',
	'hacknotice_first_party_watchlist_get_watchlist_items',
	'hacknotice_first_party_watchlist_search_item',
	'search_global_breaches',
	'search_exposure',
	'search_credential_leaks',
	'search_leaked_files',
	'search_chatter',
]);

/**
 * Returns the cached catalogue for `key` if it is still within the TTL,
 * otherwise removes the stale entry and returns null.
 */
function getCached(key: string): CachedCatalogue | null {
	const entry = catalogueCache.get(key);
	if (!entry) return null;
	if (Date.now() - entry.fetchedAt > CATALOGUE_TTL_MS) {
		catalogueCache.delete(key);
		return null;
	}
	return entry;
}

/**
 * Converts MCP `content` into the string a LangChain tool should return.
 * HackNotice MCP tools return JSON as a single text content item, so preserve
 * that JSON string instead of stringifying the surrounding MCP content array.
 */
function mcpContentToText(content: Array<Record<string, unknown>>): string {
	if (content.length === 1 && typeof content[0]?.text === 'string') {
		return content[0].text;
	}
	return JSON.stringify(content);
}

/**
 * Parses JSON-looking text for n8n node output, falling back to the original
 * string for non-JSON tool results.
 */
function parseJsonOutput(text: string): IDataObject | IDataObject[] | string | number | boolean | null {
	try {
		return JSON.parse(text) as IDataObject | IDataObject[] | string | number | boolean | null;
	} catch {
		return text;
	}
}

/**
 * Removes the generic "No filters provided" warning from parsed MCP output.
 * The curated third-party watchlist shortcut intentionally fetches unscoped
 * third-party alerts with defaults, so this warning is noise in n8n output.
 */
function stripNoFiltersWarning(
	value: IDataObject | IDataObject[] | string | number | boolean | null,
): IDataObject | IDataObject[] | string | number | boolean | null {
	if (Array.isArray(value)) {
		return value.map((entry) => stripNoFiltersWarning(entry) as IDataObject);
	}
	if (!value || typeof value !== 'object') {
		return value;
	}
	const output = { ...value };
	if (
		typeof output.warning === 'string' &&
		output.warning.startsWith('No filters provided. Pass savedSearchJson')
	) {
		delete output.warning;
	}
	return output;
}

/**
 * Normalizes common argument aliases that LLMs tend to produce for raw MCP
 * tools. This keeps exact MCP schemas strict while making the n8n tool bridge
 * forgiving for obvious synonyms.
 */
function normalizeToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
	const pickFirstString = (aliases: string[]): string | undefined => {
		for (const alias of aliases) {
			const value = args[alias];
			if (typeof value === 'string' && value.trim()) {
				return value.trim();
			}
		}
		return undefined;
	};

	if (toolName === 'search_global_breaches' && typeof args.term !== 'string') {
		const term = pickFirstString(['query', 'domain', 'company', 'companyName', 'name', 'keyword']);
		return term ? { ...args, term } : args;
	}

	if (
		['search_exposure', 'search_chatter', 'search_leaked_files'].includes(toolName) &&
		typeof args.query !== 'string'
	) {
		const query = pickFirstString(['term', 'domain', 'company', 'companyName', 'name', 'keyword', 'filename']);
		return query ? { ...args, query } : args;
	}

	if (toolName === 'search_credential_leaks' && typeof args.domain !== 'string') {
		const domain = pickFirstString(['term', 'query', 'company', 'companyName', 'name', 'keyword']);
		return domain ? { ...args, domain } : args;
	}

	if (typeof args.term === 'string' || typeof args.query === 'string' || typeof args.domain === 'string') {
		return args;
	}
	return args;
}

function missingArgumentObservation(toolName: string, requiredField: string, hint: string): string {
	return JSON.stringify({
		error: `${toolName} requires ${requiredField}`,
		requiredField,
		hint,
		retry:
			'Call this tool again with the required field, or choose a watchlist alert shortcut if the user asked for watchlist alerts.',
	});
}

/**
 * Executes a single MCP tool call and returns the serialized MCP content.
 * Shared by supplyData() tool functions and execute(), because n8n v3 Agent
 * may route tool calls through the workflow engine instead of directly
 * invoking the LangChain tool function.
 */
async function callMcpTool(
	ctx: ISupplyDataFunctions | IExecuteFunctions,
	toolName: string,
	args: Record<string, unknown>,
	itemIndex: number,
	forceDebug: boolean,
): Promise<string> {
	const callClient = new McpStreamableHttpClient(ctx);
	await callClient.open();
	try {
		const normalizedArgs = normalizeToolArgs(toolName, args);
		if (toolName === 'search_global_breaches' && typeof normalizedArgs.term !== 'string') {
			ctx.logger.info('[HackNoticeMcp] search_global_breaches missing term; returning tool observation');
			return missingArgumentObservation(
				'search_global_breaches',
				'term',
				'Provide a company, domain, breach name, or keyword as `term`. If the user asked for third-party watchlist alerts, use hacknotice_get_third_party_watchlist_alerts instead.',
			);
		}
		if (
			['search_exposure', 'search_chatter', 'search_leaked_files'].includes(toolName) &&
			typeof normalizedArgs.query !== 'string'
		) {
			ctx.logger.info(`[HackNoticeMcp] ${toolName} missing query; returning tool observation`);
			return missingArgumentObservation(
				toolName,
				'query',
				'Provide a company, domain, file name, or keyword as `query`.',
			);
		}
		if (toolName === 'search_credential_leaks' && typeof normalizedArgs.domain !== 'string') {
			ctx.logger.info('[HackNoticeMcp] search_credential_leaks missing domain; returning tool observation');
			return missingArgumentObservation(
				'search_credential_leaks',
				'domain',
				'Provide a domain as `domain`.',
			);
		}
		const toolArgs = forceDebug ? { ...normalizedArgs, debug: true } : normalizedArgs;
		const result = await callClient.callTool(toolName, toolArgs);
		const content = Array.isArray(result.content) ? result.content : [];
		if (result.isError) {
			throw new NodeOperationError(
				ctx.getNode(),
				`MCP tool '${toolName}' error: ${extractErrorText(content)}`,
				{ itemIndex },
			);
		}
		ctx.logger.info(`[HackNoticeMcp] invoked ${toolName}${forceDebug ? ' debug=on' : ''}`);
		return mcpContentToText(content);
	} finally {
		await callClient.close();
	}
}

export class HackNoticeMcp implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'HackNotice MCP',
		name: 'hackNoticeMcp',
		icon: { light: 'file:../../icons/hacknotice.svg', dark: 'file:../../icons/hacknotice-dark.svg' },
		group: ['transform'],
		defaultVersion: 1,
		version: [1],
		description:
			'Exposes all HackNotice MCP tools to an AI Agent. Wire to the Tools input of an AI Agent node.',
		defaults: {
			name: 'HackNotice MCP',
		},
		documentationUrl: 'https://github.com/HackNotice/n8n-nodes-hacknotice-mcp#readme',
		// Matches the codex pattern used by all built-in LangChain tool nodes (McpClientTool,
		// ToolWikipedia, ToolCode, etc.). n8n uses this for node-picker categorisation under AI → Tools.
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Tools'],
				Tools: ['Other Tools'],
			},
			resources: {
				primaryDocumentation: [
					{
						url: 'https://github.com/HackNotice/n8n-nodes-hacknotice-mcp#readme',
					},
				],
			},
		},
		inputs: [],
		outputs: [NodeConnectionTypes.AiTool],
		outputNames: ['Tool'],
		credentials: [
			{
				name: 'hackNoticeMcpApi',
				required: true,
			},
		],
		// The connection-hint notice is the first property on every built-in tool node.
		// It renders a "connect to AI Agent" nudge in the node's parameter panel.
		properties: [
			getConnectionHintNoticeField([NodeConnectionTypes.AiAgent]),
			{
				displayName: 'Tools to Expose',
				name: 'toolExposureMode',
				type: 'options',
				default: 'curated',
				description:
					'Choose whether to expose a small, agent-friendly tool set or the full MCP catalogue',
				options: [
					{
						name: 'Curated Shortcuts (Recommended)',
						value: 'curated',
						description:
							'Expose a small set of high-intent HackNotice tools. Best for AI Agent reliability.',
					},
					{
						name: 'All MCP Tools',
						value: 'all',
						description:
							'Expose the full MCP catalogue. Useful for advanced workflows but can make the agent ask more clarifying questions.',
					},
				],
			},
			{
				displayName: 'Debug Mode',
				name: 'debugMode',
				type: 'boolean',
				default: false,
				description:
					'Whether to force debug tracing on every MCP tool call. When enabled, tool responses include `_debug` with inbound MCP and outbound HackNotice API request/response traces redacted by the MCP server.',
			},
		],
	};

	/**
	 * Fetches the MCP tools catalogue (with caching) and returns one
	 * DynamicStructuredTool per MCP tool to the AI Agent.
	 *
	 * CACHING STRATEGY
	 * The catalogue is cached by integrationKey for CATALOGUE_TTL_MS (5 min).
	 * On a cache hit supplyData() completes in < 1 ms and makes zero HTTP
	 * calls — critical because n8n calls supplyData() on every LLM iteration.
	 */
	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		// Use the integrationKey as cache key so each credential set gets its
		// own isolated catalogue. getCredentials() is fast (reads from n8n's
		// in-memory store, no network call).
		const creds = await this.getCredentials('hackNoticeMcpApi');
		const cacheKey = String((creds as Record<string, unknown>).integrationKey ?? '');

		let catalogue = getCached(cacheKey);

		if (catalogue) {
			this.logger.info(
				`[HackNoticeMcp] supplyData: cache hit — ${catalogue.tools.length} tools (next refresh in ${Math.round((CATALOGUE_TTL_MS - (Date.now() - catalogue.fetchedAt)) / 1000)}s)`,
			);
		} else {
			// Cache miss: open an MCP session, fetch the tools list, close.
			this.logger.info('[HackNoticeMcp] supplyData: cache miss — fetching tools from MCP server');
			const client = new McpStreamableHttpClient(this);
			const { serverInfo } = await client.open();
			let tools: McpToolDescriptor[];
			try {
				tools = await client.listTools();
			} finally {
				await client.close();
			}
			const instructions =
				serverInfo && typeof serverInfo.instructions === 'string'
					? (serverInfo.instructions as string)
					: undefined;
			catalogue = { tools, instructions, fetchedAt: Date.now() };
			catalogueCache.set(cacheKey, catalogue);
			this.logger.info(
				`[HackNoticeMcp] supplyData: fetched ${tools.length} tools — cached for ${CATALOGUE_TTL_MS / 60_000} min`,
			);
			if (instructions) {
				this.logger.info(`[HackNoticeMcp] MCP server instructions: ${instructions}`);
			}
		}

		const { tools: mcpTools } = catalogue;
		const exposureMode = this.getNodeParameter('toolExposureMode', itemIndex, 'curated') as
			| 'curated'
			| 'all';
		const forceDebug = this.getNodeParameter('debugMode', itemIndex, false) as boolean;

		// This shortcut exists because generic prompts like "give me the alerts
		// from my thirdparty watchlist" should be actionable without the model
		// asking for time range, saved-search, or limit. It maps that intent to
		// the underlying MCP alert endpoint with practical defaults.
		const thirdPartyAlertsShortcut = new DynamicStructuredTool({
			name: 'hacknotice_get_third_party_watchlist_alerts',
			description:
				'Use this immediately when the user asks for third-party watchlist alerts, ' +
				'thirdparty alerts, vendor alerts, supplier alerts, or "alerts from my thirdparty watchlist". ' +
				'Do not ask clarification questions. Defaults to timeRange=lastMonth and limit=100.',
			schema: buildZodSchema({
				type: 'object',
				properties: {
					timeRange: {
						type: 'string',
						enum: ['lastDay', 'lastWeek', 'lastMonth'],
						description: 'Alert time range. Use lastMonth when the user does not specify a range.',
					},
					limit: {
						type: 'integer',
						description: 'Maximum number of alerts to return. Use 100 when unspecified.',
					},
					debug: {
						type: 'boolean',
						description: 'Set true only when the user explicitly asks for debug output.',
					},
				},
			}),
			func: async (args: Record<string, unknown>) =>
				await callMcpTool(
					this,
					'hacknotice_third_party_alerts',
					{
						timeRange: typeof args.timeRange === 'string' ? args.timeRange : 'lastMonth',
						limit: typeof args.limit === 'number' ? args.limit : 100,
						...(args.debug === true ? { debug: true } : {}),
					},
					itemIndex,
					forceDebug,
				),
		});

		const firstPartyAlertsShortcut = new DynamicStructuredTool({
			name: 'hacknotice_get_first_party_watchlist_alerts',
			description:
				'Use this immediately when the user asks for first-party watchlist alerts, ' +
				'first party alerts, own-domain alerts, company domain alerts, or "alerts from my first party watchlist". ' +
				'Do not ask clarification questions. Defaults to timeRange=lastMonth and limit=100.',
			schema: buildZodSchema({
				type: 'object',
				properties: {
					timeRange: {
						type: 'string',
						enum: ['lastDay', 'lastWeek', 'lastMonth'],
						description: 'Alert time range. Use lastMonth when the user does not specify a range.',
					},
					limit: {
						type: 'integer',
						description: 'Maximum number of alerts to return. Use 100 when unspecified.',
					},
					debug: {
						type: 'boolean',
						description: 'Set true only when the user explicitly asks for debug output.',
					},
				},
			}),
			func: async (args: Record<string, unknown>) =>
				await callMcpTool(
					this,
					'hacknotice_first_party_alerts',
					{
						timeRange: typeof args.timeRange === 'string' ? args.timeRange : 'lastMonth',
						limit: typeof args.limit === 'number' ? args.limit : 100,
						...(args.debug === true ? { debug: true } : {}),
					},
					itemIndex,
					forceDebug,
				),
		});

		const selectedMcpTools =
			exposureMode === 'all'
				? mcpTools
				: mcpTools.filter((tool) => CURATED_RAW_TOOL_NAMES.has(tool.name));

		const langchainTools = [
			thirdPartyAlertsShortcut,
			firstPartyAlertsShortcut,
			...selectedMcpTools.filter((t) => Boolean(t?.name)).map((mcpTool) => {
				let description = mcpTool.description ?? mcpTool.name;
				if (mcpTool.name === 'search_global_breaches') {
					description = `${description} REQUIRED: pass a string \`term\` argument containing the company, domain, breach name, or keyword to search. Do NOT use for generic watchlist-alert requests; use hacknotice_get_third_party_watchlist_alerts or hacknotice_get_first_party_watchlist_alerts instead.`;
				} else if (['search_exposure', 'search_chatter', 'search_leaked_files'].includes(mcpTool.name)) {
					description = `${description} REQUIRED: pass a string \`query\` argument containing the company, domain, filename, or keyword to search.`;
				} else if (mcpTool.name === 'search_credential_leaks') {
					description = `${description} REQUIRED: pass a string \`domain\` argument.`;
				}
				return new DynamicStructuredTool({
					name: mcpTool.name,
					description: sanitizeDescription(description),
					schema: buildZodSchema(mcpTool.inputSchema),
					func: async (args: Record<string, unknown>) =>
						await callMcpTool(this, mcpTool.name, args, itemIndex, forceDebug),
				});
			}),
		];

		this.logger.info(
			`[HackNoticeMcp] supplyData: exposing ${langchainTools.length} tools in ${exposureMode} mode`,
		);

		const sourceNodeName = this.getNode().name;
		const wrappedTools = langchainTools.map((tool) => {
			// n8n v3 Agent converts model tool calls into engine actions. During
			// that conversion it drops any tool without metadata.sourceNodeName.
			// n8n annotates standalone tool responses automatically, but not tools
			// inside a plain array response, so we must set it explicitly here.
			tool.metadata ??= {};
			tool.metadata.sourceNodeName = sourceNodeName;
			// Mark as toolkit-style so n8n includes the requested tool name in the
			// workflow-engine action input. execute() needs that name to dispatch
			// the correct MCP tool when the v3 Agent runs tool calls as node actions.
			tool.metadata.isFromToolkit = true;

			// logWrapper intercepts invoke() to call ctx.addInputData / addOutputData so
			// n8n tracks each tool invocation and the node turns green in the canvas.
			// Cast required: devDep @langchain/core version differs from the n8n runtime version.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return logWrapper(tool as any, this);
		});

		return { response: wrappedTools };
	}

	/**
	 * Stub required by n8n's workflow execution engine.
	 *
	 * n8n's DirectedGraph.fromWorkflow() traverses ALL connection types
	 * (including ai_tool), so during partial/re-run executions this node ends
	 * up on the nodeExecutionStack.  Without an execute() method the engine
	 * hits the `if (nodeType.supplyData) throw UnexpectedError(...)` guard in
	 * workflow-execute.js before supplyData() is ever called.  Every built-in
	 * tool node carries a stub execute() for this reason.
	 *
	 * @returns Tool observations for n8n's AI tool execution output.
	 */
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const results: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const forceDebug = this.getNodeParameter('debugMode', itemIndex, false) as boolean;
			const input = (items[itemIndex]?.json ?? {}) as Record<string, unknown>;
			const requestedTool = typeof input.tool === 'string' ? input.tool : undefined;

			if (!requestedTool) {
				throw new NodeOperationError(this.getNode(), 'No HackNotice tool name was provided', {
					itemIndex,
					description:
						'n8n AI Agent tool execution must pass a `tool` field in the action input.',
				});
			}

			const rawArgs = { ...input };
			delete rawArgs.tool;
			let output: string;

			if (requestedTool === 'hacknotice_get_third_party_watchlist_alerts') {
				output = await callMcpTool(
					this,
					'hacknotice_third_party_alerts',
					{
						timeRange: typeof rawArgs.timeRange === 'string' ? rawArgs.timeRange : 'lastMonth',
						limit: typeof rawArgs.limit === 'number' ? rawArgs.limit : 100,
						...(rawArgs.debug === true ? { debug: true } : {}),
					},
					itemIndex,
					forceDebug,
				);
			} else if (requestedTool === 'hacknotice_get_first_party_watchlist_alerts') {
				output = await callMcpTool(
					this,
					'hacknotice_first_party_alerts',
					{
						timeRange: typeof rawArgs.timeRange === 'string' ? rawArgs.timeRange : 'lastMonth',
						limit: typeof rawArgs.limit === 'number' ? rawArgs.limit : 100,
						...(rawArgs.debug === true ? { debug: true } : {}),
					},
					itemIndex,
					forceDebug,
				);
			} else {
				output = await callMcpTool(this, requestedTool, rawArgs, itemIndex, forceDebug);
			}

			results.push({
				json: { output: stripNoFiltersWarning(parseJsonOutput(output)) },
				pairedItem: { item: itemIndex },
			});
		}

		return [results];
	}
}
