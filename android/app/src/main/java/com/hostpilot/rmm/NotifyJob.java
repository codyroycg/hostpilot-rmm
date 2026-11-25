package com.hostpilot.rmm;

import android.app.job.JobParameters;
import android.app.job.JobService;

/** Periodic background check (about every 15 minutes; Android may stretch this while the phone sleeps). */
public class NotifyJob extends JobService {
    @Override
    public boolean onStartJob(JobParameters params) {
        Notifier.IO.execute(() -> {
            try {
                Notifier.check(getApplicationContext());
            } finally {
                jobFinished(params, false);
            }
        });
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }
}
