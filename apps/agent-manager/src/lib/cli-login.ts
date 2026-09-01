// ticket b2e79108 — Codex CLI device-auth 자동 로그인.
// ticket 06b2b990 — 위 패턴을 Claude CLI로 확장.
//
// `codex login --device-auth` / `claude auth login --claudeai` 를 격리된
// CODEX_HOME/CLAUDE_CONFIG_DIR(호스트/에이전트가 실제로 쓰는 ~/.codex,
// ~/.claude 와 절대 공유하지 않음)에서 spawn하고, stdout을 줄 단위로 스캔해
// verification URL(+codex만 one-time code)을 뽑아 서버로 릴레이한다. 프로세스가
// exit 0 하면 격리 홈의 인증 파일(codex: auth.json(+config.toml), claude:
// .credentials.json)을 읽어 서버로 넘기고(서버가 암호화해 Credential 로
// 저장), 성공/실패/타임아웃/취소 모든 경로에서 격리 홈을 삭제한다 — 단, 성공
// 보고 자체가 서버에 끝내 전달되지 못한 경우는 예외(리뷰 반영: 유일한 사본을
// 지우지 않음, #finish 참고).
//
// ticket b2e79108 작성 시점엔 claude 가 codex `--device-auth` 만큼 깔끔한
// 비대화형 플래그가 없어(PTY 릴레이 필요할 것으로 추정) 후속 티켓으로
// 분리했었다. 그러나 라이브 호스트(claude-cli 2.1.238)에서 직접 검증한 결과
// `claude auth login`은 TTY를 요구하지 않는다 — codex와 동일하게 순수 stdio
// 파이프(stdout 스캔 + SIGTERM 취소)만으로 동작하고, 승인 후 폴링도 CLI가
// 알아서 완료한다("Paste code here if prompted"는 자동 폴링이 실패했을 때만
// 쓰이는 조건부 폴백이라 AWB의 릴레이 대상이 아니다 — 우리가 필요한 건
// verification_url 뿐이다). 따라서 node-pty 없이 codex와 동일한 crossSpawn
// 경로로 구현한다.
//
// 실제 출력 포맷(라이브 호스트에서 캡처):
//
//   codex-cli 0.147.0, 격리 CODEX_HOME:
//     1. Open this link in your browser and sign in to your account
//        https://auth.openai.com/codex/device
//
//     2. Enter this one-time code (expires in 15 minutes)
//        5EQ1-BCF0O
//
//   claude-cli 2.1.238, 격리 CLAUDE_CONFIG_DIR (`claude auth login --claudeai`):
//     Opening browser to sign in…
//     If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?...
//     Paste code here if prompted >
//
// 버전업 시 문구가 바뀔 수 있으므로 파싱은 정확한 코드 포맷이 아니라 주변
// 영문 안내 문구("Open this link"/"Enter this one-time code")나 URL 자체의
// 등장에 기대고, 그 파싱이 일정 시간(PARSE_FALLBACK_QUIET_MS) 안에 URL을 못
// 찾으면 리뷰 지적대로 raw 출력(redact된)을 awaiting_user 의
// raw_output_fallback 으로 그대로 올려 UI가 최소한 "뭔가는 보여줄" 수 있게
// 한다 — 완전히 파싱이 깨져도 사용자가 starting 상태에 갇혀 아무것도 못 보는
// 상황을 막는다.
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import crossSpawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import { CLI_LOGINS_DIR } from './constants.js';
import { assertCliExecutable, resolveCliBin } from './cli-resolver.js';
import { log } from './logging.js';
import { postCliLoginProgress, type AwbConfig } from './rest.js';

// 티켓 요구사항: 기본 타임아웃 10분("실패/타임아웃/취소 시 임시 홈이 남지
// 않고 사용자에게 사유가 표시된다").
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const KILL_ESCALATION_MS = 3_000;
// 구조화 파싱(URL+코드)이 이 시간 동안 조용하면(새 줄이 안 오면) raw fallback
// 을 1회 전송한다. 실제 캡처에서 배너~안내문 사이에 눈에 띄는 지연이 없었으므로
// 2초면 정상 케이스에서 오탐 없이 충분하다고 판단.
const PARSE_FALLBACK_QUIET_MS = 2_000;
const RAW_FALLBACK_MAX_CHARS = 4_000;
const RAW_FALLBACK_MAX_LINES = 40;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(line: string): string {
  return line.replace(ANSI_RE, '');
}

// 리뷰 지적: CLI stderr 원문을 무필터로 로그에 남기고 있었다. codex 자신의
// 정상 출력(우리가 파싱하는 stdout)에는 토큰이 없지만, stderr 는 우리가
// 형식을 통제할 수 없는 진단 채널이라 방어적으로 토큰/시크릿처럼 보이는
// 패턴을 전부 지운다 — URL 은 이 함수를 거치지 않는 채널(progress payload)
// 로만 전달되므로 여기서 과도하게 지워도 실제 흐름에 영향 없다.
//
// 리뷰 지적(round 2, 확인된 버그): 모든 패턴에 같은 (label, sep) 2-인자
// replacer를 재사용했으나, JWT/prefix-key 정규식엔 capture group이 없어
// String.replace가 그 자리에 (offset, fullString)을 넘겼다. offset은 문자열
// 중간 매치에서 truthy라 `${label}${sep}[REDACTED]` 분기가 그대로 타면서
// fullString(원본 전체, 즉 시크릿 그대로)이 결과에 통째로 다시 삽입됐다 —
// redact는커녕 원문을 중복 노출하는 정반대 결과. 패턴마다 자기 capture
// group 구조에 맞는 전용 replacer를 쓰도록 분리해 이 클래스의 버그를
// 구조적으로 막는다(공유 콜백이 모든 정규식에 같은 인자 수를 가정하지
// 않는다).
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const PREFIXED_KEY_RE = /\b(?:sk|rk|pk|oat|sat|rt|pat|ghp|ghs|xox[a-z])[-_][A-Za-z0-9_-]{8,}\b/gi;
const LABELED_SECRET_RE =
  /\b(access_token|refresh_token|id_token|api_key|client_secret|password)\b(\s*[:=]\s*)["']?[A-Za-z0-9_.\-]{6,}["']?/gi;
// 마지막 방어선: URL이 아니면서 문자+숫자를 모두 포함한 24자 이상의 opaque
// 토큰형 문자열은 라벨/포맷을 못 맞춘 미지의 시크릿일 수 있으므로 지운다.
const OPAQUE_TOKEN_RE = /\b(?!https?:)[A-Za-z0-9_\-.]{24,}\b/g;

function redactSecrets(text: string): string {
  let out = text;
  out = out.replace(JWT_RE, '[REDACTED]');
  out = out.replace(PREFIXED_KEY_RE, '[REDACTED]');
  out = out.replace(LABELED_SECRET_RE, (_match, label, sep) => `${label}${sep}[REDACTED]`);
  out = out.replace(OPAQUE_TOKEN_RE, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? '[REDACTED]' : m));
  return out;
}

export interface CliLoginStartArgs {
  sessionId: string;
  commandId: string;
  cli: string;
}

type FinishResult =
  | { status: 'awaiting_user'; verification_url?: string; user_code?: string; raw_output_fallback?: string }
  | { status: 'succeeded'; credential_fields: Record<string, string> }
  | { status: 'failed' | 'timed_out' | 'cancelled'; error_detail: string };

interface ActiveLogin {
  sessionId: string;
  commandId: string;
  cli: string;
  child: ChildProcess;
  homeDir: string;
  timer: ReturnType<typeof setTimeout>;
  finished: boolean;
}

const SUPPORTED_CLIS: ReadonlySet<string> = new Set(['codex', 'claude']);

/**
 * 매니저당 로그인 세션 1개 제한(격리 홈 충돌·자원 낭비 방지 — 티켓 보안
 * 요구사항). 두 번째 cli_login_start 는 isBusy() 로 걸러 즉시 에러로 ack된다.
 */
export class CliLoginManager {
  #config: AwbConfig;
  #active: ActiveLogin | null = null;
  #timeoutMs: number;
  #fallbackQuietMs: number;
  #codexBin: string | null;
  #claudeBin: string | null;

  constructor(
    config: AwbConfig,
    opts: { timeoutMs?: number; fallbackQuietMs?: number; codexBin?: string; claudeBin?: string } = {},
  ) {
    this.#config = config;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fallbackQuietMs = opts.fallbackQuietMs ?? PARSE_FALLBACK_QUIET_MS;
    // Test-only override — without this, resolveCliBin(cli, null) would find
    // a REAL codex/claude install ahead of any PATH shim a test sets up (it
    // checks well-known install paths — e.g. ~/.npm-global/bin/codex —
    // before falling back to `command -v`), making it impossible to point
    // tests at a fake binary via env manipulation alone.
    this.#codexBin = opts.codexBin ?? null;
    this.#claudeBin = opts.claudeBin ?? null;
  }

  isBusy(): boolean {
    return this.#active !== null;
  }

  /**
   * 프로세스를 spawn하고 리스너를 건 뒤 spawn 성공 확인 즉시 반환한다 —
   * 완료까지 기다리지 않는다. 완료까지 기다리면 서버의 command-ledger 10분
   * ack TTL을 넘길 수 있다(사람이 브라우저 승인을 마칠 때까지 걸리는 시간).
   * 이후 진행상황은 postCliLoginProgress 로 fire-and-forget 릴레이된다.
   */
  async start(args: CliLoginStartArgs): Promise<void> {
    if (this.#active) {
      throw new Error(
        `another login session (${this.#active.sessionId.slice(0, 8)}) is already in flight on this manager`,
      );
    }
    if (!SUPPORTED_CLIS.has(args.cli)) {
      throw new Error(`unsupported cli "${args.cli}" — only codex/claude device-auth login is automated so far`);
    }

    const homeDir = join(CLI_LOGINS_DIR, args.sessionId);
    await mkdir(homeDir, { recursive: true, mode: 0o700 });

    const isClaude = args.cli === 'claude';
    const bin = isClaude ? this.#claudeBin ?? resolveCliBin('claude', null) : this.#codexBin ?? resolveCliBin('codex', null);
    assertCliExecutable(bin, args.cli);
    const spawnArgs = isClaude ? ['auth', 'login', '--claudeai'] : ['login', '--device-auth'];
    const env = isClaude
      ? { ...process.env, CLAUDE_CONFIG_DIR: homeDir }
      : { ...process.env, CODEX_HOME: homeDir };
    const child = crossSpawn(bin, spawnArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    const active: ActiveLogin = {
      sessionId: args.sessionId,
      commandId: args.commandId,
      cli: args.cli,
      child,
      homeDir,
      finished: false,
      timer: null as unknown as ReturnType<typeof setTimeout>,
    };
    active.timer = setTimeout(() => {
      void this.#finish(active, {
        status: 'timed_out',
        error_detail: `device-auth login did not complete within ${Math.round(this.#timeoutMs / 60_000)} minute(s)`,
      });
    }, this.#timeoutMs);
    active.timer.unref?.();
    this.#active = active;

    this.#wireOutput(active);

    child.on('error', (err: any) => {
      void this.#finish(active, { status: 'failed', error_detail: `spawn failed: ${err?.message ?? err}` });
    });
    child.on('close', (code) => {
      if (active.finished) return;
      if (code === 0) {
        void this.#completeSuccess(active);
      } else {
        void this.#finish(active, {
          status: 'failed',
          error_detail: `${active.cli} login exited with code ${code}`,
        });
      }
    });

    // spawn() 자체가 ENOENT 등으로 즉시 실패하는 경우를 ack 실패로 표면화하기
    // 위해 'spawn' 이벤트(성공) 또는 'error'(실패) 중 먼저 오는 것까지만 기다린다
    // — 로그인 완료까지는 기다리지 않는다.
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        child.off('error', onError);
        child.off('spawn', onSpawn);
      };
      const onError = (err: any) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      child.once('error', onError);
      child.once('spawn', onSpawn);
    });
  }

  /** cli_login_cancel 커맨드 핸들러가 호출. 이 매니저에 활성 세션이 없거나
   *  sessionId가 다르면 false(이미 끝났거나 다른 매니저 소관). */
  async cancel(sessionId: string): Promise<boolean> {
    if (!this.#active || this.#active.sessionId !== sessionId) return false;
    await this.#finish(this.#active, { status: 'cancelled', error_detail: 'Cancelled by user' });
    return true;
  }

  #wireOutput(active: ActiveLogin): void {
    let urlCaptured = false;
    let fullyParsed = false;
    let fallbackSent = false;
    let capturedUrl = '';
    const rawLines: string[] = [];
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleFallback = () => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (fullyParsed || fallbackSent) return;
      fallbackTimer = setTimeout(() => {
        if (fullyParsed || fallbackSent || rawLines.length === 0) return;
        fallbackSent = true;
        void postCliLoginProgress(this.#config, {
          session_id: active.sessionId,
          command_id: active.commandId,
          status: 'awaiting_user',
          raw_output_fallback: rawLines.join('\n').slice(0, RAW_FALLBACK_MAX_CHARS),
        });
      }, this.#fallbackQuietMs);
      fallbackTimer.unref?.();
    };

    let expectCodeNext = false;
    // 리뷰 반영: URL/코드 파싱이 안 되는 경우를 대비해, 새 줄이 온 시점마다
    // "구조화 파싱이 끝났는지" 와 무관하게 raw fallback도 함께 스케줄링한다.
    // 실제 url+code 를 못 찾은 라인이든 찾은 라인이든 이 함수 하나에서 처리
    // — scanLine 이 호출 순서상 이 함수보다 먼저 오지 않도록 여기서 함께 정의한다.
    //
    // 인자는 redaction을 거치지 않은 원문(rawLine)이다 — URL/코드는 애초에
    // 비밀이 아니고(티켓 보안 요구사항이 노출을 명시적으로 허용), redaction
    // 정규식(특히 OPAQUE_TOKEN_RE)이 URL 안의 정상 값(OAuth client_id/state
    // 등 24자+ 영숫자-하이픈 문자열)을 [REDACTED]로 지워 승인 링크 자체를
    // 손상시키는 회귀가 실제로 있었다(리뷰 지적, ticket 06b2b990).
    const handleParsedLine = (rawLine: string) => {
      // claude는 codex와 달리 사용자가 브라우저 밖에서 입력할 one-time code가
      // 없다 — verification_url을 여는 것 자체가 승인 흐름의 전부이고, 이후
      // 완료 여부는 claude CLI 자신이 백그라운드에서 폴링해 감지한다("Paste
      // code here if prompted"는 자동 폴링이 실패했을 때만 쓰이는 조건부
      // 폴백이라 릴레이 대상이 아니다 — 파일 상단 주석 참고). 그래서 URL을
      // 찾는 즉시(코드를 기다리지 않고) awaiting_user를 보고한다.
      if (active.cli === 'claude') {
        if (!urlCaptured) {
          const urlMatch = rawLine.match(/https?:\/\/\S+/);
          if (urlMatch) {
            capturedUrl = urlMatch[0];
            urlCaptured = true;
            fullyParsed = true;
            if (fallbackTimer) clearTimeout(fallbackTimer);
            void postCliLoginProgress(this.#config, {
              session_id: active.sessionId,
              command_id: active.commandId,
              status: 'awaiting_user',
              verification_url: capturedUrl,
            });
          }
        }
        return;
      }

      if (expectCodeNext) {
        expectCodeNext = false;
        fullyParsed = true;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        void postCliLoginProgress(this.#config, {
          session_id: active.sessionId,
          command_id: active.commandId,
          status: 'awaiting_user',
          verification_url: capturedUrl,
          user_code: rawLine,
        });
        return;
      }
      if (!urlCaptured) {
        const urlMatch = rawLine.match(/https?:\/\/\S+/);
        if (urlMatch) {
          capturedUrl = urlMatch[0];
          urlCaptured = true;
        }
      }
      if (/enter this one-time code/i.test(rawLine)) {
        expectCodeNext = true;
      }
    };

    const scanLine = (raw: string) => {
      const rawLine = stripAnsi(raw).trim();
      if (!rawLine) return;
      const redactedLine = redactSecrets(rawLine);

      // raw_output_fallback (unrecognized-format safety net, shown verbatim
      // in the UI) must stay redacted — it's untrusted-format text that may
      // contain secrets.
      rawLines.push(redactedLine);
      if (rawLines.length > RAW_FALLBACK_MAX_LINES) rawLines.shift();
      scheduleFallback();

      // 리뷰 지적(round 1, ticket 06b2b990) — 확인된 버그: 구조화 추출을
      // redactedLine에 대해 수행했더니, OPAQUE_TOKEN_RE(하이픈 포함 24자+
      // 영숫자)가 URL 자체가 아니라 URL "안"의 값(예: claude의 OAuth
      // client_id/state 쿼리 파라미터, UUID 형태)을 [REDACTED]로 지워버려
      // 사용자에게 릴레이되는 verification_url이 브라우저에서 승인 불가능한
      // 손상된 링크가 됐다. URL/코드는 애초에 비밀이 아니므로(티켓 보안
      // 요구사항이 노출을 명시적으로 허용) 구조화 추출은 원문(rawLine)에서
      // 수행한다 — redaction은 raw_output_fallback/stderr 로그처럼 "포맷을
      // 통제할 수 없는" 표면에만 적용한다.
      handleParsedLine(rawLine);
    };

    if (active.child.stdout) {
      createInterface({ input: active.child.stdout }).on('line', scanLine);
    }
    if (active.child.stderr) {
      createInterface({ input: active.child.stderr }).on('line', (raw) => {
        log(`cli-login[${active.sessionId.slice(0, 8)}][err] ${redactSecrets(stripAnsi(raw).trim())}`);
      });
    }
  }

  async #completeSuccess(active: ActiveLogin): Promise<void> {
    if (active.cli === 'claude') {
      let credentialsJson = '';
      try {
        credentialsJson = await readFile(join(active.homeDir, '.credentials.json'), 'utf8');
      } catch (err: any) {
        await this.#finish(active, {
          status: 'failed',
          error_detail: `claude auth login exited 0 but .credentials.json was not found in the isolated CLAUDE_CONFIG_DIR: ${err?.message ?? err}`,
        });
        return;
      }
      await this.#finish(active, {
        status: 'succeeded',
        credential_fields: { credentials_json: credentialsJson },
      });
      return;
    }

    let authJson = '';
    try {
      authJson = await readFile(join(active.homeDir, 'auth.json'), 'utf8');
    } catch (err: any) {
      await this.#finish(active, {
        status: 'failed',
        error_detail: `codex login exited 0 but auth.json was not found in the isolated CODEX_HOME: ${err?.message ?? err}`,
      });
      return;
    }
    let configToml = '';
    try {
      configToml = await readFile(join(active.homeDir, 'config.toml'), 'utf8');
    } catch {
      // config.toml is optional for codex_subscription — only auth_json is required.
    }
    await this.#finish(active, {
      status: 'succeeded',
      credential_fields: configToml ? { auth_json: authJson, config_toml: configToml } : { auth_json: authJson },
    });
  }

  async #finish(active: ActiveLogin, result: FinishResult): Promise<void> {
    if (active.finished) return;
    active.finished = true;
    clearTimeout(active.timer);
    if (this.#active === active) this.#active = null;

    try {
      active.child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        try {
          if (!active.child.killed) active.child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, KILL_ESCALATION_MS);
      killTimer.unref?.();
    } catch {
      /* already gone */
    }

    const delivered = await postCliLoginProgress(this.#config, {
      session_id: active.sessionId,
      command_id: active.commandId,
      ...result,
    });

    // 리뷰 반영: 성공했지만 서버에 끝내 보고를 전달하지 못한 경우, 격리 홈을
    // 지우면 harvested credential의 유일한 사본을 영영 잃는다. 이 경우에만
    // 삭제를 건너뛴다 — 실패/타임아웃/취소는 애초에 민감 데이터가 없으므로
    // 항상 삭제한다(티켓 완료 기준 4).
    if (result.status === 'succeeded' && !delivered) {
      log(
        `cli-login: leaving isolated home on disk (session=${active.sessionId.slice(0, 8)}, path=${active.homeDir}) ` +
          `— succeeded but the server never confirmed receipt; not deleting the only copy of the harvested credential.`,
      );
      return;
    }

    // 성공/실패/타임아웃/취소 모든 경로에서 격리 홈을 삭제 — auth.json 등
    // 민감 파일을 디스크에 남기지 않는다(티켓 완료 기준 4).
    await rm(active.homeDir, { recursive: true, force: true }).catch((err: any) => {
      log(`cli-login: failed to remove isolated home ${active.homeDir}: ${err?.message ?? err}`);
    });
  }
}
