// cross-spawn 최소 ambient 타입 — @types/cross-spawn 이 설치돼 있지 않고 패키지도
// 번들 선언을 제공하지 않는다. cross-spawn 은 child_process.spawn 의 드롭인으로,
// Windows 에서 `.cmd`/`.bat` shim 을 cmd.exe 를 통해 인자를 PROPERLY ESCAPED 하여
// 실행한다(ticket e299c6b3) — bare spawn() 은 `.cmd` 를 아예 exec 하지 못하고,
// `shell: true` 는 인자를 escape 없이 이어붙여(DEP0190) codex 의 inline-TOML `-c`
// attribution 인자를 망가뜨린다.
declare module 'cross-spawn' {
  import type { ChildProcess, SpawnOptions } from 'node:child_process';
  function spawn(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess;
  export = spawn;
}
