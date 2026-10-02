/**
 * 에이전트가 답에 적은 **로컬 경로 이미지**(`![alt](E:/…/shot.png)`)를 이 장비에서 읽는다.
 *
 * Codex 데스크톱 앱은 응답 마크다운의 이미지 경로를 그 장비의 파일로 읽어 그린다 — 앱이
 * 곧 에이전트가 도는 장비라 가능한 일이다. AWB 화면은 다른 장비에 있으므로, 경로를 들고
 * 매니저에게 바이트를 받아 와야 한다(`local_image` RPC). 바이트는 저장하지 않는다.
 *
 * 읽는 것은 **이미지 파일뿐**이다 — 확장자 화이트리스트와 매직 바이트를 둘 다 통과해야 한다.
 * 이 경로는 "에이전트가 보여 주려고 적은 그림" 을 위한 것이지 임의 파일 읽기 통로가 아니다.
 * SVG 는 받지 않는다: Blob URL 은 앱 origin 을 물려받으므로, 새 탭에서 연 SVG 의 스크립트가
 * AWB origin 으로 돈다.
 */
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 세션 이미지(`MAX_IMAGE_BYTES`)와 같은 상한. 넘으면 이유를 붙여 거절한다. */
export const LOCAL_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']);

export type LocalImageErrorCode = 'invalid_path' | 'not_found' | 'not_image' | 'too_large';

export class LocalImageError extends Error {
  constructor(readonly code: LocalImageErrorCode, message: string) {
    super(message);
  }
}

/** 매직 바이트로 판정한 mime. 이미지가 아니면 null — 확장자만 믿지 않는다. */
export function sniffImageMime(head: Buffer): string | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (head.length >= 2 && head.subarray(0, 2).toString('latin1') === 'BM') return 'image/bmp';
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp' && /^avi[fs]$/.test(head.subarray(8, 12).toString('latin1'))) return 'image/avif';
  return null;
}

/**
 * 마크다운에 적힌 경로를 이 장비의 절대 경로로 바꾼다. 에이전트가 쓰는 모양이 제각각이라
 * (Codex 앱도 이 갈래들에서 버그가 났다 — 드라이브 문자, `/E:/`, 공백, `file://`) 하나씩 받는다.
 * 상대 경로는 세션 cwd 기준이고, cwd 를 모르면 거절한다.
 */
export function resolveLocalImagePath(raw: string, cwd: string, platform: NodeJS.Platform = process.platform): string {
  let p = String(raw ?? '').trim();
  if (!p || p.length > 4096 || p.includes('\0')) throw new LocalImageError('invalid_path', 'Invalid image path.');
  if (/^file:/i.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      throw new LocalImageError('invalid_path', 'Invalid file:// URL.');
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) {
    throw new LocalImageError('invalid_path', 'Only local paths can be read from the Runtime Host.');
  }
  // `/E:/foo` — URL 경로 모양으로 적힌 Windows 드라이브 경로.
  if (platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = homedir() + p.slice(1);
  if (isAbsolute(p)) return resolve(p);
  if (!cwd) throw new LocalImageError('invalid_path', 'Relative image path but the session working directory is unknown.');
  return resolve(cwd, p);
}

function extensionOf(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m ? m[1].toLowerCase() : '';
}

/**
 * 경로의 이미지를 읽는다. 적힌 그대로 없고 `%xx` 가 섞여 있으면 퍼센트 디코딩한 경로로 한 번 더
 * 찾는다 — 공백을 `%20` 으로 적는 에이전트가 많다.
 */
export async function readLocalImage(raw: string, cwd: string): Promise<{ path: string; mimeType: string; bytes: Buffer }> {
  const candidates = [resolveLocalImagePath(raw, cwd)];
  if (/%[0-9A-Fa-f]{2}/.test(raw)) {
    try {
      candidates.push(resolveLocalImagePath(decodeURIComponent(raw), cwd));
    } catch {
      // 디코딩이 안 되는 `%` 는 그냥 글자다.
    }
  }
  let path = '';
  let size = 0;
  for (const candidate of candidates) {
    const st = await stat(candidate).catch(() => null);
    if (st?.isFile()) {
      path = candidate;
      size = st.size;
      break;
    }
  }
  if (!path) throw new LocalImageError('not_found', `No such file on the Runtime Host: ${candidates[0]}`);
  if (!IMAGE_EXTENSIONS.has(extensionOf(path))) {
    throw new LocalImageError('not_image', `Not an image file (${[...IMAGE_EXTENSIONS].join(', ')} only): ${path}`);
  }
  if (size === 0) throw new LocalImageError('not_image', `Empty file: ${path}`);
  if (size > LOCAL_IMAGE_MAX_BYTES) {
    throw new LocalImageError('too_large', `Image is ${Math.round(size / 1024)}KB — over the ${Math.round(LOCAL_IMAGE_MAX_BYTES / 1024)}KB cap.`);
  }
  const handle = await open(path, 'r');
  try {
    const bytes = await handle.readFile();
    if (bytes.length > LOCAL_IMAGE_MAX_BYTES) throw new LocalImageError('too_large', `Image grew past the cap while reading: ${path}`);
    const mimeType = sniffImageMime(bytes.subarray(0, 16));
    if (!mimeType) throw new LocalImageError('not_image', `File content is not a recognised image: ${path}`);
    return { path, mimeType, bytes };
  } finally {
    await handle.close();
  }
}
