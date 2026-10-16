// Provider-neutral shapes. Messages use Anthropic's content-block format, which is what we persist.
export interface LlmTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type Block = Record<string, any>;

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | Block[];
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: LlmTool[];
}

export interface LlmResponse {
  /** Assistant content blocks exactly as returned (thinking blocks included: they must be replayed unchanged). */
  content: Block[];
  stopReason: string;
}

export interface Llm {
  complete(req: LlmRequest): Promise<LlmResponse>;
}
