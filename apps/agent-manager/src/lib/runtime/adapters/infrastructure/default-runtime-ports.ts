import crossSpawn from 'cross-spawn';
import { log } from '../../../logging.js';
import type { NormalizedRuntimeRequest, RuntimeError } from '../../domain/execution.js';
import type { RuntimeInfrastructurePorts } from '../../ports/index.js';

export function createDefaultRuntimePorts(): RuntimeInfrastructurePorts {
  return Object.freeze({
    session: { sessionId: request => request.sessionId },
    prompt: { encode: request => request.prompt },
    tools: {
      configure: request => Object.freeze({ mcpServers: request.mcpServers ?? [] }),
    },
    process: {
      spawn: (command, args, options) => crossSpawn(command, [...args], options as any),
    },
    retry: {
      shouldRetry: (error: RuntimeError, attempt: number) => error.retryable && attempt < 1,
    },
    telemetry: {
      record: (event, fields) => log(`[runtime] ${event} ${JSON.stringify(fields)}`),
    },
  });
}
