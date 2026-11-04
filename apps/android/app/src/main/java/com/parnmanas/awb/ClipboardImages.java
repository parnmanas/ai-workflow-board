package com.parnmanas.awb;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.net.Uri;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * 이미지 한 장을 클립보드에 둔다(`clipboard.image`) — 메신저 · 메모 같은 다른 앱에 붙여 넣을 수 있게.
 *
 * Android 클립보드의 이미지는 바이트가 아니라 content URI 다. 앱 캐시(`clipboard/`)에 써 두고 FileProvider 로
 * 내보내며, 붙여 넣는 앱에는 시스템이 그 URI 의 읽기 권한을 준다. WebView 의 async Clipboard API 는 이미지를
 * 쓰지 못하므로 웹이 바이트를 넘긴다. 한 번에 한 장만 둔다 — 새로 복사하면 이전 파일을 지운다.
 */
final class ClipboardImages {
  static final int MAX_BYTES = 20 * 1024 * 1024;
  static final String DIR = "clipboard";

  private ClipboardImages() {}

  static void copy(Context c, byte[] data, String mime) throws IOException {
    String type = mime == null ? "" : mime.trim().toLowerCase(java.util.Locale.ROOT);
    if (!type.startsWith("image/") || type.startsWith("image/svg")) throw new IOException("not_image");
    if (data.length == 0 || data.length > MAX_BYTES) throw new IOException("bad_size");
    File dir = new File(c.getCacheDir(), DIR);
    if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("no_cache_dir");
    File[] old = dir.listFiles();
    if (old != null) {
      for (File f : old) {
        if (!f.delete()) f.deleteOnExit();
      }
    }
    String ext = Downloads.extensionFor(type);
    File file = new File(dir, "awb-image-" + System.currentTimeMillis() + (ext.isEmpty() ? ".img" : ext));
    try (FileOutputStream out = new FileOutputStream(file)) {
      out.write(data);
    }
    Uri uri = FileProvider.getUriForFile(c, c.getPackageName() + ".files", file);
    ClipboardManager cm = (ClipboardManager) c.getSystemService(Context.CLIPBOARD_SERVICE);
    if (cm == null) throw new IOException("no_clipboard");
    cm.setPrimaryClip(ClipData.newUri(c.getContentResolver(), "AWB image", uri));
  }
}
