/**
 * 권한 상승(sudo) 요청 MCP 도구 — 세션/채팅의 agent 가 **요청만** 할 수 있고,
 * 실행은 운영자가 AWB 화면에서 명령을 읽고 승인하면서 비밀번호를 칠 때만 일어난다.
 *
 * ## 왜 agent 가 직접 sudo 를 쓰지 않는가
 *
 * agent 에게 상시 sudo 권한(저장된 비밀번호, sudoers NOPASSWD 등)을 주면 그
 * agent 는 root 다 — 프롬프트 인젝션 한 번이 곧 루트 권한 탈취가 된다. 그래서
 * 이 표면에는 저장된 비밀번호가 없고, 승인은 **명령 하나마다** 일어난다.
 *
 * ## 호출을 막지 않는다
 *
 * 이 저장소의 관례(`await_ci_run` 참고)대로 MCP 호출을 오래 붙잡지 않는다.
 * `request_privileged_command` 는 즉시 돌아오고, 결과는
 * `get_privileged_command_result` 로 받는다 — 그 쪽은 상태가 바뀌거나 짧은 창이
 * 지날 때까지만 기다렸다가 돌아오므로, 아직 pending 이면 다시 부르면 된다.
 *
 * Auto-registered by the `tools/index.ts` filename-convention loader.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

/** `get_privileged_command_result` 한 번이 기다리는 최대 시간. MCP 호출을 오래
 *  붙잡지 않으면서도 대부분의 승인을 한두 번의 호출로 잡을 만큼. */
const POLL_WINDOW_MS = 20_000;

export function registerPrivilegedCommandTools(server: McpServer, ctx: ToolContext): void {
  const svc = ctx.privilegedCommandService;
  const registry = ctx.instanceRegistryService;

  server.tool(
    'request_privileged_command',
    'Ask a human operator to run ONE command as root on the Runtime Host that supervises you. ' +
      'You do NOT get root — this only creates an approval request. A human reads the exact command in the AWB admin UI and either denies it or approves it by typing the host sudo password, which AWB never stores. ' +
      'Returns immediately with a request_id; poll `get_privileged_command_result` for the outcome. Do not retry the same command while one is pending. ' +
      'The command you pass here is the command that runs — it is recorded verbatim and the manager re-fetches that exact argv before executing, so it cannot be changed after approval. ' +
      'Any authenticated agent session may call this, but only an agent supervised by a live Runtime Host manager can (there is nowhere to run otherwise). ' +
      'Default is denial: if no operator decides within the approval window, the request expires unexecuted. ' +
      'Prefer fixing permissions over asking for root (e.g. chown a directory you own) — an approval request costs a human interrupt every single time.',
    {
      command: z.string().describe('Executable to run as root, e.g. "apt-get". No shell is involved — pipes, redirects, globs and `&&` will NOT work; pass a single program.'),
      args: z.array(z.string()).optional().describe('Arguments, one array element each (e.g. ["install","-y","ripgrep"]). Never embed shell metacharacters expecting them to be interpreted.'),
      cwd: z.string().optional().describe('Working directory for the command. Defaults to the manager process working directory.'),
      reason: z.string().describe('Why this needs root, in one or two sentences. The operator sees this next to the command and decides on it — a vague reason is usually denied.'),
    },
    async ({ command, args, cwd, reason }, extra: { sessionId?: string }) => {
      if (!svc || !registry) {
        return err('privileged command approval is not available on this server (no Runtime Host registry)');
      }
      const caller = getCallerAgent(extra);
      if (!caller?.agentId) return err('this tool requires an authenticated agent session');

      const trimmedCommand = String(command || '').trim();
      if (!trimmedCommand) return err('command is required');
      if (!String(reason || '').trim()) return err('reason is required — the operator decides on it');

      // 이 agent 를 감독하는 살아 있는 매니저 인스턴스. 없으면 실행될 곳이 없다.
      const inst = registry
        .list()
        .find((i) => i.mode === 'manager' && (i.agent_ids ?? []).includes(caller.agentId as string));
      if (!inst) {
        return err(
          'no live Runtime Host manager supervises this agent, so there is nowhere to run a privileged command',
        );
      }

      const created = svc.create({
        workspace_id: inst.workspace_id ?? null,
        agent_id: caller.agentId,
        agent_name: caller.agentName || caller.agentId,
        instance_id: inst.instance_id,
        hostname: inst.hostname,
        command: trimmedCommand,
        args: (args ?? []).map((a) => String(a)),
        cwd: cwd ? String(cwd) : null,
        reason: String(reason),
      });
      if (!created.ok) {
        return err(
          'you already have the maximum number of privileged-command requests awaiting a human decision — ' +
            'wait for those to be decided instead of queueing more',
        );
      }
      return ok({
        request_id: created.request.request_id,
        status: created.request.status,
        host: created.request.hostname,
        awaiting: 'a human operator must approve this in the AWB admin UI',
      });
    },
  );

  server.tool(
    'get_privileged_command_result',
    'Fetch the outcome of a `request_privileged_command` request. ' +
      'Waits a short while for the state to change and then returns whatever it has — call it again while status is "pending" or "running". ' +
      'Statuses: pending (no human decision yet), approved/running (a human approved it; the host is executing), done (finished — check `ok` and `output`), denied (a human refused), expired (nobody decided in time). ' +
      'Only the agent that created the request may read it.',
    {
      request_id: z.string().describe('The request_id returned by request_privileged_command'),
    },
    async ({ request_id }, extra: { sessionId?: string }) => {
      if (!svc) return err('privileged command approval is not available on this server');
      const caller = getCallerAgent(extra);
      if (!caller?.agentId) return err('this tool requires an authenticated agent session');

      // 소유권 검사는 게이트가 표현할 수 없다(런북 (d)) — 여기서 직접 한다.
      const existing = svc.get(String(request_id || ''));
      if (!existing) return err('unknown or expired request_id');
      if (existing.agent_id !== caller.agentId) {
        return err('this request belongs to a different agent', { status: 403 });
      }

      if (existing.status === 'pending' || existing.status === 'approved' || existing.status === 'running') {
        await svc.waitForChange(existing.request_id, POLL_WINDOW_MS);
      }
      const req = svc.get(existing.request_id);
      if (!req) return err('unknown or expired request_id');
      return ok({
        request_id: req.request_id,
        status: req.status,
        ok: req.ok,
        output: req.output,
        failure: req.failure,
        command: req.command,
        args: req.args,
        host: req.hostname,
      });
    },
  );
}
