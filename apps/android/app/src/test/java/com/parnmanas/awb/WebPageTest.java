package com.parnmanas.awb;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public class WebPageTest {
  @Test public void preservesDashboardRoutesAndFilters() {
    assertEquals("https://dashboard.example/d/team/?orgId=2&var=a+b#panel-3",
        WebPage.normalizeUrl(" HTTPS://Dashboard.Example:443/d/team/?orgId=2&var=a+b#panel-3 "));
    assertEquals("https://dashboard.example/#/reports?from=now-1h",
        WebPage.normalizeUrl("dashboard.example/#/reports?from=now-1h"));
    assertEquals("http://localhost:3000/view/?q=%EC%84%9C%EC%9A%B8&empty=#/x",
        WebPage.normalizeUrl("http://localhost:3000/view/?q=%EC%84%9C%EC%9A%B8&empty=#/x"));
    assertEquals("https://localhost:3000/view", WebPage.normalizeUrl("localhost:3000/view"));
    assertEquals("http://[::1]:3000/", WebPage.normalizeUrl("http://[::1]:3000/"));
    assertEquals("https://xn--3e0b707e.example/", WebPage.normalizeUrl("https://한국.example/"));
  }

  @Test public void onlyAcceptsWebAddressesWithoutEmbeddedCredentials() {
    for (String value : Arrays.asList("", " ", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd",
        "content://x", "intent://x", "awb://sessions/1", "ftp://x", "https://", "https://a b/",
        "https://user:password@example.com/", "https://user%40password@example.com/", "https://example.com:0/",
        "https://example.com:99999/", "https://example.com:-1/", "https://example.com:abc/", "https://example.com:/",
        "https://user%40example.com/", "https://x/\npath")) {
      assertThrows(value, IllegalArgumentException.class, () -> WebPage.normalizeUrl(value));
    }
  }

  @Test public void listRoundTripsNamesAndFullUrlsInOrder() {
    List<WebPage> pages = Arrays.asList(new WebPage("a", "https://dashboard.example/#/one", "운영 \"현황\""),
        new WebPage("b", "https://dashboard.example/?orgId=2", ""));
    List<WebPage> restored = WebPage.decode(WebPage.encode(pages));
    assertEquals(2, restored.size());
    assertEquals("a", restored.get(0).id);
    assertEquals(pages.get(0).url, restored.get(0).url);
    assertEquals(pages.get(0).name, restored.get(0).name);
    assertEquals("dashboard.example", restored.get(1).label());
    assertEquals(pages.get(1).url, restored.get(1).url);
  }

  @Test public void invalidEntriesDoNotHideValidBookmarksOrDuplicateThem() {
    List<WebPage> restored = WebPage.decode("[null,{\"id\":\"a\",\"url\":\"javascript:alert(1)\"},"
        + "{\"id\":\"a\",\"url\":\"https://example.com/a\"},"
        + "{\"id\":\"a\",\"url\":\"https://example.com/b\"},"
        + "{\"id\":\"b\",\"url\":\"https://EXAMPLE.com:443/a\"},"
        + "{\"id\":\"c\",\"url\":\"https://example.com/c\"}]");
    assertEquals(2, restored.size());
    assertEquals("a", restored.get(0).id);
    assertEquals("c", restored.get(1).id);
    assertTrue(WebPage.decode("not json").isEmpty());
  }
}
