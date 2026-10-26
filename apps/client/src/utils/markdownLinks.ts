export function autoLinkHref(candidate: string): string {
  const brackets: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const balance: Record<string, number> = { '(': 0, '[': 0, '{': 0 };
  let end = candidate.length;
  for (let i = 0; i < candidate.length; i++) {
    const char = candidate[i];
    if (char in balance) balance[char]++;
    else if (char in brackets) {
      const opening = brackets[char];
      // An unmatched closing bracket ends the URL even in `)에서`, not just at EOF.
      if (balance[opening] === 0) {
        end = i;
        break;
      }
      balance[opening]--;
    }
  }
  return candidate.slice(0, end).replace(/[.,!?;:]+$/, '');
}
