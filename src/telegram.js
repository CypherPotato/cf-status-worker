import { incidentQuery } from './status.js';

const escape = text => String(text).replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
const format = time => `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

async function call(token, method, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  const result = await response.json().catch(() => ({}));
  if (!result.ok) throw Object.assign(new Error(`Telegram ${method} failed (${response.status}).`), { status: response.status });
  return result.result;
}

export async function pollTelegram(db, config, now) {
  const { botId, token } = config.telegram;
  await db.prepare('INSERT INTO telegram_bots (bot_id) VALUES (?) ON CONFLICT DO NOTHING').bind(botId).run();
  const claim = await db.prepare('UPDATE telegram_bots SET claimed_at = ? WHERE bot_id = ? AND claimed_at <= ?')
    .bind(now, botId, now - 30000).run();
  if (!claim.meta.changes) return;

  const bot = (await db.prepare('SELECT username, update_offset FROM telegram_bots WHERE bot_id = ?').bind(botId).all()).results[0];
  let username = bot.username;
  if (!username) {
    username = (await call(token, 'getMe')).username;
    await db.prepare('UPDATE telegram_bots SET username = ? WHERE bot_id = ?').bind(username, botId).run();
  }

  const updates = await call(token, 'getUpdates', { offset: bot.update_offset, timeout: 0, allowed_updates: ['message'] });
  const title = escape(config.branding.title ?? 'Worker Status');
  for (const { message } of updates) {
    const [command, mention] = (message?.text ?? '').split(/\s/)[0].toLowerCase().split('@');
    if (!message?.chat || (mention && mention !== username.toLowerCase())) continue;

    if (command === '/start') {
      await db.prepare('INSERT INTO telegram_subscribers (bot_id, chat_id, subscribed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
        .bind(botId, message.chat.id, now).run();
      await call(token, 'sendMessage', {
        chat_id: message.chat.id, parse_mode: 'HTML',
        text: `Subscribed to <b>${title}</b> notifications. You will be notified when incidents start and resolve.\n\nSend /stop to unsubscribe.`
      });
    } else if (command === '/stop') {
      await db.prepare('DELETE FROM telegram_subscribers WHERE bot_id = ? AND chat_id = ?').bind(botId, message.chat.id).run();
      await call(token, 'sendMessage', { chat_id: message.chat.id, text: 'Unsubscribed. Send /start to subscribe again.' });
    }
  }
  if (updates.length) {
    await db.prepare('UPDATE telegram_bots SET update_offset = ? WHERE bot_id = ?').bind(updates.at(-1).update_id + 1, botId).run();
  }
}

export async function notifyTelegram(db, config, now) {
  const { botId, token } = config.telegram;
  const names = config.components.map(component => component.label.name);
  const [activeResult, notifiedResult, subscriberResult] = await db.batch([
    db.prepare(`${incidentQuery} WHERE (resolved_at IS NULL OR resolved_at > ?) AND component IN (${names.map(() => '?').join(',')})`)
      .bind(now - config.spanMs, config.clearMs, now, ...names),
    db.prepare('SELECT * FROM telegram_incidents'),
    db.prepare('SELECT chat_id FROM telegram_subscribers WHERE bot_id = ?').bind(botId)
  ]);

  const titleOf = name => escape(config.components.find(component => component.label.name === name)?.label.title ?? name);
  const issueOf = incident => escape(`${incident.severity === 'elevated' ? 'Elevated' : 'Reported'} issues with ${incident.class}`);
  const sameKey = (a, b) => a.component === b.component && a.source === b.source && a.class === b.class;
  const active = activeResult.results
    .filter(incident => incident.source === 'report' || config.components.some(component => component.label.name === incident.component && component.ping))
    .map(incident => ({ ...incident, severity: incident.source === 'ping' || incident.count >= config.elevatedAfter ? 'elevated' : 'reported' }));
  const messages = [];

  const resolve = async stored => {
    const deleted = await db.prepare('DELETE FROM telegram_incidents WHERE component = ? AND source = ? AND class = ? AND started_at = ?')
      .bind(stored.component, stored.source, stored.class, stored.started_at).run();
    if (!deleted.meta.changes || !names.includes(stored.component)) return;

    const resolvedAt = stored.source === 'report' ? Math.min(stored.last_at + config.clearMs, now) : now;
    messages.push(`✅ <b>Resolved: ${escape(stored.class)}</b>\n${titleOf(stored.component)} · ${format(stored.started_at)} → ${format(resolvedAt)}`);
  };

  for (const incident of active) {
    const stored = notifiedResult.results.find(row => sameKey(row, incident));
    if (stored && incident.started_at <= stored.last_at) {
      if (incident.last_at > stored.last_at) {
        await db.prepare('UPDATE telegram_incidents SET last_at = MAX(last_at, ?) WHERE component = ? AND source = ? AND class = ?')
          .bind(incident.last_at, incident.component, incident.source, incident.class).run();
      }
      continue;
    }

    if (stored) await resolve(stored);
    const inserted = await db.prepare(`INSERT INTO telegram_incidents (component, source, class, started_at, last_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .bind(incident.component, incident.source, incident.class, incident.started_at, incident.last_at).run();
    if (inserted.meta.changes) {
      messages.push(`${incident.severity === 'elevated' ? '🔴' : '🟠'} <b>${issueOf(incident)}</b>\n${titleOf(incident.component)} · Started ${format(incident.started_at)}`);
    }
  }

  for (const stored of notifiedResult.results.filter(row => !active.some(incident => sameKey(row, incident)))) await resolve(stored);
  if (!messages.length || !subscriberResult.results.length) return;

  const texts = [];
  for (const message of messages) {
    if (texts.length && texts.at(-1).length + message.length + 2 <= 4096) texts[texts.length - 1] += `\n\n${message}`;
    else texts.push(message);
  }

  const subscribers = subscriberResult.results;
  for (let offset = 0; offset < subscribers.length; offset += 5) {
    await Promise.all(subscribers.slice(offset, offset + 5).map(async ({ chat_id }) => {
      try {
        for (const text of texts) await call(token, 'sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true });
      } catch (error) {
        if (error.status === 403) {
          await db.prepare('DELETE FROM telegram_subscribers WHERE bot_id = ? AND chat_id = ?').bind(botId, chat_id).run();
        } else {
          console.error(error.message);
        }
      }
    }));
  }
}
