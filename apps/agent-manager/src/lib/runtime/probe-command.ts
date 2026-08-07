import crossSpawn from 'cross-spawn';

export const PROBE_TIMEOUT_MS = 2_500;
export const MAX_PROBE_OUTPUT = 16 * 1024;

export interface RuntimeProbeResult {
  installed: boolean;
  healthy: boolean;
  version: string | null;
  reason: string | null;
}

export interface CapturedCommandResult {
  installed: boolean;
  healthy: boolean;
  reason: string | null;
  output: string;
}

function firstVersionLine(output: string): string | null {
  const line = output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ? line.slice(0, 160) : null;
}

/**
 * `command args`를 실행하며 실행시간과 stdout+stderr 합산 크기에 상한을 두고,
 * 캡처한 원본 출력과 설치/종료 상태를 함께 반환한다. 버전 프로브(probeRuntimeCommand)와
 * 전체 텍스트가 필요한 호출부(예: `hermes profile list` 파싱) 양쪽이 공유하는
 * 저수준 프리미티브다.
 */
export async function runCapturedCommand(
  command: string,
  args: string[],
): Promise<CapturedCommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    let started = false;
    const finish = (result: CapturedCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = crossSpawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.once('spawn', () => {
      started = true;
    });
    const append = (chunk: Buffer | string) => {
      if (output.length >= MAX_PROBE_OUTPUT) return;
      output += String(chunk).slice(0, MAX_PROBE_OUTPUT - output.length);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish({
        installed: false,
        healthy: false,
        reason: error.code === 'ENOENT' ? 'not_found' : 'not_executable',
        output,
      });
    });
    child.once('close', (code) => {
      finish({
        installed: true,
        healthy: code === 0,
        reason: code === 0 ? null : 'probe_failed',
        output,
      });
    });
    const timer = setTimeout(() => {
      if (started) child.kill();
      finish({
        installed: started,
        healthy: false,
        reason: 'probe_timeout',
        output,
      });
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
}

export async function probeRuntimeCommand(
  command: string,
  args: string[],
): Promise<RuntimeProbeResult> {
  const result = await runCapturedCommand(command, args);
  return {
    installed: result.installed,
    healthy: result.healthy,
    version: result.installed ? firstVersionLine(result.output) : null,
    reason: result.reason,
  };
}
