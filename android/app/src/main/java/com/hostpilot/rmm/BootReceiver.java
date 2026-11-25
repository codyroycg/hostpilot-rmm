package com.hostpilot.rmm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restarts instant notifications after a reboot (the periodic job is persisted by Android itself). */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        Prefs p = new Prefs(c);
        if (!p.token().isEmpty() && p.instant()) LiveService.start(c);
    }
}
