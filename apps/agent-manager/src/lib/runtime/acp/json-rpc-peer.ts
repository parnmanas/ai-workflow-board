import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type {
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcMessage,
} from './acp-types.js';

export type AcpProtocolErrorCode =
  | 'acp_timeout'
  | 'acp_aborted'
  | 'acp_closed'
  | 'acp_process_exited'
  | 'acp_malformed_message'
  | 'acp_message_too_large'
  | 'acp_remote_error'
  | 'acp_write_failed';

export class AcpProtocolError extends Error {
  readonly code: AcpProtocolErrorCode;
  readonly exitCode?: number | null;
  readonly data?: unknown;

  constructor(
    code: AcpProtocolErrorCode,
    message: string,
    options: { cause?: unknown; exitCode?: number | null; data?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AcpProtocolError';
    this.code = code;
    this.exitCode = options.exitCode;
    this.data = options.data;
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
  removeAbort?: () => void;
}

export interface JsonRpcPeerOptions {
  requestTimeoutMs?: number;
  maxLineBytes?: number;
  maxMessageBytes?: number;
  onNotification?: (method: string, params: unknown) => void | Promise<void>;
  onRequest?: (method: string, params: unknown) => unknown | Promise<unknown>;
  onStderr?: (line: string) => void;
}

export interface JsonRpcRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function redactDiagnostic(input: string): string {
  return input
    .replace(
      /\b(authorization\s*:\s*bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token)\b(\s*[:=]\s*|\s+)[^\s,;]+/gi,
      '$1$2[REDACTED]',
    )
    .slice(0, 8_192);
}

export class JsonRpcPeer {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #options: Required<
    Pick<JsonRpcPeerOptions, 'requestTimeoutMs' | 'maxLineBytes' | 'maxMessageBytes'>
  > & JsonRpcPeerOptions;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  #nextId = 1;
  #stdoutBuffer = Buffer.alloc(0);
  #stderrBuffer = '';
  #fatalError: AcpProtocolError | null = null;
  #closed = false;

  constructor(child: ChildProcessWithoutNullStreams, options: JsonRpcPeerOptions = {}) {
    this.#child = child;
    this.#options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      maxLineBytes: options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
      maxMessageBytes: options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      this.#consumeStdout(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.#consumeStderr(chunk));
    child.once('error', (error) => {
      this.#fail(new AcpProtocolError('acp_process_exited', error.message, { cause: error }));
    });
    child.once('exit', (code, signal) => {
      if (this.#closed) return;
      this.#fail(new AcpProtocolError(
        'acp_process_exited',
        `ACP process exited (code=${String(code)}, signal=${String(signal)})`,
        { exitCode: code },
      ));
    });
  }

  get process(): ChildProcessWithoutNullStreams {
    return this.#child;
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    options: JsonRpcRequestOptions = {},
  ): Promise<T> {
    if (this.#fatalError) return Promise.reject(this.#fatalError);
    if (this.#closed) {
      return Promise.reject(new AcpProtocolError('acp_closed', 'ACP peer is closed'));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new AcpProtocolError('acp_aborted', `ACP request aborted: ${method}`));
    }

    const id = this.#nextId++;
    const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AcpProtocolError(
          'acp_timeout',
          `ACP request timed out after ${timeoutMs}ms: ${method}`,
        ));
      }, timeoutMs);

      const pending: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      };
      if (options.signal) {
        const onAbort = () => {
          const current = this.#pending.get(id);
          if (!current) return;
          this.#pending.delete(id);
          clearTimeout(current.timer);
          reject(new AcpProtocolError('acp_aborted', `ACP request aborted: ${method}`));
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
        pending.removeAbort = () => options.signal?.removeEventListener('abort', onAbort);
      }
      this.#pending.set(id, pending);
      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.#settle(id, false, error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#fatalError) throw this.#fatalError;
    if (this.#closed) throw new AcpProtocolError('acp_closed', 'ACP peer is closed');
    this.#write({ jsonrpc: '2.0', method, params });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(new AcpProtocolError('acp_closed', 'ACP peer closed'));
    if (!this.#child.killed) this.#child.kill();
  }

  #write(message: JsonRpcMessage): void {
    const encoded = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(encoded) > this.#options.maxMessageBytes) {
      throw new AcpProtocolError(
        'acp_message_too_large',
        'Outbound ACP message exceeds the configured byte limit',
      );
    }
    try {
      this.#child.stdin.write(encoded);
    } catch (error) {
      throw new AcpProtocolError('acp_write_failed', 'Failed to write ACP message', {
        cause: error,
      });
    }
  }

  #consumeStdout(chunk: Buffer): void {
    if (this.#fatalError || this.#closed) return;
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, chunk]);
    if (this.#stdoutBuffer.length > this.#options.maxLineBytes
      && this.#stdoutBuffer.indexOf(0x0a) === -1) {
      this.#fail(new AcpProtocolError(
        'acp_message_too_large',
        'ACP stdout line exceeds the configured byte limit',
      ));
      return;
    }

    while (true) {
      const newline = this.#stdoutBuffer.indexOf(0x0a);
      if (newline === -1) break;
      const line = this.#stdoutBuffer.subarray(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newline + 1);
      if (line.length === 0) continue;
      if (line.length > this.#options.maxLineBytes) {
        this.#fail(new AcpProtocolError(
          'acp_message_too_large',
          'ACP stdout line exceeds the configured byte limit',
        ));
        return;
      }
      this.#parseLine(line.toString('utf8').replace(/\r$/, ''));
      if (this.#fatalError) return;
    }
  }

  #consumeStderr(chunk: string): void {
    this.#stderrBuffer += chunk;
    const lines = this.#stderrBuffer.split(/\r?\n/);
    this.#stderrBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line) this.#options.onStderr?.(redactDiagnostic(line));
    }
  }

  #parseLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      this.#fail(new AcpProtocolError(
        'acp_malformed_message',
        'ACP stdout contained malformed JSON',
        { cause: error },
      ));
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      this.#fail(new AcpProtocolError(
        'acp_malformed_message',
        'ACP stdout contained an invalid JSON-RPC message',
      ));
      return;
    }
    const message = value as Record<string, unknown>;
    if (message.jsonrpc !== '2.0') {
      this.#fail(new AcpProtocolError(
        'acp_malformed_message',
        'ACP message is missing jsonrpc=2.0',
      ));
      return;
    }

    if (typeof message.method === 'string') {
      if (hasOwn(message, 'id')) {
        void this.#handleIncomingRequest(
          message.id as JsonRpcId,
          message.method,
          message.params,
        );
      } else {
        void Promise.resolve(
          this.#options.onNotification?.(message.method, message.params),
        ).catch(() => undefined);
      }
      return;
    }

    if (!hasOwn(message, 'id')) {
      this.#fail(new AcpProtocolError(
        'acp_malformed_message',
        'ACP response is missing an id',
      ));
      return;
    }
    const id = message.id as JsonRpcId;
    if (hasOwn(message, 'error')) {
      const remote = message as unknown as JsonRpcFailure;
      this.#settle(id, false, new AcpProtocolError(
        'acp_remote_error',
        remote.error?.message || 'ACP peer returned an error',
        { data: remote.error?.data },
      ));
    } else if (hasOwn(message, 'result')) {
      this.#settle(id, true, message.result);
    } else {
      this.#fail(new AcpProtocolError(
        'acp_malformed_message',
        'ACP response has neither result nor error',
      ));
    }
  }

  async #handleIncomingRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): Promise<void> {
    try {
      if (!this.#options.onRequest) {
        this.#write({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
        return;
      }
      const result = await this.#options.onRequest(method, params);
      this.#write({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (error) {
      this.#write({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : 'Client request handler failed',
        },
      });
    }
  }

  #settle(id: JsonRpcId, succeeded: boolean, value: unknown): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.removeAbort?.();
    if (succeeded) pending.resolve(value);
    else pending.reject(value);
  }

  #rejectPending(error: AcpProtocolError): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.removeAbort?.();
      pending.reject(error);
    }
  }

  #fail(error: AcpProtocolError): void {
    if (this.#fatalError || this.#closed) return;
    this.#fatalError = error;
    this.#rejectPending(error);
    if (!this.#child.killed) this.#child.kill();
  }
}

