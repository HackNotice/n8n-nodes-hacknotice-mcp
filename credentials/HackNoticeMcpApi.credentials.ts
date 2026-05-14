/**
 * HackNotice MCP API Credential
 *
 * PURPOSE
 * ----
 * Authenticates the HackNotice MCP node against a running hacknotice-mcp-server
 * (Streamable HTTP, JSON-RPC 2.0). It owns the per-user `integrationKey` sent as
 * `X-HackNotice-Integration-Key`. The MCP endpoint URL is fixed in code
 * (`HACKNOTICE_MCP_ENDPOINT_URL` in `nodes/HackNoticeMcp/constants.ts`).
 *
 * DATA SOURCES
 * ----
 * - `mcp-server` Streamable HTTP endpoint (validates `integrationKey` via
 *   prod-api during tool execution).
 *
 * KEY CONCEPTS
 * ----
 * - The `authenticate` function injects MCP transport headers
 *   (`Accept`, `X-HackNotice-Integration-Key`).
 * - `test` performs a JSON-RPC `initialize` round-trip; a 200 means the
 *   server is reachable and the integration key is accepted.
 */
import type {
	IAuthenticate,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

import { HACKNOTICE_MCP_ENDPOINT_URL } from '../nodes/HackNoticeMcp/constants';

const MCP_PROTOCOL_VERSION = '2024-11-05';

export class HackNoticeMcpApi implements ICredentialType {
	name = 'hackNoticeMcpApi';

	displayName = 'HackNotice MCP API';

	icon: Icon = { light: 'file:../icons/hacknotice.svg', dark: 'file:../icons/hacknotice-dark.svg' };

	documentationUrl = 'https://github.com/HackNotice/n8n-nodes-hacknotice-mcp#readme';

	properties: INodeProperties[] = [
		{
			displayName: 'Integration Key',
			name: 'integrationKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Per-user HackNotice integration secret. Sent as the X-HackNotice-Integration-Key header on every MCP request; mcp-server uses it to identify the calling user.',
			required: true,
		},
	];

	authenticate: IAuthenticate = async (credentials, requestOptions) => {
		const integrationKey = String(
			(credentials as Record<string, unknown>)?.integrationKey ?? '',
		).trim();
		if (!integrationKey) {
			throw new Error('Integration Key is required for HackNotice MCP API');
		}

		const existingHeaders = (requestOptions.headers as Record<string, string> | undefined) ?? {};

		const headers: Record<string, string> = {
			...existingHeaders,
			'X-HackNotice-Integration-Key': integrationKey,
			Accept: existingHeaders.Accept ?? 'application/json, text/event-stream',
		};

		return {
			...requestOptions,
			headers,
		};
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: HACKNOTICE_MCP_ENDPOINT_URL,
			url: '',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
			},
			body: {
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: {
						name: 'n8n-nodes-hacknotice-mcp-credential-test',
						version: '1.0.0',
					},
				},
			},
		},
	};
}
