package com.parnmanas.awb;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/** 동기 HTTP — 네이티브 쪽 서버 호출은 전부 이것 하나로 한다(UI 스레드에서 부르지 말 것). */
public final class Http {
  public static final int CONNECT_TIMEOUT_MS = 10_000;
  public static final int READ_TIMEOUT_MS = 60_000;

  private Http() {}

  public static final class Response {
    public final int code;
    public final byte[] body;
    public final String contentType;

    Response(int code, byte[] body, String contentType) {
      this.code = code;
      this.body = body;
      this.contentType = contentType == null ? "" : contentType;
    }

    public boolean ok() {
      return code >= 200 && code < 300;
    }

    public String text() {
      return new String(body, StandardCharsets.UTF_8);
    }

    public JSONObject json() throws IOException {
      try {
        return new JSONObject(text());
      } catch (JSONException e) {
        throw new IOException("bad json (HTTP " + code + ")");
      }
    }

    /** 서버 오류 본문의 `error`/`message` — 사람에게 보일 한 줄. */
    public String errorText() {
      try {
        JSONObject j = new JSONObject(text());
        String msg = j.optString("message", "");
        if (!msg.isEmpty()) return msg;
        String err = j.optString("error", "");
        if (!err.isEmpty()) return err;
      } catch (JSONException ignored) {
      }
      return "HTTP " + code;
    }
  }

  public static Response request(
      String method, String url, Map<String, String> headers, byte[] body, String contentType, int readTimeoutMs)
      throws IOException {
    HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
    try {
      conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
      conn.setReadTimeout(readTimeoutMs);
      conn.setRequestMethod(method);
      conn.setInstanceFollowRedirects(false);
      if (headers != null) {
        for (Map.Entry<String, String> h : headers.entrySet()) {
          if (h.getValue() != null && !h.getValue().isEmpty()) conn.setRequestProperty(h.getKey(), h.getValue());
        }
      }
      if (body != null) {
        conn.setDoOutput(true);
        if (contentType != null) conn.setRequestProperty("Content-Type", contentType);
        conn.setFixedLengthStreamingMode(body.length);
        try (OutputStream os = conn.getOutputStream()) {
          os.write(body);
        }
      }
      int code = conn.getResponseCode();
      InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
      byte[] bytes = in == null ? new byte[0] : readAll(in);
      return new Response(code, bytes, conn.getContentType());
    } finally {
      conn.disconnect();
    }
  }

  public static Response getJson(String url, Map<String, String> headers) throws IOException {
    return request("GET", url, headers, null, null, READ_TIMEOUT_MS);
  }

  public static Response postJson(String url, Map<String, String> headers, JSONObject body) throws IOException {
    return request("POST", url, headers, body.toString().getBytes(StandardCharsets.UTF_8),
        "application/json; charset=utf-8", READ_TIMEOUT_MS);
  }

  public static Response putJson(String url, Map<String, String> headers, JSONObject body) throws IOException {
    return request("PUT", url, headers, body.toString().getBytes(StandardCharsets.UTF_8),
        "application/json; charset=utf-8", READ_TIMEOUT_MS);
  }

  public static byte[] readAll(InputStream in) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buf = new byte[8192];
    int n;
    try {
      while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
    } finally {
      try {
        in.close();
      } catch (IOException ignored) {
      }
    }
    return out.toByteArray();
  }

  /** 같은 키를 두 번 쓰지 않는 작은 JSON 빌더 — org.json 의 checked 예외를 감춘다. */
  public static JSONObject obj(Object... kv) {
    JSONObject o = new JSONObject();
    try {
      for (int i = 0; i + 1 < kv.length; i += 2) o.put((String) kv[i], kv[i + 1]);
    } catch (JSONException e) {
      throw new IllegalArgumentException(e);
    }
    return o;
  }
}
