import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import { crc32 } from '../src/services/zip';

/** Tiny unzip for tests: verifies sizes + CRC of every entry and writes them to `dest`. */
export function unzipTo(zip: Buffer, dest: string): string[] {
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central header');
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const csize = zip.readUInt32LE(p + 20);
    const usize = zip.readUInt32LE(p + 24);
    const nlen = zip.readUInt16LE(p + 28);
    const elen = zip.readUInt16LE(p + 30);
    const clen = zip.readUInt16LE(p + 32);
    const off = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = zip.readUInt16LE(off + 26);
    const lelen = zip.readUInt16LE(off + 28);
    const raw = zip.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    if (data.length !== usize) throw new Error(`size mismatch for ${name}`);
    if (crc32(data) !== crc) throw new Error(`crc mismatch for ${name}`);
    const target = path.join(dest, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    names.push(name);
    p += 46 + nlen + elen + clen;
  }
  return names;
}

// ------------------------------------------------------------------------------------------------ fake OpenRouter
import http from 'http';
import type { AddressInfo } from 'net';
import { createMockLlm } from '../src/modules/ai/llm/mock';
import type { LlmMessage } from '../src/modules/ai/llm/types';

export interface FakeOpenRouter {
  url: string;
  requests: { model: string; body: any }[];
  close(): Promise<void>;
}

const hasArrayType = (node: any): boolean =>
  Array.isArray(node) ? node.some(hasArrayType) : node && typeof node === 'object' ? Array.isArray(node.type) || Object.values(node).some(hasArrayType) : false;

/** Checks the request is valid OpenAI chat format: returns an error text or null. */
function validate(body: any): string | null {
  const msgs: any[] = body.messages ?? [];
  if (msgs[0]?.role !== 'system') return 'first message must be system';
  for (let i = 1; i < msgs.length; i++) {
    const m = msgs[i];
    if (!['user', 'assistant', 'tool'].includes(m.role)) return `bad role ${m.role}`;
    if (m.role === 'tool' && typeof m.content !== 'string') return 'tool content must be a string';
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const ids = new Set<string>(m.tool_calls.map((c: any) => c.id));
      for (const c of m.tool_calls) {
        if (c.type !== 'function' || typeof c.function?.arguments !== 'string') return 'bad tool_call shape';
        JSON.parse(c.function.arguments);
      }
      let j = i + 1;
      while (msgs[j]?.role === 'tool') ids.delete(msgs[j++].tool_call_id);
      if (ids.size) return `missing tool results for ${[...ids].join(',')}`;
    }
    if (m.role === 'tool' && !(msgs[i - 1]?.role === 'tool' || msgs[i - 1]?.tool_calls)) return 'tool message without a preceding tool call';
  }
  for (const t of body.tools ?? []) {
    if (t.type !== 'function' || t.function?.parameters?.type !== 'object') return 'bad tool definition';
    if (hasArrayType(t.function.parameters)) return 'array "type" in schema is not portable';
  }
  return null;
}

function toLlmMessages(msgs: any[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const m of msgs.slice(1)) {
    if (m.role === 'tool') {
      const last = out[out.length - 1];
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content };
      if (last?.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    } else if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...(m.tool_calls ?? []).map((c: any) => ({ type: 'tool_use', id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments) }))] });
    } else out.push({ role: 'user', content: m.content });
  }
  return out;
}

export async function startFakeOpenRouter(opts: { badModel?: string } = {}): Promise<FakeOpenRouter> {
  const requests: FakeOpenRouter['requests'] = [];
  const mock = createMockLlm();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && req.url === '/models') {
        return send(200, { data: [
          { id: 'paid/big-model', pricing: { prompt: '0.001', completion: '0.002' }, supported_parameters: ['tools'], context_length: 200000 },
          { id: 'free/no-tools:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['temperature'], context_length: 100000 },
          { id: 'some/other:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'], context_length: 128000 },
          { id: 'meta-llama/llama-3.3-70b-instruct:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'], context_length: 65000 },
        ] });
      }
      if (req.headers.authorization !== 'Bearer test-key') return send(401, { error: { message: 'No auth credentials found' } });
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      requests.push({ model: body.model, body });
      if (opts.badModel && body.model === opts.badModel) return send(404, { error: { message: 'No endpoints found that support tool use' } });
      const problem = validate(body);
      if (problem) return send(400, { error: { message: `invalid request: ${problem}` } });
      const tools = (body.tools ?? []).map((t: any) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
      const r = await mock.complete({ system: body.messages[0].content, tools, messages: toLlmMessages(body.messages) });
      const text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = r.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }));
      send(200, { choices: [{ finish_reason: calls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) } }] });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}
