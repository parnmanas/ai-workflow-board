// test/helpers/shell-commands.mjs — 셸 명령 묶음을 단순 명령으로 쪼갠다. 티켓 6ad5989a.
//
// 등록 감사는 두 곳에서 셸 명령을 읽는다: package.json 스크립트(npm 이 sh -c 로 돌린다)와
// ci.yml step 의 run. 공백으로만 쪼개면 셸이 하지 않는 일을 하게 된다 — 주석으로 막아 둔
// `# npm run build && npm run test:qa:pg` 를 호출로 세고, 따옴표 안의 `;` 에서 명령을 가른다.
// 그러면 CI 에서 돌지 않는 것이 도는 것으로 보인다. 그래서 따옴표와 주석만큼은 셸처럼 읽는다.
//
// 읽는 것: 작은따옴표 · 큰따옴표(\ 이스케이프), 줄 끝의 \ 이어 쓰기, 단어를 여는 # 부터
// 줄 끝까지의 주석, 명령 구분자 && · || · ; · | · & · 줄바꿈(`2>&1` 같은 리다이렉션의 &
// 는 구분자가 아니다). 그 밖의 셸 문법(if/then · 반복 · 서브셸 · 변수 치환)은 낱말로
// 남는다 — 그 낱말을 어떻게 해석할지는 부르는 쪽 몫이다(ci-workflow.mjs 의 shellFlow).

// 반환: [{ words: [...], next }] — next 는 그 명령 뒤에 온 구분자('&&' · '||' · ';' · '|' ·
// '&' · '\n') 이거나, 마지막 명령이면 null 이다. `a || b` 의 a 는 실패해도 b 가 대신 끝을
// 정하고, `a &` 의 a 는 기다리지 않는다 — 호출하는 쪽이 next 로 그것을 가린다.
export function shellCommands(text) {
  const source = String(text ?? '');
  const commands = [];
  let words = [];
  let word = '';
  let inWord = false;
  let quote = null;

  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = (next) => {
    endWord();
    if (words.length > 0) commands.push({ words, next });
    words = [];
  };

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (quote === '"' && c === '\\' && i + 1 < source.length) word += source[++i];
      else word += c;
      continue;
    }
    if (c === '\\' && source[i + 1] === '\n') {
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < source.length) {
      word += source[++i];
      inWord = true;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === '#' && !inWord) {
      while (i + 1 < source.length && source[i + 1] !== '\n') i++;
      continue;
    }
    if (c === '\n' || c === ';') {
      endCommand(c);
      continue;
    }
    // `2>&1` · `&>file` 의 & 는 리다이렉션이지 백그라운드가 아니다.
    if (c === '&' && (/[<>]$/.test(word) || source[i + 1] === '>')) {
      word += c;
      inWord = true;
      continue;
    }
    if (c === '&' || c === '|') {
      const doubled = source[i + 1] === c;
      if (doubled) i++;
      endCommand(doubled ? c + c : c);
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      continue;
    }
    word += c;
    inWord = true;
  }
  endCommand(null);
  return commands;
}
