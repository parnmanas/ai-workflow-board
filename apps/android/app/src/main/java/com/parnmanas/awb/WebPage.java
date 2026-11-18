package com.parnmanas.awb;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** A saved web page is a bookmark, never an AWB server or a source of native credentials. */
public final class WebPage {
  public final String id;
  public final String url;
  public final String name;

  WebPage(String id, String url, String name) {
    this.id = id;
    this.url = url;
    this.name = name == null ? "" : name.trim();
  }

  public String label() {
    return name.isEmpty() ? ServerUrls.hostLabel(url) : name;
  }

  /** Dashboard paths, trailing slashes, query filters and hash routes must survive unchanged. */
  public static String normalizeUrl(String raw) {
    String value = raw == null ? "" : raw.trim();
    if (value.isEmpty()) throw new IllegalArgumentException("웹 페이지 URL을 입력해 주세요");
    if (!value.contains("://")) {
      // Host:port is useful for local dashboards; executable and non-web schemes are not.
      if (value.matches("(?i)^[a-z][a-z0-9+.-]*:.*") && !value.matches("^[^/:?#]+:[0-9]+([/?#].*)?$")) {
        throw new IllegalArgumentException("http 또는 https 주소를 입력해 주세요");
      }
      value = "https://" + value;
    }
    try {
      URI uri = new URI(value);
      String origin = ServerUrls.originOf(value);
      if (origin.isEmpty() || uri.getRawAuthority() == null || uri.getRawAuthority().contains("@")
          || uri.getRawAuthority().contains("%") || uri.getRawAuthority().endsWith(":")
          || uri.getRawAuthority().matches(".*:-[0-9]+$")) throw new URISyntaxException(value, "invalid origin");
      return origin + (uri.getRawPath() == null ? "" : uri.getRawPath())
          + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery())
          + (uri.getRawFragment() == null ? "" : "#" + uri.getRawFragment());
    } catch (URISyntaxException e) {
      throw new IllegalArgumentException("주소가 올바르지 않습니다. 예: https://dashboard.example.com/view");
    }
  }

  static List<WebPage> decode(String saved) {
    List<WebPage> pages = new ArrayList<>();
    Set<String> ids = new HashSet<>();
    Set<String> urls = new HashSet<>();
    try {
      JSONArray entries = new JSONArray(saved);
      for (int i = 0; i < entries.length(); i++) {
        JSONObject entry = entries.optJSONObject(i);
        if (entry == null) continue;
        try {
          String id = entry.getString("id");
          String url = normalizeUrl(entry.getString("url"));
          if (id.isEmpty() || ids.contains(id) || urls.contains(url)) continue;
          ids.add(id);
          urls.add(url);
          pages.add(new WebPage(id, url, entry.optString("name", "")));
        } catch (JSONException | IllegalArgumentException ignored) {
          // One malformed bookmark must not hide the rest of the user's list.
        }
      }
    } catch (JSONException ignored) {
    }
    return pages;
  }

  static String encode(List<WebPage> pages) {
    JSONArray entries = new JSONArray();
    for (WebPage page : pages) {
      try {
        entries.put(new JSONObject().put("id", page.id).put("url", page.url).put("name", page.name));
      } catch (JSONException e) {
        throw new IllegalStateException(e);
      }
    }
    return entries.toString();
  }
}
