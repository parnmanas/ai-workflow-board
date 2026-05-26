// Shared helpers for chat-room attachment upload + render.

// Match server-side MAX_ATTACHMENT_SIZE (10 MB). The server is still the
// authority — we duplicate the cap here only to fail fast before reading the
// file into memory + base64 (the base64 inflate would otherwise OOM the tab
// on a careless drop of a multi-GB file).
export const MAX_CHAT_ATTACHMENT_SIZE = 10 * 1024 * 1024;
// Mirrors server cap (MAX_ATTACHMENTS_PER_OWNER + the messaging-service hard
// limit of 20 per send). Sending more than this would 400 server-side anyway.
export const MAX_CHAT_ATTACHMENTS_PER_MESSAGE = 20;

export function isImageMime(mime: string | undefined | null): boolean {
  return !!mime && /^image\//i.test(mime);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Read a File into a base64 string (no data: prefix). Used by both the
// paperclip picker and the drag/drop & paste paths so the server upload
// payload format stays uniform.
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64 || '');
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

// Convert a base64 string into a Blob with the given mimetype — used to
// trigger a browser save for non-image attachments. Falls back to
// application/octet-stream when mime is missing.
export function base64ToBlob(base64: string, mime: string): Blob {
  const bin = atob(base64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}

// Trigger a save-as for a Blob via a transient <a download> click. The object
// URL is revoked on the next tick so the browser still has time to start the
// download (revoking synchronously breaks Safari).
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}
