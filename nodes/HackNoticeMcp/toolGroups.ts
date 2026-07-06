/**
 * Functional tool groups for the "By Group" tool-filter mode.
 *
 * PURPOSE
 * ----
 * hacknotice-mcp-server names its tools with a consistent prefix per
 * functional area (`hacknotice_third_party_*`, `hacknotice_first_party_*`,
 * `hacknotice_end_user_*`, `hacknotice_research_*`, `hacknotice_assessment_*` /
 * `hacknotice_invited_assessment_*`). This module derives a group from that
 * naming convention client-side, without any MCP protocol change, so the n8n
 * node can offer a static (no server round-trip) multi-select of groups.
 *
 * Tools that don't match any known prefix (credential verification, saved
 * searches, and the cross-cutting `search_*` global-breach/exposure/chatter
 * tools) are considered "general" and are always exposed in "By Group" mode
 * regardless of which groups are selected, since an agent typically needs
 * search capability no matter which functional area it's working in.
 */

export interface ToolGroupOption {
	name: string;
	value: string;
	description: string;
}

export const TOOL_GROUPS: ToolGroupOption[] = [
	{
		name: 'Third-Party',
		value: 'thirdParty',
		description: 'Third-party vendor breach alerts and watchlist management',
	},
	{
		name: 'First-Party',
		value: 'firstParty',
		description: 'First-party domain breach alerts and watchlist management',
	},
	{
		name: 'End User',
		value: 'endUser',
		description: 'End-user credential alerts and watchlist management',
	},
	{
		name: 'Research',
		value: 'research',
		description: 'Research phrase and wordpool alerts',
	},
	{
		name: 'Assessments',
		value: 'assessments',
		description: 'Vendor security assessments, invites, templates, and data files',
	},
];

const GROUP_PREFIXES: ReadonlyArray<{ value: string; prefixes: string[] }> = [
	{ value: 'thirdParty', prefixes: ['hacknotice_third_party'] },
	{ value: 'firstParty', prefixes: ['hacknotice_first_party'] },
	{ value: 'endUser', prefixes: ['hacknotice_end_user'] },
	{ value: 'research', prefixes: ['hacknotice_research'] },
	{ value: 'assessments', prefixes: ['hacknotice_assessment', 'hacknotice_invited_assessment'] },
];

/**
 * Returns the functional group for `toolName`, or `undefined` for
 * general/cross-cutting tools that don't belong to a single group.
 */
export function getToolGroup(toolName: string): string | undefined {
	for (const { value, prefixes } of GROUP_PREFIXES) {
		if (prefixes.some((prefix) => toolName.startsWith(prefix))) return value;
	}
	return undefined;
}

/**
 * Whether `tool` should be exposed given the set of `selectedGroups`.
 * General tools (no matching prefix) are always included.
 */
export function toolMatchesSelectedGroups(toolName: string, selectedGroups: string[]): boolean {
	const group = getToolGroup(toolName);
	return group === undefined || selectedGroups.includes(group);
}
