// Small, dependency-free helpers for the JSON Schemas of discovered API tools.

const KEEP = new Set([
  'type', 'properties', 'items', 'required', 'enum', 'description', 'format', 'minimum', 'maximum',
  'minLength', 'maxLength', 'pattern', 'default', 'oneOf', 'anyOf', 'allOf', 'additionalProperties', 'title',
]);

/** Keeps only the keywords an LLM tool schema needs, limits depth, and normalises OpenAPI `nullable`. */
export function sanitizeSchema(input: unknown, depth = 0): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || depth > 6) return {};
  const src = input as Record<string, any>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (!KEEP.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v).slice(0, 60).map(([pk, pv]) => [pk, sanitizeSchema(pv, depth + 1)]));
    } else if (k === 'items') {
      out.items = sanitizeSchema(v, depth + 1);
    } else if ((k === 'oneOf' || k === 'anyOf' || k === 'allOf') && Array.isArray(v)) {
      out[k] = v.slice(0, 8).map((s) => sanitizeSchema(s, depth + 1));
    } else if (k === 'additionalProperties') {
      out[k] = typeof v === 'object' ? sanitizeSchema(v, depth + 1) : Boolean(v);
    } else if (k === 'description' || k === 'title') {
      out[k] = String(v).slice(0, 400);
    } else if (k === 'required' && Array.isArray(v)) {
      out.required = v.filter((x) => typeof x === 'string');
    } else if (k === 'enum' && Array.isArray(v)) {
      out.enum = v.slice(0, 100);
    } else {
      out[k] = v;
    }
  }
  if (src.nullable === true && typeof out.type === 'string') out.type = [out.type, 'null'];
  if (!out.type && !out.oneOf && !out.anyOf && !out.allOf && !out.enum) out.type = out.properties ? 'object' : 'string';
  return out;
}

export interface ParamMapEntry {
  key: string;
  name: string;
  in: 'path' | 'query';
}

export interface SyncParam {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: unknown;
}

export interface SyncTool {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: SyncParam[];
  requestBody?: { required?: boolean; description?: string; schema?: unknown } | null;
}

const MAX_SCHEMA_CHARS = 8000;

export function buildInputSchema(t: SyncTool): { schema: Record<string, unknown>; paramMap: ParamMapEntry[]; hasBody: boolean } {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const paramMap: ParamMapEntry[] = [];

  for (const p of t.parameters ?? []) {
    if (p.in !== 'path' && p.in !== 'query') continue; // headers/cookies are never exposed to the model
    let key = p.name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60) || 'param';
    if (key in properties || key === 'body') key = `${p.in}_${key}`;
    const schema = sanitizeSchema(p.schema ?? { type: 'string' });
    if (p.description) schema.description = String(p.description).slice(0, 300);
    properties[key] = schema;
    if (p.required || p.in === 'path') required.push(key);
    paramMap.push({ key, name: p.name, in: p.in });
  }

  let hasBody = false;
  if (t.requestBody) {
    hasBody = true;
    let body = sanitizeSchema(t.requestBody.schema ?? { type: 'object' });
    if (JSON.stringify(body).length > MAX_SCHEMA_CHARS) body = { type: 'object', description: 'JSON request body' };
    if (!body.description) body.description = (t.requestBody.description ?? 'JSON request body').slice(0, 300);
    properties.body = body;
    if (t.requestBody.required) required.push('body');
  }

  const schema: Record<string, unknown> = { type: 'object', properties };
  if (required.length) schema.required = required;
  return { schema, paramMap, hasBody };
}

/** Minimal JSON-schema validation of model-produced arguments (type, enum, required, nested). Returns an error or null. */
export function validateArgs(schema: any, value: unknown, path = 'input'): string | null {
  if (!schema || typeof schema !== 'object') return null;
  if (value === undefined || value === null) return schema.nullable ? null : `${path} is required`;

  const types: string[] = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length) {
    const actual = Array.isArray(value) ? 'array' : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value;
    const ok = types.some((t) => t === actual || (t === 'number' && actual === 'integer') || (t === 'null' && value === null));
    if (!ok) return `${path} must be of type ${types.join('|')}`;
  }
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.slice(0, 10).join(', ')}`;
  if (typeof value === 'string') {
    if (schema.minLength && value.length < schema.minLength) return `${path} is too short`;
    if (schema.maxLength && value.length > schema.maxLength) return `${path} is too long`;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be >= ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be <= ${schema.maximum}`;
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < Math.min(value.length, 200); i++) {
      const e = validateArgs(schema.items, value[i], `${path}[${i}]`);
      if (e) return e;
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    for (const r of schema.required ?? []) {
      if ((value as any)[r] === undefined) return `${path}.${r} is required`;
    }
    for (const [k, sub] of Object.entries<any>(schema.properties)) {
      if ((value as any)[k] !== undefined) {
        const e = validateArgs(sub, (value as any)[k], `${path}.${k}`);
        if (e) return e;
      }
    }
  }
  return null;
}
