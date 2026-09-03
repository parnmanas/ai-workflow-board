// 티켓 070d8f0b 재현 하네스 전용 진단 훅 — 평상시 CI 경로에서는 로드되지 않는다.
//
// 왜 필요한가: windows 축에서 테스트 파일 하나가 서브테스트 0개로 exit 1 하는
// flake 를 쫓고 있다. 증상이 "출력 전무" 라서 죽은 자식이 **어떤 pid 였는지** 를
// 알 방법이 없고, 그게 없으면 kill 사이트가 찍은 대상 pid 와 대조할 수가 없다.
//
// node --test 는 파일마다 자식 node 를 띄우고 그 자식은 NODE_OPTIONS 를 그대로
// 물려받는다. 그래서 `NODE_OPTIONS=--import <이 파일>` 하나로 부모와 모든 테스트
// 자식이 자기 pid 를 시작 직후에 한 줄 남긴다. 자식 stderr 는 러너가 TAP `#`
// 주석으로 흘려주므로 잡 로그에 그대로 남는다.
//
// 126ms 만에 죽은 자식도 이 줄은 남긴다 — 훅은 테스트 파일 본문 import 보다
// 먼저 돌기 때문이다. 반대로 이 줄조차 없으면 그 자식은 프로세스가 만들어진
// 직후에 죽었다는 뜻이라, 그 자체가 판독 가능한 신호다.
//
// stderr 를 쓰는 이유: stdout 은 자식의 TAP 스트림이라 오염시키면 러너의 파싱이
// 깨진다.

process.stderr.write(
  `[pid-banner] pid=${process.pid} ppid=${process.ppid} entry=${process.argv[1] ?? '-'}\n`,
);
