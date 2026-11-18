package com.parnmanas.awb;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.List;
import java.util.UUID;

/** Device-local bookmarks. Kept separate from Servers so pages cannot acquire AWB credentials. */
public final class WebPages {
  private WebPages() {}

  private static SharedPreferences prefs(Context context) {
    return context.getApplicationContext().getSharedPreferences("awb_web_pages", Context.MODE_PRIVATE);
  }

  public static List<WebPage> list(Context context) {
    return WebPage.decode(prefs(context).getString("pages", "[]"));
  }

  public static WebPage get(Context context, String id) {
    for (WebPage page : list(context)) if (page.id.equals(id)) return page;
    return null;
  }

  public static WebPage selected(Context context) {
    return get(context, prefs(context).getString("selected", ""));
  }

  public static void select(Context context, String id) {
    prefs(context).edit().putString("selected", id == null ? "" : id).apply();
  }

  public static synchronized WebPage save(Context context, String id, String url, String name) {
    String normalized = WebPage.normalizeUrl(url);
    List<WebPage> pages = list(context);
    int index = -1;
    for (int i = 0; i < pages.size(); i++) {
      WebPage page = pages.get(i);
      if (page.id.equals(id)) index = i;
      else if (page.url.equals(normalized)) throw new IllegalArgumentException("이미 목록에 있는 웹 페이지입니다");
    }
    if (id != null && index < 0) throw new IllegalArgumentException("삭제된 웹 페이지입니다");
    WebPage saved = new WebPage(id == null ? UUID.randomUUID().toString() : id, normalized, name);
    if (index < 0) pages.add(saved);
    else pages.set(index, saved);
    prefs(context).edit().putString("pages", WebPage.encode(pages)).apply();
    return saved;
  }

  public static synchronized void remove(Context context, String id) {
    List<WebPage> pages = list(context);
    pages.removeIf(page -> page.id.equals(id));
    SharedPreferences p = prefs(context);
    SharedPreferences.Editor edit = p.edit().putString("pages", WebPage.encode(pages));
    if (id.equals(p.getString("selected", ""))) edit.remove("selected");
    edit.apply();
  }
}
