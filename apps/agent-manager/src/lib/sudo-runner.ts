// 호스트에서 **권한 상승이 필요한 명령 하나**를 돌린다.
//
// 이 파일의 계약은 짧고, 그 짧음이 전부다:
//
//   1. argv 는 **호출자가 만든 것만** 받는다. 와이어에서 온 문자열을 여기로 흘려
//      보내면 커맨드 하나가 호스트에서 root 로 무엇이든 돌리는 통로가 된다.
//      (update_cli 는 cli-install-method 가 만든 argv 를, 승인형 경로는 서버가
//      보관한 **운영자가 승인한 바로 그 argv** 를 다시 받아 와서 넘긴다.)
//   2. 비밀번호는 **stdin 으로만** 간다. argv 에도, env 에도, 디스크에도, 로그에도
//      절대 넣지 않는다 — argv/env 는 같은 호스트의 다른 프로세스가 /proc 로 읽는다.
//   3. 쓰고 나면 버퍼를 0으로 덮는다. (JS 문자열 자체는 V8 힙에 남아 GC 전까지
//      지울 수 없다 — 그래서 호출자는 문자열이 아니라 Buffer 를 넘기는 쪽이 낫고,
//      서버에서 받아 온 원문은 여기 들어오는 즉시 Buffer 로 바꾼다.)
//   4. 출력에 비밀번호가 섞일 여지를 없앤다 — 프롬프트를 빈 문자열로 만들고(-p ''),
//      stdin 은 캡처 대상이 아니다.
//
// `-k` 를 항상 붙인다: sudo 의 타임스탬프 캐시가 살아 있으면 **틀린 비밀번호로도**
// 명령이 성공해 버려서, "이 비밀번호가 맞는가" 를 이 함수가 판정할 수 없게 된다.
// 매번 실제로 인증하게 만들어야 결과가 정직하다.

import crossSpawn from 'cross-spawn';

/** 권한 상승 명령의 상한. npm 재설치·snap refresh 가 들어오므로 넉넉히 잡되,
 *  무한정 기다려 커맨드 ack 를 붙잡아 두지는 않는다. */
export const SUDO_TIMEOUT_MS = 10 * 60 * 1000;

export type SudoFailure =
  /** 비밀번호가 틀렸다. 운영자에게 다시 묻는 것 외에 할 일이 없다. */
  | 'bad_password'
  /** 비밀번호는 맞지만 이 사용자가 그 명령을 sudo 로 돌릴 권한이 없다. */
  | 'not_permitted'
  /** 이 호스트에 sudo 가 없다(Windows 포함). */
  | 'no_sudo'
  | 'timeout'
  /** 인증은 통과했고 명령 자체가 0 이 아닌 코드로 끝났다. */
  | 'command_failed';

export interface SudoRunResult {
  ok: boolean;
  /** 합쳐진 stdout+stderr. 비밀번호는 여기 섞일 수 없다(프롬프트 억제 + stdin 미캡처). */
  output: string;
  reason: SudoFailure | null;
}

export interface SudoRunDeps {
  /** 테스트가 갈아끼운다. 실제 구현은 cross-spawn. */
  spawn?: typeof crossSpawn;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}

/** sudo 가 인증 실패를 알리는 방식은 로케일·버전마다 다르다. 영어 메시지만 보면
 *  한국어 로케일 호스트에서 "비밀번호 틀림" 을 "명령 실패" 로 오분류한다.
 *
 *  rolf 실측(sudo 1.9, en_US): 한 번의 실패가 세 줄을 뱉는다 —
 *    `Sorry, try again.` / `sudo: no password was provided` /
 *    `sudo: 1 incorrect password attempt`
 *  두 번째 줄은 stdin 이 한 줄 뒤 EOF 라서 나오는 것이고(우리는 정확히 그렇게
 *  쓴다), 그것만 단독으로 나오는 경우도 우리 입장에서는 같은 결론이다. */
const BAD_PASSWORD_RE =
  /(incorrect password|Sorry, try again|authentication failure|no password was provided|password is required|비밀번호가 틀렸|인증 실패|암호가 틀렸)/i;
const NOT_PERMITTED_RE =
  /(is not allowed to execute|not in the sudoers file|may not run|sudoers 파일에 없습니다)/i;

function classify(output: string, code: number | null): SudoFailure | null {
  if (BAD_PASSWORD_RE.test(output)) return 'bad_password';
  if (NOT_PERMITTED_RE.test(output)) return 'not_permitted';
  return code === 0 ? null : 'command_failed';
}

/**
 * `sudo -S -k -p '' -- <cmd> <args...>` 를 돌린다. 절대 throw 하지 않는다.
 *
 * `password` 는 호출 즉시 Buffer 로 복사해 stdin 에 쓰고 0으로 덮는다. 호출자는
 * 이 함수가 돌아온 뒤 자기 쪽 참조도 버려야 한다.
 */
export async function runWithSudo(
  argv: { cmd: string; args: string[] },
  password: string,
  deps: SudoRunDeps = {},
): Promise<SudoRunResult> {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    return {
      ok: false,
      output: '',
      reason: 'no_sudo',
    };
  }

  const spawn = deps.spawn ?? crossSpawn;
  const timeoutMs = deps.timeoutMs ?? SUDO_TIMEOUT_MS;

  return new Promise<SudoRunResult>((resolve) => {
    // `--` 뒤부터가 실행할 명령이다. 이게 없으면 argv 의 선행 `-x` 가 sudo 자신의
    // 옵션으로 먹혀서, 호출자가 만든 명령과 실제로 도는 명령이 달라진다.
    const child = spawn('sudo', ['-S', '-k', '-p', '', '--', argv.cmd, ...argv.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    });

    let output = '';
    let settled = false;
    const finish = (result: SudoRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ ok: false, output: `${output}\n[timeout after ${timeoutMs}ms]`.trim(), reason: 'timeout' });
    }, timeoutMs);

    child.stdout?.on('data', (b) => {
      output += String(b);
    });
    child.stderr?.on('data', (b) => {
      output += String(b);
    });
    child.on('error', (err: any) => {
      finish({
        ok: false,
        output: `[spawn error: ${err?.message ?? err}]`,
        reason: err?.code === 'ENOENT' ? 'no_sudo' : 'command_failed',
      });
    });
    child.on('close', (code) => {
      const reason = classify(output, code);
      finish({ ok: reason === null, output: output.trim(), reason });
    });

    // 비밀번호는 여기서만 프로세스 밖으로 나간다. 쓰고 즉시 덮는다.
    const secret = Buffer.from(`${password}\n`, 'utf8');
    try {
      child.stdin?.end(secret);
    } catch {
      /* stdin 이 이미 닫혔으면 sudo 가 인증 실패로 끝낼 것이고 위에서 분류된다. */
    } finally {
      secret.fill(0);
    }
  });
}
