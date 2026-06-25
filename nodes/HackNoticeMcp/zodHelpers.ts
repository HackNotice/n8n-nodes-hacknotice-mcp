/**
 * JSON Schema → Zod conversion for MCP tool input schemas
 *
 * PURPOSE
 * ----
 * HackNotice's MCP server exposes 80+ tools with heterogeneous inputSchema
 * values (including empty objects). OpenAI function-calling requires a valid
 * `type: object` with a `properties` map. These helpers convert each MCP
 * tool's inputSchema into a Zod object used by DynamicStructuredTool.
 */
import { z } from 'zod';

/**
 * Converts an MCP tool inputSchema (JSON Schema subset) into a Zod object.
 * Returns `z.object({})` when the schema is missing or has no properties.
 */
export function buildZodSchema(inputSchema: unknown): z.ZodObject<z.ZodRawShape> {
	if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
		return z.object({});
	}
	const schema = inputSchema as Record<string, unknown>;
	const properties = schema.properties;
	if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
		return z.object({});
	}
	const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
	const shape: z.ZodRawShape = {};
	for (const [key, propRaw] of Object.entries(properties as Record<string, unknown>)) {
		const prop = (propRaw ?? {}) as Record<string, unknown>;
		let field = jsonSchemaFieldToZod(prop);
		if (!required.includes(key)) field = field.optional() as z.ZodTypeAny;
		shape[key] = field;
	}
	return z.object(shape);
}

function jsonSchemaFieldToZod(prop: Record<string, unknown>): z.ZodTypeAny {
	const desc = typeof prop.description === 'string' ? prop.description : undefined;

	if (prop.anyOf || prop.oneOf) return desc ? z.unknown().describe(desc) : z.unknown();

	if (Array.isArray(prop.enum) && prop.enum.length > 0) {
		const enums = prop.enum.filter((v): v is string => typeof v === 'string');
		if (enums.length > 0) {
			const base = z.enum(enums as [string, ...string[]]);
			return desc ? base.describe(desc) : base;
		}
	}

	switch (prop.type) {
		case 'string': {
			const b = z.string();
			return desc ? b.describe(desc) : b;
		}
		case 'number':
		case 'integer': {
			const b = z.number();
			return desc ? b.describe(desc) : b;
		}
		case 'boolean': {
			const b = z.boolean();
			return desc ? b.describe(desc) : b;
		}
		case 'array': {
			const b = z.array(z.unknown());
			return desc ? b.describe(desc) : b;
		}
		case 'object':
			if (prop.properties && typeof prop.properties === 'object') return buildZodSchema(prop);
			{
				const b = z.record(z.unknown());
				return desc ? b.describe(desc) : b;
			}
		default:
			return desc ? z.unknown().describe(desc) : z.unknown();
	}
}

/** Truncates and normalizes a tool description for OpenAI's 1024-char limit. */
export function sanitizeDescription(raw: string): string {
	const clean = raw.replace(/\s+/g, ' ').trim();
	return clean.length > 1000 ? `${clean.slice(0, 997)}…` : clean;
}

/** Extracts a short error message from an MCP tool error content array. */
export function extractErrorText(content: Array<Record<string, unknown>>): string {
	for (const entry of content) {
		const text = typeof entry.text === 'string' ? entry.text.trim() : '';
		if (text) return text.length > 280 ? `${text.slice(0, 277)}…` : text;
	}
	return 'MCP tool returned isError=true';
}
