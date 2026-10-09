package com.parnmanas.awb;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * AWB 서버 음성 게이트웨이 호출 — 네이티브 백그라운드 wake용 얇은 파이프.
 * 판정 로직은 서버에 있다 (`POST /api/voice/transcribe?purpose=wake` →
 * `POST /api/voice/operators/match`). 네이티브는 마이크·분할·전송만 맡는다.
 *
 * base는 `https://host[:port][/subpath]` 또는 '' — ''이면 쓸 수 없어 호출 쪽에서 막는다
 * (WebView의 same-origin과 달리 네이티브 HTTP에는 상대경로가 없다).
 */
public final class AwbWakeApi {
  private static final int CONNECT_TIMEOUT_MS = 10_000;
  private static final int READ_TIMEOUT_MS = 60_000;

  private AwbWakeApi() {}

  public static final class WakeMatch {
    public boolean matched = false;
    public String operatorId = "";
    public String name = "";
    public String managerId = "";
    public String cli = "";
    public String sessionId = "";
    public String heard = "";
    public String rest = "";
  }

  /** PCM16 mono 바이트 → WAV 바이트 (서버 transcribe가 받는 날것 중 하나). */
  public static byte[] toWav(byte[] pcm16, int sampleRate) {
    int dataLen = pcm16.length;
    byte[] wav = new byte[44 + dataLen];
    // RIFF header
    wav[0] = 'R'; wav[1] = 'I'; wav[2] = 'F'; wav[3] = 'F';
    writeInt(wav, 4, 36 + dataLen);
    wav[8] = 'W'; wav[9] = 'A'; wav[10] = 'V'; wav[11] = 'E';
    wav[12] = 'f'; wav[13] = 'm'; wav[14] = 't'; wav[15] = ' ';
    writeInt(wav, 16, 16);
    writeShort(wav, 20, (short) 1); // PCM
    writeShort(wav, 22, (short) 1); // mono
    writeInt(wav, 24, sampleRate);
    writeInt(wav, 28, sampleRate * 2);
    writeShort(wav, 32, (short) 2); // block align
    writeShort(wav, 34, (short) 16); // bits
    wav[36] = 'd'; wav[37] = 'a'; wav[38] = 't'; wav[39] = 'a';
    writeInt(wav, 40, dataLen);
    System.arraycopy(pcm16, 0, wav, 44, dataLen);
    return wav;
  }

  private static void writeInt(byte[] b, int off, int v) {
    b[off] = (byte) (v & 0xff);
    b[off + 1] = (byte) ((v >> 8) & 0xff);
    b[off + 2] = (byte) ((v >> 16) & 0xff);
    b[off + 3] = (byte) ((v >> 24) & 0xff);
  }

  private static void writeShort(byte[] b, int off, short v) {
    b[off] = (byte) (v & 0xff);
    b[off + 1] = (byte) ((v >> 8) & 0xff);
  }

  /** 발화 WAV → 알아들은 글자. 빈 글자면 "" (말이 아니었다). */
  public static String transcribe(String serverBase, String token, byte[] wav) throws IOException {
    HttpURLConnection conn = open(serverBase + "/api/voice/transcribe?purpose=wake", token);
    conn.setRequestProperty("Content-Type", "audio/wav");
    writeBody(conn, wav);
    int code = conn.getResponseCode();
    if (code == 401) throw new IOException("unauthorized");
    if (code < 200 || code >= 300) throw new IOException("transcribe http " + code);
    try {
      JSONObject json = new JSONObject(readAll(conn.getInputStream()));
      return json.optString("text", "").trim();
    } catch (Exception e) {
      throw new IOException("transcribe parse: " + e.getMessage());
    } finally {
      conn.disconnect();
    }
  }

  /** STT 글자 → 부르는 말이면 operator 주소. 아니면 matched=false. */
  public static WakeMatch wakeMatch(String serverBase, String token, String text) throws IOException {
    HttpURLConnection conn = open(serverBase + "/api/voice/operators/match", token);
    conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
    JSONObject body = new JSONObject();
    try {
      body.put("text", text);
    } catch (Exception e) {
      throw new IOException("match body: " + e.getMessage());
    }
    writeBody(conn, body.toString().getBytes(StandardCharsets.UTF_8));
    int code = conn.getResponseCode();
    if (code == 401) throw new IOException("unauthorized");
    if (code < 200 || code >= 300) throw new IOException("match http " + code);
    WakeMatch out = new WakeMatch();
    try {
      JSONObject json = new JSONObject(readAll(conn.getInputStream()));
      JSONObject op = json.optJSONObject("operator");
      if (op != null) {
        out.matched = true;
        out.operatorId = op.optString("id", "");
        out.name = op.optString("name", "");
        out.managerId = op.optString("manager_id", "");
        out.cli = op.optString("cli", "");
        out.sessionId = op.optString("session_id", "");
        out.heard = json.optString("heard", "");
        out.rest = json.optString("rest", "");
      }
    } catch (Exception e) {
      throw new IOException("match parse: " + e.getMessage());
    } finally {
      conn.disconnect();
    }
    return out;
  }

  private static HttpURLConnection open(String url, String token) throws IOException {
    HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
    conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
    conn.setReadTimeout(READ_TIMEOUT_MS);
    conn.setDoOutput(true);
    conn.setRequestMethod("POST");
    conn.setRequestProperty("Authorization", "Bearer " + token);
    return conn;
  }

  private static void writeBody(HttpURLConnection conn, byte[] bytes) throws IOException {
    conn.setFixedLengthStreamingMode(bytes.length);
    try (OutputStream os = conn.getOutputStream()) {
      os.write(bytes);
    }
  }

  private static String readAll(InputStream in) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buf = new byte[4096];
    int n;
    while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
    try {
      in.close();
    } catch (IOException ignored) {
    }
    return new String(out.toByteArray(), StandardCharsets.UTF_8);
  }
}
