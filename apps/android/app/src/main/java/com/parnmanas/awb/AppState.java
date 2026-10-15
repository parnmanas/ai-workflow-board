package com.parnmanas.awb;

import java.util.concurrent.CopyOnWriteArrayList;

/**
 * 앱 화면이 지금 보이는가 — 마이크와 소리를 누가 맡는지 이것 하나로 가른다.
 *
 * 보일 때: WebView(웹 화면)가 음성 지원 · 대화 모드 · 알림 낭독을 그대로 한다. 서비스는 마이크를 놓는다.
 * 안 보일 때(다른 앱 · 화면 꺼짐 · 잠금): 서비스가 듣고, 대화하고, 읽는다. 웹은 숨은 동안 손을 뗀다.
 * 한 단말에서 둘이 같이 들으면 같은 부름에 두 번 깨어나고, 같은 답을 두 번 읽는다.
 */
public final class AppState {
  public interface Listener {
    void onForegroundChanged(boolean foreground);
  }

  private static volatile boolean foreground = false;
  private static final CopyOnWriteArrayList<Listener> LISTENERS = new CopyOnWriteArrayList<>();

  private AppState() {}

  public static boolean isForeground() {
    return foreground;
  }

  static void setForeground(boolean value) {
    if (foreground == value) return;
    foreground = value;
    for (Listener l : LISTENERS) l.onForegroundChanged(value);
  }

  public static void addListener(Listener l) {
    LISTENERS.addIfAbsent(l);
  }

  public static void removeListener(Listener l) {
    LISTENERS.remove(l);
  }
}
