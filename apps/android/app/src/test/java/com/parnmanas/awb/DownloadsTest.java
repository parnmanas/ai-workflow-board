package com.parnmanas.awb;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 화면이 준 이름 → 다운로드 폴더의 파일 이름. 세션 이미지는 이름이 `image` 로, 영상은 경로 · URL 그대로 온다 —
 * 확장자가 없으면 파일 앱이 열 앱을 못 고르고, 경로 글자가 남으면 쓰기가 실패한다.
 */
public class DownloadsTest {
  @Test
  public void keepsTheLastPathSegmentAndDropsQueryAndFragment() {
    assertEquals("bohol-dive-4.mp4", Downloads.safeName("https://dive.example.com/preview/bohol-dive-4.mp4?sig=1#t=1", "video/mp4"));
    assertEquals("town_forge.png", Downloads.safeName("E:\\Repository\\shots\\town_forge.png", "image/png"));
    assertEquals("demo.mp4", Downloads.safeName("./out/demo.mp4", "video/mp4"));
  }

  @Test
  public void addsTheExtensionFromMimeWhenTheNameHasNone() {
    assertEquals("image.png", Downloads.safeName("image", "image/png"));
    assertEquals("video.webm", Downloads.safeName("video", "video/webm"));
    assertEquals("photo.jpg", Downloads.safeName("photo", "image/jpeg; charset=binary"));
    // 이미 확장자가 있으면 그대로 — mime 이 달라도 바꾸지 않는다.
    assertEquals("report.html", Downloads.safeName("report.html", "application/octet-stream"));
    // 모르는 mime 이면 붙이지 않는다.
    assertEquals("blob", Downloads.safeName("blob", "application/x-unknown"));
  }

  @Test
  public void replacesCharactersFileSystemsRejectAndNeverReturnsEmpty() {
    assertEquals("a_b_c_d_e_f_.png", Downloads.safeName("a:b*c|d<e>f\".png", "image/png"));
    // 이름은 경로 · URL 에서 온다 — `?` 부터는 쿼리다.
    assertEquals("clip.mp4", Downloads.safeName("clip.mp4?download=1", "video/mp4"));
    assertEquals("tab_name.png", Downloads.safeName("tab\tname.png", "image/png"));
    assertEquals("awb-download.png", Downloads.safeName("", "image/png"));
    assertEquals("awb-download", Downloads.safeName(null, null));
    assertEquals("awb-download.png", Downloads.safeName("...", "image/png"));
    assertEquals("hidden.png", Downloads.safeName(".hidden.png", "image/png"));
  }

  @Test
  public void capsTheLengthButKeepsTheExtension() {
    StringBuilder b = new StringBuilder();
    for (int i = 0; i < 300; i++) b.append('가');
    String name = Downloads.safeName(b + ".mp4", "video/mp4");
    assertTrue(name.length() <= 120);
    assertTrue(name.endsWith(".mp4"));
  }

  @Test
  public void knowsTheSessionMediaTypes() {
    assertEquals(".png", Downloads.extensionFor("image/png"));
    assertEquals(".mp4", Downloads.extensionFor("VIDEO/MP4"));
    assertEquals(".webm", Downloads.extensionFor("video/webm"));
    assertEquals(".md", Downloads.extensionFor("text/markdown"));
    assertEquals("", Downloads.extensionFor(null));
  }
}
