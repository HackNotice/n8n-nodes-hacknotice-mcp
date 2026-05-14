/**
 * HackNotice MCP Client node
 *
 * PURPOSE
 * ----
 * n8n community node that acts as an MCP **client** against HackNotice's
 * `hacknotice-mcp-server` (Streamable HTTP). It mirrors the workflow pattern of
 * n8n's built-in **MCP Client Tool** node (connect an AI Agent to external MCP
 * tools); see n8n docs: https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp/
 * The built-in node targets an SSE endpoint; this package uses HackNotice's
 * Streamable HTTP endpoint (`/mcp`) and integration-key auth.
 *
 * DATA SOURCES
 * ----
 * - hacknotice-mcp-server (MCP over Streamable HTTP, JSON-RPC 2.0).
 *
 * KEY CONCEPTS
 * ----
 * - `usableAsTool: true` so AI Agent nodes can invoke it like other tools.
 * - Programmatic-style: each execution opens a short-lived MCP session
 *   (initialize → tools/call → DELETE).
 * - Tool list is loaded live via `tools/list` (`loadOptions`).
 */
import {
	type IExecuteFunctions,
	type ILoadOptionsFunctions,
	type INodeExecutionData,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
	type IDataObject,
	NodeConnectionTypes,
	NodeApiError,
	NodeOperationError,
} from 'n8n-workflow';

import { McpStreamableHttpClient, type McpToolDescriptor } from './transport';

const RESOURCE_TOOL = 'tool';
const OP_CALL_TOOL = 'callTool';
const OP_LIST_TOOLS = 'listTools';
const DEFAULT_TOOL_ERROR_MESSAGE = 'MCP tool returned isError=true';

/** Truncates a tool description for the dropdown so it stays readable. */
function shortDescription(tool: McpToolDescriptor): string {
	const raw = (tool.description ?? '').replace(/\s+/g, ' ').trim();
	if (!raw) return tool.name;
	return raw.length > 120 ? `${raw.slice(0, 117)}…` : raw;
}

export class HackNoticeMcp implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'HackNotice MCP Client',
		name: 'hackNoticeMcp',
		icon: { light: 'file:../../icons/hacknotice.svg', dark: 'file:../../icons/hacknotice-dark.svg' },
		group: ['transform'],
		defaultVersion: 1,
		version: [1],
		subtitle:
			'={{$parameter["operation"] === "callTool" ? "call: " + ($parameter["toolName"] || "?") : "list tools"}}',
		description:
			'Model Context Protocol (MCP) client for HackNotice: list and call tools from hacknotice-mcp-server. Designed for AI Agent workflows (same role as n8n\'s MCP Client Tool).',
		defaults: {
			name: 'HackNotice MCP Client',
		},
		documentationUrl:
			'https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp/',
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'hackNoticeMcpApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Tool',
						value: RESOURCE_TOOL,
					},
				],
				default: RESOURCE_TOOL,
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: [RESOURCE_TOOL],
					},
				},
				options: [
					{
						name: 'Call Tool',
						value: OP_CALL_TOOL,
						description: 'Invoke a single MCP tool by name',
						action: 'Call an MCP tool',
					},
					{
						name: 'List Tools',
						value: OP_LIST_TOOLS,
						description: 'Return every tool the MCP server currently exposes',
						action: 'List MCP tools',
					},
				],
				default: OP_CALL_TOOL,
			},
			{
				displayName: 'Tool Name or ID',
				name: 'toolName',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getMcpTools',
					loadOptionsDependsOn: ['hackNoticeMcpApi'],
				},
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: [RESOURCE_TOOL],
						operation: [OP_CALL_TOOL],
					},
				},
				description:
					'Pick the MCP tool to invoke. The list is loaded live from the configured MCP server. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Arguments (JSON)',
				name: 'toolArguments',
				type: 'json',
				default: '{}',
				required: true,
				typeOptions: {
					rows: 6,
				},
				displayOptions: {
					show: {
						resource: [RESOURCE_TOOL],
						operation: [OP_CALL_TOOL],
					},
				},
				description:
					'JSON object that will be passed verbatim as the tool arguments. Must match the tool inputSchema. Use {} when the tool accepts no arguments.',
				hint: 'Tip: run "List Tools" once and inspect the inputSchema field of the chosen tool.',
			},
			{
				displayName: 'Output Each Content Item Separately',
				name: 'splitContent',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: {
						resource: [RESOURCE_TOOL],
						operation: [OP_CALL_TOOL],
					},
				},
				description:
					'Whether to emit one n8n item per entry of the tool result `content` array. Disable to emit a single item containing the full tool result.',
			},
			{
				displayName: 'Fail on MCP Tool Error',
				name: 'failOnToolError',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: {
						resource: [RESOURCE_TOOL],
						operation: [OP_CALL_TOOL],
					},
				},
				description:
					'Whether to throw an error when the MCP response has isError=true. Keep enabled to trigger n8n Error Workflows for tool failures (for example MCP timeouts).',
			},
		],
	};

	methods = {
		loadOptions: {
			async getMcpTools(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const client = new McpStreamableHttpClient(this);
				try {
					await client.open();
					const tools = await client.listTools();
					if (tools.length === 0) {
						return [{ name: 'No Tools Exposed by Server', value: '' }];
					}
					return tools
						.filter((tool) => Boolean(tool && tool.name))
						.map((tool) => ({
							name: tool.name,
							value: tool.name,
							description: shortDescription(tool),
						}));
				} catch (error) {
					const message =
						error instanceof Error ? error.message : 'Unknown error contacting MCP server';
					return [{ name: `Error loading tools: ${message}`, value: '' }];
				} finally {
					await client.close();
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const client = new McpStreamableHttpClient(this);
		try {
			await client.open();

			for (let i = 0; i < items.length; i++) {
				try {
					const resource = this.getNodeParameter('resource', i) as string;
					const operation = this.getNodeParameter('operation', i) as string;

					if (resource !== RESOURCE_TOOL) {
						throw new NodeOperationError(this.getNode(), `Unsupported resource: ${resource}`, {
							itemIndex: i,
						});
					}

					if (operation === OP_LIST_TOOLS) {
						const tools = await client.listTools();
						for (const tool of tools) {
							returnData.push({
								json: tool as unknown as IDataObject,
								pairedItem: { item: i },
							});
						}
						continue;
					}

					if (operation === OP_CALL_TOOL) {
						const toolName = (this.getNodeParameter('toolName', i, '') as string).trim();
						if (!toolName) {
							throw new NodeOperationError(
								this.getNode(),
								'Tool Name is required for Call Tool',
								{ itemIndex: i },
							);
						}

						const rawArgs = this.getNodeParameter('toolArguments', i, '{}') as unknown;
						const args = parseToolArguments(rawArgs, this.getNode().name, i);

						const splitContent = this.getNodeParameter('splitContent', i, true) as boolean;
						const failOnToolError = this.getNodeParameter('failOnToolError', i, true) as boolean;

						const result = await client.callTool(toolName, args);
						if (failOnToolError && result.isError) {
							const message = extractMcpToolErrorMessage(result);
							throw new NodeOperationError(
								this.getNode(),
								`MCP tool '${toolName}' returned isError=true: ${message}`,
								{ itemIndex: i },
							);
						}
						const content = Array.isArray(result.content) ? result.content : [];

						if (splitContent && content.length > 0) {
							for (const entry of content) {
								returnData.push({
									json: {
										...(entry as IDataObject),
										_toolName: toolName,
										_isError: Boolean(result.isError),
										...(result.structuredContent !== undefined
											? { _structuredContent: result.structuredContent as IDataObject }
											: {}),
									},
									pairedItem: { item: i },
								});
							}
						} else {
							returnData.push({
								json: {
									toolName,
									isError: Boolean(result.isError),
									content,
									...(result.structuredContent !== undefined
										? { structuredContent: result.structuredContent as IDataObject }
										: {}),
								},
								pairedItem: { item: i },
							});
						}
						continue;
					}

					throw new NodeOperationError(this.getNode(), `Unsupported operation: ${operation}`, {
						itemIndex: i,
					});
				} catch (error) {
					if (this.continueOnFail()) {
						returnData.push({
							json: { error: (error as Error).message },
							pairedItem: { item: i },
						});
						continue;
					}

					if (error instanceof NodeOperationError) {
						throw error;
					}

					throw new NodeApiError(this.getNode(), error as never, { itemIndex: i });
				}
			}
		} finally {
			await client.close();
		}

		return [returnData];
	}
}

function parseToolArguments(
	raw: unknown,
	nodeName: string,
	itemIndex: number,
): Record<string, unknown> {
	if (raw == null || raw === '') return {};

	if (typeof raw === 'object' && !Array.isArray(raw)) {
		return raw as Record<string, unknown>;
	}

	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (!trimmed) return {};
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch (e) {
			throw new NodeOperationError(
				{ name: nodeName } as never,
				`Tool arguments must be a JSON object: ${(e as Error).message}`,
				{ itemIndex },
			);
		}
	}

	throw new NodeOperationError(
		{ name: nodeName } as never,
		'Tool arguments must be a JSON object',
		{ itemIndex },
	);
}

function extractMcpToolErrorMessage(result: { content?: Array<Record<string, unknown>> }): string {
	const content = Array.isArray(result.content) ? result.content : [];
	for (const entry of content) {
		const text = typeof entry.text === 'string' ? entry.text.trim() : '';
		if (text) return text.length > 280 ? `${text.slice(0, 277)}...` : text;
	}
	return DEFAULT_TOOL_ERROR_MESSAGE;
}
