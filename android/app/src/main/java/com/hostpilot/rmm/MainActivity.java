package com.hostpilot.rmm;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/** The HostPilot console in a WebView, plus native downloads, uploads and notifications. */
public class MainActivity extends Activity {
    static final String EXTRA_PATH = "path";
    private static final int REQ_FILE = 1;
    private static final int REQ_NOTIFY = 2;
    private static final int REQ_STORAGE = 3;

    private Prefs prefs;
    private String server;
    private WebView web;
    private View errorView;
    private TextView errorText;
    private boolean loadFailed;
    private ValueCallback<Uri[]> fileCallback;
    private Runnable pendingDownload;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = new Prefs(this);
        server = prefs.server();
        if (server.isEmpty()) {
            startActivity(new Intent(this, SetupActivity.class));
            finish();
            return;
        }
        Notifier.ensureChannels(this);
        getWindow().setNavigationBarColor(Color.parseColor("#0F1419"));

        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        errorView = buildErrorView();
        errorView.setVisibility(View.GONE);
        root.addView(errorView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        configureWebView();
        if (state == null || web.restoreState(state) == null) web.loadUrl(urlFor(getIntent()));
        Notifier.IO.execute(() -> Notifier.schedule(getApplicationContext()));
    }

    private String urlFor(Intent intent) {
        String path = intent == null ? null : intent.getStringExtra(EXTRA_PATH);
        return server + "/" + (path != null && path.startsWith("#/") ? path : "");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String path = intent.getStringExtra(EXTRA_PATH);
        if (web != null && path != null && path.startsWith("#/")) web.loadUrl(urlFor(intent));
    }

    private void configureWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setSupportMultipleWindows(false); // target=_blank (remote control, terminal) opens in this view; Back returns
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);
        s.setUserAgentString(s.getUserAgentString() + " HostPilotApp/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);

        web.addJavascriptInterface(new Bridge(), "HostPilotApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openOutside(request.getUrl());
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                loadFailed = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                if (!loadFailed) errorView.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                showError("Can't reach " + Uri.parse(server).getHost() + ".\n\n" + error.getDescription());
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                showError("The server's security certificate isn't trusted by this phone, so the app won't connect.\n\n"
                        + "Use a publicly trusted certificate (Caddy gets one automatically for a public domain), "
                        + "or install your own certificate authority on the phone.");
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent i = params.createIntent();
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(i, REQ_FILE);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> {
            Runnable go = () -> download(url, userAgent, contentDisposition, mimeType);
            if (Build.VERSION.SDK_INT < 29
                    && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                pendingDownload = go;
                requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
            } else {
                go.run();
            }
        });
    }

    /** Links to other sites (e.g. a device's own web interface) open in the phone's browser. */
    private boolean openOutside(Uri u) {
        String scheme = u.getScheme();
        String host = Uri.parse(server).getHost();
        if (("http".equals(scheme) || "https".equals(scheme)) && host != null && host.equalsIgnoreCase(u.getHost())) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private void download(String url, String userAgent, String contentDisposition, String mimeType) {
        try {
            String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) req.addRequestHeader("Cookie", cookie);
            req.addRequestHeader("User-Agent", userAgent);
            req.setTitle(name);
            if (mimeType != null && !mimeType.isEmpty()) req.setMimeType(mimeType);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            getSystemService(DownloadManager.class).enqueue(req);
            Toast.makeText(this, "Downloading " + name + " to Downloads", Toast.LENGTH_SHORT).show();
        } catch (RuntimeException e) {
            Toast.makeText(this, "Download failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    // ---------- error screen ----------

    private View buildErrorView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        int pad = dp(28);
        box.setPadding(pad, pad, pad, pad);
        box.setBackgroundColor(Color.parseColor("#0F1419"));
        box.setClickable(true);

        TextView title = new TextView(this);
        title.setText("Can't connect");
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        box.addView(title);

        errorText = new TextView(this);
        errorText.setTextColor(Color.parseColor("#8B98A8"));
        errorText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        errorText.setGravity(Gravity.CENTER);
        errorText.setPadding(0, dp(12), 0, dp(20));
        box.addView(errorText);

        Button retry = new Button(this);
        retry.setText("Try again");
        retry.setOnClickListener(v -> {
            loadFailed = false;
            errorView.setVisibility(View.GONE);
            String url = web.getUrl();
            web.loadUrl(url == null || url.startsWith("data:") || url.startsWith("about:") ? server + "/" : url);
        });
        box.addView(retry);

        Button settings = new Button(this);
        settings.setText("Change server");
        settings.setOnClickListener(v -> startActivity(new Intent(this, SettingsActivity.class)));
        box.addView(settings);
        return box;
    }

    private void showError(String message) {
        loadFailed = true;
        errorText.setText(message);
        errorView.setVisibility(View.VISIBLE);
    }

    // ---------- JavaScript bridge (window.HostPilotApp in the console) ----------

    private final class Bridge {
        @JavascriptInterface
        public void signedIn(String username) {
            Notifier.IO.execute(() -> {
                try {
                    Notifier.register(getApplicationContext(), username);
                    runOnUiThread(MainActivity.this::askNotificationPermission);
                } catch (Exception e) {
                    Log.w("HostPilot", "register failed: " + e.getMessage());
                }
            });
        }

        @JavascriptInterface
        public void signedOut() {
            Notifier.IO.execute(() -> Notifier.unregister(getApplicationContext()));
        }

        @JavascriptInterface
        public void openSettings() {
            runOnUiThread(() -> startActivity(new Intent(MainActivity.this, SettingsActivity.class)));
        }

        @JavascriptInterface
        public String version() {
            return BuildConfig.VERSION_NAME;
        }
    }

    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33 || prefs.askedNotifications()) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        prefs.setAskedNotifications();
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
    }

    // ---------- activity plumbing ----------

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode == REQ_STORAGE) {
            Runnable go = pendingDownload;
            pendingDownload = null;
            if (go != null && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) go.run();
            else if (go != null) Toast.makeText(this, "Storage permission is needed to save downloads", Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQ_FILE || fileCallback == null) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                result = new Uri[clip.getItemCount()];
                for (int i = 0; i < result.length; i++) result[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web != null && errorView.getVisibility() != View.VISIBLE && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web == null) return;
        web.onResume();
        String now = prefs.server();
        if (!now.equals(server)) { // server changed in settings
            recreate();
        }
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("HostPilotApp");
            web.destroy();
        }
        super.onDestroy();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
