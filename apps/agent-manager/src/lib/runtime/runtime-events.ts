export type RuntimeEvent =
  | {
      type: 'message_delta';
      sessionId: string;
      text: string;
    }
  | {
      type: 'reasoning_delta';
      sessionId: string;
      text: string;
    }
  | {
      type: 'tool_started';
      sessionId: string;
      toolCallId: string;
      title: string;
      kind?: string;
      input?: unknown;
    }
  | {
      type: 'tool_updated' | 'tool_completed';
      sessionId: string;
      toolCallId: string;
      status?: string;
      output?: unknown;
    }
  | {
      type: 'usage';
      sessionId: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cachedReadTokens?: number;
      thoughtTokens?: number;
    }
  | {
      type: 'diagnostic';
      method: string;
      sessionId?: string;
      data?: unknown;
    };

