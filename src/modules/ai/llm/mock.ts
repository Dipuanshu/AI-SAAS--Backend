import { Block, Llm, LlmMessage, LlmRequest, LlmResponse } from './types';

/**
 * Deterministic stand-in for a real model (LLM_PROVIDER=mock). Used by the automated tests and for trying the
 * whole pipeline (roles, tools, confirmations, audit) without an API key. It is NOT intelligent.
 */
let counter = 0;
const id = () => `toolu_mock_${++counter}`;

const lastQuestion = (msgs: LlmMessage[]): string => {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role !== 'user') continue;
    const text = typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (text) return text;
  }
  return '';
};

export function createMockLlm(): Llm {
  return {
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const last = req.messages[req.messages.length - 1]!;
      const results = Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : [];

      if (results.length) {
        const parts = results.map((r: Block) => `${r.is_error ? 'Problem' : 'Result'}: ${String(typeof r.content === 'string' ? r.content : JSON.stringify(r.content)).slice(0, 300)}`);
        return { content: [{ type: 'text', text: parts.join('\n') }], stopReason: 'end_turn' };
      }

      const full = lastQuestion(req.messages);
      const q = (full.split('Question:').pop() ?? full).trim();
      const lower = q.toLowerCase();
      const find = (re: RegExp) => req.tools.find((t) => re.test(t.name));
      const call = (tool: { name: string } | undefined, input: Record<string, unknown>): LlmResponse =>
        tool
          ? { content: [{ type: 'text', text: `Let me check with ${tool.name}.` }, { type: 'tool_use', id: id(), name: tool.name, input }], stopReason: 'tool_use' }
          : { content: [{ type: 'text', text: 'I do not have a tool that can do that for you.' }], stopReason: 'end_turn' };
      const num = /(\d+)/.exec(q)?.[1];

      if (/delete|remove/.test(lower) && num) return call(find(/delete/i), { id: Number(num) });
      if (/(add|create)\b.*product/.test(lower)) {
        const name = /product\s+(?:called|named)?\s*"?([A-Za-z][\w ]*?)"?\s+(?:at|for|price)/i.exec(q)?.[1] ?? 'New Item';
        return call(find(/create/i), { body: { name, price: Number(/(\d+)\s*(?:rs|rupees|₹)?\s*$/i.exec(q)?.[1] ?? 100) } });
      }
      if (/(update|change).*price/.test(lower) && num) {
        const price = Number(q.match(/(\d+)/g)?.slice(-1)[0]);
        return call(find(/update/i), { id: Number(num), body: { price } });
      }
      if (/sales|report|revenue/.test(lower)) return call(find(/report/i), {});
      if (/employee|salary|staff/.test(lower)) return call(find(/employee/i), {});
      if (/order/.test(lower)) return call(find(/order/i), {});
      if (/product|stock|price/.test(lower)) return call(find(/list.*product|product/i), num ? {} : {});
      if (/\bme\b|profile|who am i/.test(lower)) return call(find(/profile|me$/i), {});

      const doc = /Help documents[^\n]*\n([\s\S]*?)\n\n/.exec(full)?.[1];
      if (doc) return { content: [{ type: 'text', text: `From the help documents: ${doc.slice(0, 300)}` }], stopReason: 'end_turn' };
      return { content: [{ type: 'text', text: 'I can help with questions about this software.' }], stopReason: 'end_turn' };
    },
  };
}
