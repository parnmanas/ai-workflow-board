export type RuntimeEvent =
  | {
      type: 'message_delta';
      sessionId: string;
      text: string;
    }
  /**
   * 에이전트가 내보낸 이미지 한 장(ACP `agent_message_chunk` 의 `{type:'image'}` content).
   *
   * 예전에는 이 블록이 `message_delta` 의 `content.text` 만 읽히면서 **조용히 사라졌다** —
   * 이미지에는 `.text` 가 없어 빈 문자열이 됐다. 사용자가 "이미지를 보여달라" 고 해도
   * 아무것도 나오지 않은 원인이다.
   *
   * `data` 는 base64, `uri` 는 어댑터가 URL 형태로 준 경우(둘 중 하나만 온다).
   */
  | {
      type: 'image_block';
      sessionId: string;
      mimeType: string;
      data: string;
      uri: string;
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
