package com.hostpilot.rmm;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/** Minimal JSON-over-HTTP client for the HostPilot API. Call it off the main thread. */
final class Api {
    private Api() {}

    static final class HttpError extends IOException {
        final int code;

        HttpError(int code, String message) {
            super(message);
            this.code = code;
        }
    }

    static JSONObject call(String method, String url, Map<String, String> headers, String jsonBody) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestMethod(method);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("X-HostPilot", "1");
            c.setRequestProperty("User-Agent", "HostPilotApp/" + BuildConfig.VERSION_NAME);
            if (headers != null) {
                for (Map.Entry<String, String> h : headers.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
            }
            if (jsonBody != null) {
                byte[] body = jsonBody.getBytes(StandardCharsets.UTF_8);
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                c.setFixedLengthStreamingMode(body.length);
                try (OutputStream out = c.getOutputStream()) {
                    out.write(body);
                }
            }
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String text = in == null ? "" : readAll(in);
            JSONObject j;
            try {
                j = text.isEmpty() ? new JSONObject() : new JSONObject(text);
            } catch (JSONException e) {
                // not an HttpError: a proxy's HTML 401 page must not look like HostPilot's "Not signed in"
                throw new IOException("That address answered, but it isn't a HostPilot server (HTTP " + code + ").");
            }
            if (code >= 400) throw new HttpError(code, j.optString("error", "HTTP " + code));
            return j;
        } finally {
            c.disconnect();
        }
    }

    private static String readAll(InputStream in) throws IOException {
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = s.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > 4 * 1024 * 1024) throw new IOException("Response too large");
            }
            return out.toString("UTF-8");
        }
    }
}
