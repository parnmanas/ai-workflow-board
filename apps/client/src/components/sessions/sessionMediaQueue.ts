// Keep image/history-file uploads from occupying every connection to a remote host.
const pending: Array<() => void> = [];
let active = 0;
const MAX_ACTIVE = 3;

function drain() {
  while (active < MAX_ACTIVE && pending.length) pending.shift()!();
}

export function queueSessionMedia<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      const index = pending.indexOf(start);
      if (index >= 0) pending.splice(index, 1);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const start = () => {
      signal.removeEventListener('abort', aborted);
      if (signal.aborted) { aborted(); return; }
      active++;
      void Promise.resolve().then(read).then(resolve, reject).finally(() => { active--; drain(); });
    };
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    pending.push(start);
    drain();
  });
}
