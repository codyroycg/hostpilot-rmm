package com.hostpilot.rmm;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

import javax.net.ssl.SSLException;

/** First run: ask for the server address and check that it really is a HostPilot server. */
public class SetupActivity extends Activity {
    private EditText address;
    private Button connect;
    private ProgressBar progress;
    private TextView error;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        int pad = dp(28);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(pad, dp(56), pad, pad);

        TextView logo = new TextView(this);
        logo.setText("H");
        logo.setTextColor(Color.WHITE);
        logo.setTypeface(Typeface.DEFAULT_BOLD);
        logo.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
        logo.setGravity(Gravity.CENTER);
        logo.setBackgroundColor(Color.parseColor("#2563EB"));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(64), dp(64));
        lp.bottomMargin = dp(20);
        box.addView(logo, lp);

        TextView title = new TextView(this);
        title.setText("HostPilot RMM");
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        box.addView(title);

        TextView hint = new TextView(this);
        hint.setText("Enter the address you use to open the HostPilot console in a browser.");
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        hint.setPadding(0, dp(8), 0, dp(20));
        box.addView(hint);

        address = new EditText(this);
        address.setHint("https://rmm.example.com");
        address.setSingleLine(true);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setImeOptions(EditorInfo.IME_ACTION_GO);
        address.setText(new Prefs(this).server());
        address.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_GO
                    || (event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER && event.getAction() == KeyEvent.ACTION_DOWN)) {
                tryConnect();
                return true;
            }
            return false;
        });
        box.addView(address);

        error = new TextView(this);
        error.setTextColor(Color.parseColor("#EF4444"));
        error.setPadding(0, dp(8), 0, 0);
        error.setVisibility(View.GONE);
        box.addView(error);

        connect = new Button(this);
        connect.setText("Connect");
        connect.setOnClickListener(v -> tryConnect());
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        bp.topMargin = dp(16);
        box.addView(connect, bp);

        progress = new ProgressBar(this);
        progress.setVisibility(View.GONE);
        box.addView(progress);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(box);
        setContentView(scroll);
    }

    private void tryConnect() {
        String raw = address.getText().toString().trim();
        if (raw.isEmpty()) return;
        List<String> candidates = new ArrayList<>();
        if (raw.matches("(?i)^https?://.*")) {
            candidates.add(origin(raw));
        } else {
            candidates.add(origin("https://" + raw));
            candidates.add(origin("http://" + raw));
        }
        candidates.removeIf(c -> c == null);
        if (candidates.isEmpty()) {
            showError("That doesn't look like a web address.");
            return;
        }
        connect.setEnabled(false);
        progress.setVisibility(View.VISIBLE);
        error.setVisibility(View.GONE);
        Notifier.IO.execute(() -> {
            String problem = null;
            for (String base : candidates) {
                problem = probe(base);
                if (problem == null) {
                    new Prefs(this).setServer(base);
                    runOnUiThread(() -> {
                        startActivity(new Intent(this, MainActivity.class)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
                        finish();
                    });
                    return;
                }
            }
            String msg = problem;
            runOnUiThread(() -> {
                connect.setEnabled(true);
                progress.setVisibility(View.GONE);
                showError(msg);
            });
        });
    }

    /** null when base is a HostPilot server, otherwise a human-readable problem. */
    private static String probe(String base) {
        try {
            Api.call("GET", base + "/api/me", null, null);
            return null; // already signed in
        } catch (Api.HttpError e) {
            if (e.code == 401) return null; // "Not signed in": a HostPilot API answered
            return e.getMessage();
        } catch (SSLException e) {
            return "The server's security certificate isn't trusted by this phone (" + e.getMessage() + ").";
        } catch (IOException e) {
            String m = String.valueOf(e.getMessage());
            return m.startsWith("That address") ? m : "Couldn't reach " + Uri.parse(base).getHost() + ": " + m;
        }
    }

    /** scheme://host[:port] only: the console always lives at the root of the address. */
    private static String origin(String url) {
        Uri u = Uri.parse(url);
        if (u.getScheme() == null || u.getHost() == null || u.getHost().isEmpty()) return null;
        return u.getScheme().toLowerCase() + "://" + u.getEncodedAuthority();
    }

    private void showError(String msg) {
        error.setText(msg);
        error.setVisibility(View.VISIBLE);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
