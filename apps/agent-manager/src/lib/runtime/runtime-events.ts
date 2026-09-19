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
      /** ACP `tool_call` 의 초기 status(pending/in_progress/completed/failed). codex-acp 의
       *  `mcp_startup.<server>` 처럼 update 없이 한 번에 completed/failed 로 오는 호출이 있다. */
      status?: string;
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
    }
  | {
      type: 'child_started';
      sessionId: string;
      childRunId: string;
      title: string;
      kind?: string;
      input?: unknown;
    }
  | {
      type: 'child_finished';
      sessionId: string;
      childRunId: string;
      status: 'completed' | 'failed' | 'cancelled';
      output?: unknown;
    };
