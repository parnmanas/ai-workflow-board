// VirtualAgent — simulated AWB agent for QA tests.
//
// Combines an SSE subscriber (agent-scoped via its API key) with an MCP HTTP
// client so tests can observe events arriving at the agent AND have the agent
// react by calling MCP tools, just like a real proxy.mjs-driven Claude
// subagent would. Use a scripted `onTrigger` / `onCommentMention` callback to
// encode the desired agent behavior for each test.
//
// Lifecycle:
//   const agent = new VirtualAgent({ ... });
//   await agent.start();                  // opens SSE + initializes MCP
//   ... test actions ...
//   await agent.waitForTrigger(...)       // assert events received
//   await agent.stop();

import { openSseStream } from './sse-listener.mjs';
import { McpClient } from './mcp-client.mjs';
import { traceEvent } from './trace.mjs';

export class VirtualAgent {
  /**
   * @param {object} opts
   * @param {string} opts.name             Display name (used only for debug output).
   * @param {string} opts.agentId          DB id of the agents row.
   * @param {string} opts.apiKey           Raw API key string (from createApiKey.raw_key).
   * @param {number} opts.port             Test server port.
   * @param {string} [opts.boardId]        Optional board filter.
   * @param {(ctx)=>Promise<void>} [opts.onTrigger]         Called for each agent_trigger.
   * @param {(ctx)=>Promise<void>} [opts.onCommentMention]  Called for each comment_mention.
   * @param {(ctx)=>Promise<void>} [opts.onChatMessage]     Called for each chat_message.
   */
  constructor({ name, agentId, apiKey, port, boardId, onTrigger, onCommentMention, onChatMessage }) {
    this.name = name;
    this.agentId = agentId;
    this.apiKey = apiKey;
    this.port = port;
    this.boardId = boardId;
    this.onTrigger = onTrigger;
    this.onCommentMention = onCommentMention;
    this.onChatMessage = onChatMessage;

    // McpController uses @Controller() (no prefix) + @All('mcp'), so the route
    // is at server root (/mcp), NOT under the /api prefix that other AWB
    // controllers inherit.
    this.mcp = new McpClient({
      baseUrl: `http://localhost:${port}`,
      apiKey,
      clientInfo: { name: `qa-vagent-${name}`, version: '1.0.0' },
    });

    // Observation buffers — tests read these to assert receipt.
    this.frames = []; // every non-ping SSE frame ever seen
    this.triggers = []; // agent_trigger payloads
    this.mentions = []; // comment_mention payloads
    this.chatMessages = []; // chat_message payloads
    this._stream = null;
    this._started = false;
  }

  async start() {
    if (this._started) return;
    traceEvent('sse-open', { agent: this.name, agent_id: this.agentId });
    // All frame handling happens inside the SSE listener via the onFrame hook
    // so we don't race with test code that also wants to call stream.waitFor.
    this._stream = await openSseStream(this.port, this.apiKey, {
      boardId: this.boardId,
      onFrame: (frame) => {
        this.frames.push({ ts: Date.now(), ...frame });
        // Every non-ping frame gets logged for the UI timeline — users can
        // see exactly which events each agent received and in what order.
        traceEvent('sse-frame', {
          agent: this.name,
          agent_id: this.agentId,
          event: frame.event,
          data: frame.data,
        });
        if (frame.event === 'agent_trigger') {
          // The SSE wire format for agent_trigger is the LEGACY-compat shape
          // produced by event-registry.flatten(): role lives in `action`,
          // agent_id lives in `actor_name`, trigger_id lives in `field_changed`.
          // Normalize back to the payload-field names so test predicates can
          // read `.agent_id`, `.role`, `.trigger_id` naturally. Keep the
          // original legacy fields on the same object so tests can also assert
          // on the wire contract if they need to.
          const d = frame.data || {};
          const normalized = {
            ticket_id: d.ticket_id,
            agent_id: d.agent_id ?? d.actor_name,
            role: d.role ?? d.action,
            trigger_id: d.trigger_id ?? d.field_changed,
            trigger_source: d.trigger_source,
            role_prompt: d.role_prompt,
            ticket_prompt: d.ticket_prompt,
            column_prompt: d.column_prompt,
            timestamp: d.timestamp,
            // Keep wire fields too for legacy-contract assertions.
            _wire: d,
          };
          frame.data = normalized;
          this.triggers.push(normalized);
          if (this.onTrigger) {
            Promise.resolve(
              this.onTrigger({ agent: this, trigger: frame.data, mcp: this.mcp }),
            ).catch(() => {
              /* swallow; tests assert on state */
            });
          }
        } else if (frame.event === 'comment_mention') {
          this.mentions.push(frame.data);
          if (this.onCommentMention) {
            Promise.resolve(
              this.onCommentMention({ agent: this, mention: frame.data, mcp: this.mcp }),
            ).catch(() => {});
          }
        } else if (frame.event === 'chat_message') {
          this.chatMessages.push(frame.data);
          if (this.onChatMessage) {
            Promise.resolve(
              this.onChatMessage({ agent: this, message: frame.data, mcp: this.mcp }),
            ).catch(() => {});
          }
        }
      },
    });
    await this.mcp.initialize();
    this._started = true;
  }

  /** Poll-based wait for an event satisfying `predicate` in `buffer`. */
  _waitOnBuffer(buffer, predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        for (let i = 0; i < buffer.length; i++) {
          if (predicate(buffer[i])) return resolve(buffer[i]);
        }
        if (Date.now() > deadline) {
          return reject(
            new Error(
              `[${this.name}] Timeout (${timeoutMs}ms) waiting on buffer. Size=${buffer.length}. Latest=${JSON.stringify(buffer[buffer.length - 1] || null).slice(0, 200)}`,
            ),
          );
        }
        setTimeout(tick, 40).unref();
      };
      tick();
    });
  }

  waitForTrigger(predicate = () => true, timeoutMs = 5000) {
    return this._waitOnBuffer(this.triggers, predicate, timeoutMs);
  }

  waitForMention(predicate = () => true, timeoutMs = 5000) {
    return this._waitOnBuffer(this.mentions, predicate, timeoutMs);
  }

  waitForChatMessage(predicate = () => true, timeoutMs = 5000) {
    return this._waitOnBuffer(this.chatMessages, predicate, timeoutMs);
  }

  /** Count occurrences so tests can assert exactly-N and no-leak. */
  triggersFor(ticketId) {
    return this.triggers.filter((t) => t.ticket_id === ticketId);
  }

  mentionsFor(ticketId) {
    return this.mentions.filter((m) => m.ticket_id === ticketId);
  }

  async stop() {
    if (this._stream) this._stream.close();
    if (this.mcp) await this.mcp.close();
    traceEvent('sse-close', { agent: this.name, agent_id: this.agentId });
    this._started = false;
  }
}

/** Create+start N virtual agents in parallel and return them. */
export async function startAgents(port, agentsSpec) {
  const agents = agentsSpec.map((spec) => new VirtualAgent({ port, ...spec }));
  await Promise.all(agents.map((a) => a.start()));
  return agents;
}
