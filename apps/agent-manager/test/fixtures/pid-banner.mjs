// 티켓 070d8f0b 재현 하네스 전용 진단 훅 — 평상시 CI 경로에서는 로드되지 않는다.
//
// 왜 필요한가: windows 축에서 테스트 파일 하나가 서브테스트 0개로 exit 1 하는
// flake 를 쫓고 있다. 증상이 "출력 전무" 라서 죽은 자식이 **어떤 pid 였는지** 를
// 알 방법이 없고, 그게 없으면 kill 사이트가 찍은 대상 pid 와 대조할 수가 없다.
//
// node --test 는 파일마다 자식 node 를 띄우고 그 자식은 NODE_OPTIONS 를 그대로
// 물려받는다. 그래서 `NODE_OPTIONS=--import <이 파일>` 하나로 모든 테스트 자식이
// 자기 pid 를 시작 직후에 한 줄 남긴다. 자식 stderr 는 러너가 TAP `#` 주석으로
// 흘려주므로 잡 로그에 그대로 남는다.
//
// 126ms 만에 죽은 자식도 이 줄은 남긴다 — 훅은 테스트 파일 본문 import 보다
// 먼저 돌기 때문이다. 반대로 이 줄조차 없으면 그 자식은 프로세스가 만들어진
// 직후에 죽었다는 뜻이라, 그 자체가 판독 가능한 신호다.
//
// ── 왜 "테스트 자식에서만" 인가 (실측으로 배운 것) ──────────────────────────
// NODE_OPTIONS 는 테스트 자식에서 멈추지 않고 **손자까지** 물려간다. 이 스위트에는
// 자식 node 를 spawn 해서 그 argv·stdout·stderr 를 그대로 대조하는 테스트가 많은데,
// 손자가 이 배너를 자기 stderr 에 쓰면 그 픽스처가 통째로 깨진다. 첫 시도에서
// 정확히 그렇게 돼서 1573개 중 32개가 라운드마다 결정적으로 실패했다 — 쫓던 flake
// 와는 무관한 순수 하네스 오염이었다.
//
// 그래서 두 가지를 한다:
//   1) 테스트 자식에서만 찍는다. 러너 부모는 execArgv 에 `--test` 를 갖고 자식은
//      갖지 않는다(자식은 `--test-force-exit` 만 물려받는다). 부모가 안 찍는 건
//      물론이고, 부모가 NODE_OPTIONS 를 그대로 들고 있어야 자식이 훅을 받는다.
//   2) 찍은 뒤 자기 자신을 NODE_OPTIONS 에서 지운다. 그래야 이 테스트가 만드는
//      손자부터는 깨끗한 환경을 받는다. 훅은 테스트 본문보다 먼저 돌므로 본문이
//      spawn 하는 모든 자식은 이미 정리된 값을 본다.

const execArgv = process.execArgv ?? [];
const entry = process.argv[1] ?? '';
const isTestChild = !execArgv.includes('--test') && entry.endsWith('.test.mjs');

if (isTestChild) {
  process.stderr.write(`[pid-banner] pid=${process.pid} ppid=${process.ppid} entry=${entry}\n`);

  // 손자에게는 물려주지 않는다 — 위 2) 참조.
  const cleaned = (process.env.NODE_OPTIONS ?? '')
    .replace(/(^|\s)--import[=\s]+\S*pid-banner\.mjs/g, ' ')
    .trim();
  if (cleaned) process.env.NODE_OPTIONS = cleaned;
  else delete process.env.NODE_OPTIONS;
}
