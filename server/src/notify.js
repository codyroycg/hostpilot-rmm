import { getSettings } from './db.js';

/** Post to the configured webhook (Slack, Teams, Discord, ntfy…). Never throws. */
export async function notify(text, extra = {}) {
  const { webhook_url } = getSettings();
  if (!webhook_url) return;
  try {
    // "text" works for Slack/Mattermost/Teams-style hooks, "content" for Discord.
    await fetch(webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, content: text, ...extra }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    console.warn('[webhook] delivery failed:', e.message);
  }
}
