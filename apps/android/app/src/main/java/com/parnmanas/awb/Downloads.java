package com.parnmanas.awb;

import android.Manifest;
import android.app.DownloadManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 웹 화면이 들고 있는 바이트를 다운로드 폴더에 쓴다(`file.begin` · `file.chunk` · `file.end`).
 *
 * 세션의 이미지 · 영상과 첨부는 인증 헤더로 받아 `blob:` 주소로 그린다. DownloadManager 는 blob: 을 읽지 못하고
 * (WebView 문서 안에만 있는 주소다), 그래서 예전 앱은 "이 파일은 앱에서 내려받을 수 없습니다" 로 끝났다. 웹이
 * 바이트를 조각으로 보내면 여기서 이어 쓴다 — Android 10+ 는 MediaStore 의 Downloads(권한이 필요 없다),
 * 8–9 는 공개 Download 폴더(WRITE_EXTERNAL_STORAGE)에 쓰고 내려받기 목록에 올린다.
 *
 * 끝까지 오지 않은 파일은 남기지 않는다 — 실패 · 취소 · 크기 불일치는 지우고, 10분 넘게 열린 채 버려진 것도 지운다.
 */
final class Downloads {
  /** 한 번에 받는 상한 — 세션 영상(한 편 200MB)보다 넉넉하게, 잘못된 요청이 저장소를 채우지 않게. */
  static final long MAX_BYTES = 512L * 1024 * 1024;
  private static final long STALE_MS = 10 * 60_000L;
  private static final int MAX_NAME = 120;

  private static final class Transfer {
    final String name;
    final String mime;
    final long size;
    final long startedAt = System.currentTimeMillis();
    /** Android 10+ — MediaStore 항목(쓰는 동안 IS_PENDING). */
    final Uri uri;
    /** Android 8–9 — 공개 Download 폴더의 파일. */
    final File file;
    final OutputStream out;
    long written;

    Transfer(String name, String mime, long size, Uri uri, File file, OutputStream out) {
      this.name = name;
      this.mime = mime;
      this.size = size;
      this.uri = uri;
      this.file = file;
      this.out = out;
    }
  }

  private final Map<String, Transfer> open = new ConcurrentHashMap<>();

  /** 8–9 에서 쓰기 권한이 아직 없는가 — 있으면 묻고 다시 누르게 한다. */
  static boolean needsLegacyPermission(Context c) {
    return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
        && c.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED;
  }

  String begin(Context c, String rawName, String rawMime, long size) throws IOException {
    dropStale(c);
    if (size < 0 || size > MAX_BYTES) throw new IOException("bad_size");
    String mime = rawMime == null || rawMime.trim().isEmpty() ? "application/octet-stream" : rawMime.trim();
    String name = safeName(rawName, mime);
    Transfer t;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ContentResolver r = c.getContentResolver();
      ContentValues v = new ContentValues();
      v.put(MediaStore.Downloads.DISPLAY_NAME, name);
      v.put(MediaStore.Downloads.MIME_TYPE, mime);
      v.put(MediaStore.Downloads.IS_PENDING, 1);
      Uri uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
      if (uri == null) throw new IOException("insert_failed");
      OutputStream out;
      try {
        out = r.openOutputStream(uri, "w");
      } catch (IOException | RuntimeException e) {
        r.delete(uri, null, null);
        throw e instanceof IOException ? (IOException) e : new IOException("open_failed", e);
      }
      if (out == null) {
        r.delete(uri, null, null);
        throw new IOException("open_failed");
      }
      t = new Transfer(name, mime, size, uri, null, out);
    } else {
      File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
      if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("no_downloads_dir");
      File file = uniqueFile(dir, name);
      t = new Transfer(file.getName(), mime, size, null, file, new FileOutputStream(file));
    }
    String id = UUID.randomUUID().toString();
    open.put(id, t);
    return id;
  }

  void write(Context c, String id, byte[] chunk) throws IOException {
    Transfer t = open.get(id);
    if (t == null) throw new IOException("unknown_transfer");
    if (t.written + chunk.length > t.size) {
      open.remove(id);
      discard(c, t);
      throw new IOException("size_mismatch");
    }
    t.out.write(chunk);
    t.written += chunk.length;
  }

  /**
   * 끝. `complete` 가 아니면(웹이 도중에 실패 · 취소) 지우고 "" 를 돌려준다. 받은 크기가 처음 말한 크기와 다르면
   * 반쪽 파일이므로 지우고 실패한다. 저장되면 실제 이름(같은 이름이 있으면 MediaStore 가 바꾼 이름)을 돌려준다.
   */
  String end(Context c, String id, boolean complete) throws IOException {
    Transfer t = open.remove(id);
    if (t == null) throw new IOException("unknown_transfer");
    try {
      t.out.close();
    } catch (IOException ignored) {
      // 아래에서 판정한다
    }
    if (!complete) {
      discard(c, t);
      return "";
    }
    if (t.written != t.size) {
      discard(c, t);
      throw new IOException("size_mismatch");
    }
    if (t.uri != null) {
      ContentValues v = new ContentValues();
      v.put(MediaStore.Downloads.IS_PENDING, 0);
      c.getContentResolver().update(t.uri, v, null, null);
      return displayName(c, t.uri, t.name);
    }
    // 8–9: 파일 앱의 Download 와 내려받기 목록에 보이게 올린다.
    DownloadManager dm = (DownloadManager) c.getSystemService(Context.DOWNLOAD_SERVICE);
    if (dm != null) {
      dm.addCompletedDownload(t.file.getName(), t.file.getName(), true, t.mime, t.file.getAbsolutePath(), t.written, true);
    }
    return t.file.getName();
  }

  /** 화면이 닫힌다 — 쓰다 만 것은 남기지 않는다. */
  void abortAll(Context c) {
    for (Iterator<Map.Entry<String, Transfer>> it = open.entrySet().iterator(); it.hasNext(); ) {
      Transfer t = it.next().getValue();
      it.remove();
      discard(c, t);
    }
  }

  private void dropStale(Context c) {
    long now = System.currentTimeMillis();
    for (Iterator<Map.Entry<String, Transfer>> it = open.entrySet().iterator(); it.hasNext(); ) {
      Transfer t = it.next().getValue();
      if (now - t.startedAt < STALE_MS) continue;
      it.remove();
      discard(c, t);
    }
  }

  private static void discard(Context c, Transfer t) {
    try {
      t.out.close();
    } catch (IOException ignored) {
      // 지우는 중이다
    }
    if (t.uri != null) c.getContentResolver().delete(t.uri, null, null);
    else if (t.file != null && !t.file.delete()) t.file.deleteOnExit();
  }

  private static String displayName(Context c, Uri uri, String fallback) {
    try (Cursor cur = c.getContentResolver().query(uri, new String[] { MediaStore.Downloads.DISPLAY_NAME }, null, null, null)) {
      if (cur != null && cur.moveToFirst() && !cur.isNull(0)) return cur.getString(0);
    } catch (RuntimeException ignored) {
      // 이름을 못 읽어도 저장은 끝났다
    }
    return fallback;
  }

  private static File uniqueFile(File dir, String name) {
    File f = new File(dir, name);
    if (!f.exists()) return f;
    int dot = name.lastIndexOf('.');
    String base = dot > 0 ? name.substring(0, dot) : name;
    String ext = dot > 0 ? name.substring(dot) : "";
    for (int i = 1; i < 1000; i++) {
      f = new File(dir, base + " (" + i + ")" + ext);
      if (!f.exists()) return f;
    }
    return new File(dir, base + "-" + System.currentTimeMillis() + ext);
  }

  /**
   * 화면이 준 이름을 파일 이름으로. 경로 · 쿼리를 떼고, 파일 시스템이 거절하는 글자는 `_` 로, 확장자가 없으면
   * mime 에서 붙인다(세션 이미지는 이름이 `image` 로 온다). 비면 `awb-download`.
   */
  static String safeName(String raw, String mime) {
    String s = raw == null ? "" : raw;
    int cut = s.length();
    for (char stop : new char[] { '?', '#' }) {
      int at = s.indexOf(stop);
      if (at >= 0 && at < cut) cut = at;
    }
    s = s.substring(0, cut);
    int slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    if (slash >= 0) s = s.substring(slash + 1);
    StringBuilder b = new StringBuilder();
    for (int i = 0; i < s.length(); i++) {
      char ch = s.charAt(i);
      b.append(ch < 0x20 || ch == 0x7f || ":*?\"<>|/\\".indexOf(ch) >= 0 ? '_' : ch);
    }
    s = b.toString().trim();
    while (s.startsWith(".")) s = s.substring(1);
    while (s.endsWith(".")) s = s.substring(0, s.length() - 1);
    s = s.trim();
    if (s.isEmpty()) s = "awb-download";
    String ext = extensionFor(mime);
    if (s.lastIndexOf('.') <= 0 && !ext.isEmpty()) s = s + ext;
    if (s.length() > MAX_NAME) {
      int dot = s.lastIndexOf('.');
      String tail = dot > 0 && s.length() - dot <= 10 ? s.substring(dot) : "";
      s = s.substring(0, MAX_NAME - tail.length()) + tail;
    }
    return s;
  }

  /** 화면이 쓰는 미디어 mime → 확장자. 모르면 "". */
  static String extensionFor(String mime) {
    String m = mime == null ? "" : mime.trim().toLowerCase(java.util.Locale.ROOT);
    int semi = m.indexOf(';');
    if (semi >= 0) m = m.substring(0, semi).trim();
    switch (m) {
      case "image/png": return ".png";
      case "image/jpeg": return ".jpg";
      case "image/gif": return ".gif";
      case "image/webp": return ".webp";
      case "image/bmp": return ".bmp";
      case "image/avif": return ".avif";
      case "video/mp4": return ".mp4";
      case "video/webm": return ".webm";
      case "video/ogg": return ".ogv";
      case "video/quicktime": return ".mov";
      case "audio/mpeg": return ".mp3";
      case "audio/wav": return ".wav";
      case "audio/webm": return ".weba";
      case "text/html": return ".html";
      case "text/markdown": return ".md";
      case "text/plain": return ".txt";
      case "application/pdf": return ".pdf";
      case "application/json": return ".json";
      case "application/zip": return ".zip";
      default: return "";
    }
  }
}
