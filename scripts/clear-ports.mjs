#!/usr/bin/env node
/**
 * clear-ports.mjs
 * npm run dev 실행 전, 사용 중인 소켓 포트를 정리합니다.
 * Node.js 기반 — Windows / Linux / macOS 모두 지원
 *
 * 대상 포트:
 *   7700  - Vite 프론트엔드 개발 서버 (client)
 *   7701  - Express 백엔드 서버 (server)
 *   7702  - MCP HTTP 서버 (standalone)
 */

import { execSync } from 'child_process';
import { platform } from 'os';

const PORTS = [7700, 7701, 7702];
const isWindows = platform() === 'win32';
let killed = 0;

/**
 * Windows: netstat + taskkill
 * Linux/macOS: lsof + kill
 */
function findAndKillProcessOnPort(port) {
  try {
    if (isWindows) {
      // netstat -ano 에서 LISTENING 상태인 포트의 PID 추출
      const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const pids = new Set();
      for (const line of output.trim().split('\n')) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== '0') pids.add(pid);
      }

      for (const pid of pids) {
        try {
          // tasklist 로 프로세스 이름 조회
          const taskInfo = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          const procName = taskInfo.split(',')[0]?.replace(/"/g, '') || 'unknown';

          execSync(`taskkill /PID ${pid} /F`, {
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          console.log(`  Port ${port} -> PID ${pid} (${procName}) 종료`);
          killed++;
        } catch {
          // 이미 종료된 프로세스 무시
        }
      }
    } else {
      // Linux / macOS
      const output = execSync(`lsof -ti :${port}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const pids = output.trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        try {
          let procName = 'unknown';
          try {
            procName = execSync(`ps -p ${pid} -o comm=`, {
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
          } catch { /* ignore */ }

          execSync(`kill -9 ${pid}`, { stdio: ['pipe', 'pipe', 'pipe'] });
          console.log(`  Port ${port} -> PID ${pid} (${procName}) 종료`);
          killed++;
        } catch {
          // 이미 종료된 프로세스 무시
        }
      }
    }
  } catch {
    // 포트를 사용하는 프로세스가 없으면 명령어가 실패 — 정상
  }
}

console.log(`\n  Clearing ports: ${PORTS.join(', ')}  (${isWindows ? 'Windows' : 'Unix'})\n`);

for (const port of PORTS) {
  findAndKillProcessOnPort(port);
}

if (killed > 0) {
  console.log(`\n  ${killed}개 프로세스를 정리했습니다.\n`);
} else {
  console.log(`  사용 중인 포트가 없습니다. 깨끗합니다!\n`);
}
