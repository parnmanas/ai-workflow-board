/**
 * multipart 업로드용 파일 이름. 공급자 일부는 Content-Type 보다 확장자로 형식을 판정하므로
 * 녹음 형식에 맞는 확장자를 붙인다.
 */
export function audioFileName(mimeType: string): string {
  const base = (mimeType || '').split(';')[0].trim().toLowerCase();
  const ext: Record<string, string> = {
    'audio/webm': 'webm',
    'video/webm': 'webm',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/flac': 'flac',
  };
  return `utterance.${ext[base] ?? 'webm'}`;
}

export function audioBlob(audio: Buffer, mimeType: string): Blob {
  return new Blob([new Uint8Array(audio)], { type: (mimeType || 'application/octet-stream').split(';')[0].trim() });
}

/** 여러 언어가 설정돼 있으면 공급자가 판정하게 둔다 — 하나로 강제하면 섞어 쓴 영어 용어를 한글로 옮겨 적는다. */
export function singleLanguage(languages: string[]): string | null {
  return languages.length === 1 ? languages[0] : null;
}
