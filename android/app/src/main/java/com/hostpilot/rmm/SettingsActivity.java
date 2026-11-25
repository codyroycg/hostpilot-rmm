package com.hostpilot.rmm;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.MenuItem;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;
import android.webkit.CookieManager;
import android.webkit.WebStorage;

/** Notification options, test / check buttons and "Change server". */
public class SettingsActivity extends Activity {
    private Prefs prefs;
    private LinearLayout box;
    private TextView status;
    private Button allow;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = new Prefs(this);
        if (getActionBar() != null) getActionBar().setDisplayHomeAsUpEnabled(true);

        box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        box.setPadding(pad, pad, pad, pad);

        heading("Server");
        TextView srv = text(prefs.server());
        srv.setTextIsSelectable(true);
        status = text("");
        box.addView(srv);
        box.addView(status);

        allow = button("Allow notifications", v -> startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())));

        heading("Notifications");
        toggle("New alerts", "Disk space, offline devices, failed services and other alerts", prefs.notifyAlerts(),
                prefs::setNotifyAlerts);
        toggle("Chat messages", "When an end user writes to IT support from the tray icon", prefs.notifyChat(),
                prefs::setNotifyChat);
        toggle("Instant notifications", "Check every minute and keep a small notification in the status bar. "
                        + "When off, the phone checks about every 15 minutes (longer while it sleeps).",
                prefs.instant(), v -> {
                    prefs.setInstant(v);
                    if (v) LiveService.start(this);
                    else LiveService.stop(this);
                });

        button("Send a test notification", v -> {
            if (!Notifier.canNotify(this)) {
                Toast.makeText(this, "Notifications are turned off for HostPilot", Toast.LENGTH_LONG).show();
                return;
            }
            Notifier.ensureChannels(this);
            Notifier.test(this);
        });
        button("Check for new alerts now", v -> Notifier.IO.execute(() -> {
            int n = Notifier.check(getApplicationContext());
            runOnUiThread(() -> {
                Toast.makeText(this, n == 0 ? "Nothing new" : n + " new notification(s)", Toast.LENGTH_SHORT).show();
                refresh();
            });
        }));

        heading("Connection");
        button("Change server", v -> new AlertDialog.Builder(this)
                .setTitle("Change server?")
                .setMessage("This signs the app out and stops notifications from " + prefs.server() + ".")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Change server", (d, w) -> changeServer())
                .show());

        TextView ver = text("HostPilot for Android " + BuildConfig.VERSION_NAME);
        ver.setPadding(0, dp(24), 0, 0);
        box.addView(ver);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(box);
        setContentView(scroll);
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
    }

    private void refresh() {
        String user = prefs.user();
        boolean registered = !prefs.token().isEmpty();
        boolean can = Notifier.canNotify(this);
        status.setText(registered ? "Signed in as " + user + (can ? " · notifications on" : " · notifications are blocked")
                : "Sign in to the console in the app to get notifications.");
        allow.setVisibility(can ? View.GONE : View.VISIBLE);
    }

    private void changeServer() {
        Notifier.IO.execute(() -> {
            Notifier.unregister(getApplicationContext());
            runOnUiThread(() -> {
                CookieManager.getInstance().removeAllCookies(null);
                CookieManager.getInstance().flush();
                WebStorage.getInstance().deleteAllData();
                prefs.setServer("");
                startActivity(new Intent(this, SetupActivity.class)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
                finish();
            });
        });
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == android.R.id.home) {
            finish();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    // ---------- tiny view helpers ----------

    interface BoolSetter { void set(boolean v); }

    private void heading(String s) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        t.setAllCaps(true);
        t.setPadding(0, dp(22), 0, dp(6));
        box.addView(t);
    }

    private TextView text(String s) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        t.setPadding(0, dp(2), 0, dp(2));
        return t;
    }

    private void toggle(String label, String detail, boolean on, BoolSetter setter) {
        Switch sw = new Switch(this);
        sw.setText(label);
        sw.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        sw.setChecked(on);
        sw.setPadding(0, dp(10), 0, 0);
        sw.setOnCheckedChangeListener((b, v) -> setter.set(v));
        box.addView(sw);
        TextView d = text(detail);
        d.setAlpha(0.7f);
        d.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        box.addView(d);
    }

    private Button button(String label, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(8);
        box.addView(b, lp);
        return b;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
