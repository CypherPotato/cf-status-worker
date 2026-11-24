import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { parseConfig } from '../src/config.js';
import { purge, readStatus } from '../src/status.js';
import worker from '../src/worker.js';

class D1 {
  constructor() {
    this.sqlite = new Database(':memory:');
    const migrations = new URL('../migrations/', import.meta.url);
    for (const file of readdirSync(migrations).sort()) this.sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  prepare(sql) {
    const query = this.sqlite.prepare(sql);
    let values = [];
    const statement = {
      bind(...args) { values = args; return statement; },
      async all() { return { results: query.all(...values), success: true }; },
      async run() { return { meta: { changes: query.run(...values).changes }, success: true }; }
    };
    return statement;
  }
  async batch(statements) { return Promise.all(statements.map(statement => statement.all())); }
}

const raw = JSON.stringify({
  visualization: { tickFrequency: '1day', maxTimeSpan: '30day', clearIssuesAfter: '30min', elevatedAfter: 5 },
  components: [
    { label: { name: 'api', title: 'API', group: 'Services' }, ping: { url: 'https://private.example/health', interval: '15min', headers: { Authorization: 'private-header' } } },
    { label: { name: 'reports-only', title: 'Reports only' } }
  ]
});
const config = parseConfig(raw);
const key = 'test-only-api-key-not-a-real-secret-123';
const now = 1800000000000;
let databases = [];
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const db of databases) db.sqlite.close();
  databases = [];
});

function database() {
  const db = new D1();
  databases.push(db);
  return db;
}

function request(body, authorization = `Bearer ${key}`, contentType = 'application/json') {
  return new Request('https://status.example/api/incidents', {
    method: 'POST', headers: { Authorization: authorization, 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

function report(db, component, issue, at, count = 1) {
  for (let index = 0; index < count; index++) {
    db.sqlite.prepare('INSERT INTO reports (component, class, reported_at) VALUES (?, ?, ?)').run(component, issue, at);
  }
}

function check(db, at, ok) {
  db.sqlite.prepare('INSERT INTO checks VALUES (?, ?, ?, ?, ?)').run('api', at, ok, 123, ok ? 200 : 503);
}

describe('configuration', () => {
  test('component identifiers accept uppercase and reject case-insensitive duplicates', () => {
    const value = JSON.parse(raw);
    value.components[0].label.name = 'Service-API_1';
    expect(parseConfig(JSON.stringify(value)).components[0].label.name).toBe('service-api_1');
    value.components[1].label.name = 'SERVICE-api_1';
    expect(() => parseConfig(JSON.stringify(value))).toThrow('duplicates components[0].label.name');
  });

  test('validates limits and keeps labels separate from private ping data', () => {
    expect(config.components[0].label.name).toBe('api');
    for (const mutate of [
      value => value.components.push(value.components[0]),
      value => value.components[0].ping.url = 'http://example.com',
      value => value.components[0].ping.interval = '1sec',
      value => value.visualization.tickFrequency = '1min',
      value => value.visualization.clearIssuesAfter = '31day',
      value => value.visualization.elevatedAfter = 1
    ]) {
      const value = JSON.parse(raw);
      mutate(value);
      expect(() => parseConfig(JSON.stringify(value))).toThrow();
    }
  });
});

describe('status aggregation', () => {
  test('branding normalizes allowed public fields and supports the legacy success spelling', async () => {
    expect(config.branding).toEqual({});
    const value = JSON.parse(raw);
    value.branding = { title: '<b>AIVAX Status</b>', backgroundColor: '#faf8f5', foregroundColor: '#000', highlightColor: '#7e2a42', succcessColor: '#0da70d', warnColor: '#d17c4a', dangerColor: '#cf2929', secret: 'not-public' };
    const result = await readStatus(database(), parseConfig(JSON.stringify(value)), now);
    expect(result.branding.title).toBe('<b>AIVAX Status</b>');
    expect(result.branding.successColor).toBe('#0da70d');
    expect(result.branding.secret).toBeUndefined();
    expect(result.branding.succcessColor).toBeUndefined();
    value.branding.successColor = '#123456';
    expect(parseConfig(JSON.stringify(value)).branding.successColor).toBe('#123456');
    for (const branding of [null, [], { title: '' }, { title: 42 }, { title: 'a'.repeat(201) }, { backgroundColor: 'url(https://example.com)' }, { dangerColor: '#zzzzzz' }, { succcessColor: 12 }]) {
      expect(() => parseConfig(JSON.stringify({ ...value, branding }))).toThrow();
    }
  });

  test('group metadata is optional, validated and exposed without unknown fields', async () => {
    expect(config.groups).toEqual([]);
    const value = JSON.parse(raw);
    value.groups = [{ name: 'Services', label: 'Global API', description: 'Management and observability', privateField: 'not-public' }];
    const grouped = parseConfig(JSON.stringify(value));
    const result = await readStatus(database(), grouped, now);
    expect(result.groups).toEqual([{ name: 'Services', label: 'Global API', description: 'Management and observability' }]);
    expect(result.components[0].group).toBe('Services');
    for (const groups of [null, {}, [null], [{ name: 'api', label: '' }], [{ name: 'api', label: 'API', description: 42 }], [value.groups[0], value.groups[0]]]) {
      expect(() => parseConfig(JSON.stringify({ ...value, groups }))).toThrow();
    }
    expect(parseConfig(JSON.stringify({ ...value, groups: [{ name: 'api', label: 'API' }] })).groups[0].description).toBe('');
  });

  test('empty ping data remains unknown while report-only starts stable', async () => {
    const result = await readStatus(database(), config, now);
    expect(result.active).toEqual([]);
    expect(result.components[0].uptime).toBeNull();
    expect(result.components[0].stale).toBe(true);
    expect(result.components[0].ticks.every(tick => tick.status === 'unknown')).toBe(true);
    expect(result.components[1].status).toBe('operational');
    expect(result.components[1].uptime).toBe(100);
    expect(result.components[1].latencyMs).toBeNull();
    expect(result.components[1].ticks.every(tick => tick.status === 'operational')).toBe(true);
  });

  test('daily latency percentiles use successful checks only', async () => {
    const db = database();
    const day = Math.floor(now / 86400000) * 86400000;
    for (let index = 1; index <= 100; index++) {
      db.sqlite.prepare('INSERT INTO checks VALUES (?, ?, ?, ?, ?)').run('api', day + index, 1, index * 10, 200);
    }
    db.sqlite.prepare('INSERT INTO checks VALUES (?, ?, ?, ?, ?)').run('api', day + 101, 0, 99999, 503);
    const result = await readStatus(db, config, now);
    expect(result.latency).toEqual([{ day, checks: 100, p50: 500, p95: 950, p99: 990 }]);
  });

  test('report-only degrades with reports, unions overlapping classes and recovers after quiet time', async () => {
    const db = database();
    report(db, 'reports-only', 'Users', now - 1200000, 5);
    report(db, 'reports-only', 'Billing', now - 600000);
    let result = await readStatus(db, config, now);
    let component = result.components[1];
    expect(component.status).toBe('elevated');
    expect(component.ticks.at(-1).status).toBe('elevated');
    expect(component.uptime).toBeCloseTo((1 - 1200000 / config.spanMs) * 100, 8);
    expect(component.lastCheck).toBeNull();
    result = await readStatus(db, config, now + 1200000);
    component = result.components[1];
    expect(component.status).toBe('operational');
    expect(component.uptime).toBeCloseTo((1 - 2400000 / config.spanMs) * 100, 8);
    expect(result.active).toHaveLength(0);
    result = await readStatus(db, config, now + config.spanMs);
    expect(result.components[1].uptime).toBe(100);
  });

  test('report-only isolated reports lower stability without counting gaps or other components', async () => {
    const db = database();
    report(db, 'reports-only', 'Users', now - 7200000);
    report(db, 'reports-only', 'Users', now - 600000);
    report(db, 'api', 'Other', now - 3600000);
    const result = await readStatus(db, config, now);
    expect(result.components[1].status).toBe('reported');
    expect(result.components[1].uptime).toBeCloseTo((1 - 2400000 / config.spanMs) * 100, 8);
    expect(result.components[0].uptime).toBeNull();
  });

  test('top three classes sort by count then recency and escalate at five reports', async () => {
    const db = database();
    report(db, 'api', 'Users', now - 1000, 5);
    report(db, 'api', 'Billing', now - 2000, 3);
    report(db, 'api', 'Search', now - 1000, 3);
    report(db, 'api', 'Other', now - 1000, 1);
    check(db, now - 2000, 1);
    check(db, now - 1000, 0);
    const result = await readStatus(db, config, now);
    const tick = result.components[0].ticks.at(-1);
    expect(tick.issues.map(issue => issue.class)).toEqual(['Users', 'Search', 'Billing']);
    expect(tick.issues[0].severity).toBe('elevated');
    expect(tick.failed).toBe(1);
    expect(result.components[0].uptime).toBe(50);
    expect(result.components[0].latencyMs).toBe(123);
    expect(result.active).toHaveLength(5);
    expect(result.components[0].status).toBe('elevated');
    expect(JSON.stringify(result)).not.toContain('private.example');
    expect(JSON.stringify(result)).not.toContain('private-header');
  });

  test('quiet classes expire independently, with a new episode at the exact boundary', async () => {
    const db = database();
    report(db, 'api', 'Users', now - config.clearMs);
    report(db, 'api', 'Users', now);
    report(db, 'api', 'Billing', now - config.clearMs);
    report(db, 'reports-only', 'Users', now - config.clearMs);
    const result = await readStatus(db, config, now);
    expect(result.active).toHaveLength(1);
    expect(result.active[0].count).toBe(1);
    expect(result.history.items).toHaveLength(4);
    expect(result.history.items.filter(item => item.resolved_at === now)).toHaveLength(3);
  });

  test('a ping failure stays active until recovery and separates recurring outages', async () => {
    const db = database();
    check(db, now - 5000, 0);
    check(db, now - 4000, 0);
    check(db, now - 3000, 1);
    check(db, now - 2000, 0);
    let result = await readStatus(db, config, now);
    expect(result.active).toHaveLength(1);
    expect(result.history.items).toHaveLength(2);
    expect(result.history.items[1].resolved_at).toBe(now - 3000);
    check(db, now - 1000, 1);
    result = await readStatus(db, config, now);
    expect(result.active).toHaveLength(0);
    expect(result.components[0].status).toBe('operational');
  });

  test('retention filters old data and physically deletes all expired records', async () => {
    const db = database();
    const cutoff = now - config.spanMs;
    report(db, 'api', 'Old', cutoff - 1);
    report(db, 'api', 'Kept', cutoff);
    check(db, cutoff - 1, 0);
    db.sqlite.prepare('INSERT INTO monitor_state VALUES (?, ?, ?)').run('api', now, cutoff - 1);
    const result = await readStatus(db, config, now);
    expect(result.history.items.map(item => item.class)).toEqual(['Kept']);
    await purge(db, cutoff);
    expect(db.sqlite.query('SELECT COUNT(*) AS total FROM reports').get().total).toBe(1);
    expect(db.sqlite.query('SELECT COUNT(*) AS total FROM checks').get().total).toBe(0);
    expect(db.sqlite.query('SELECT COUNT(*) AS total FROM monitor_state').get().total).toBe(0);
  });

  test('history is paginated and removed components are excluded', async () => {
    const db = database();
    for (let index = 0; index < 55; index++) report(db, 'api', `Class ${index}`, now - index);
    report(db, 'removed', 'Hidden', now);
    const first = await readStatus(db, config, now);
    const second = await readStatus(db, config, now, 50, true);
    expect(first.history.items).toHaveLength(50);
    expect(first.history.nextOffset).toBe(50);
    expect(second.items).toHaveLength(5);
    expect(second.nextOffset).toBeNull();
    expect(first.active).toHaveLength(55);
  });
});

describe('worker HTTP', () => {
  test('mixed-case component names share existing reports, checks and monitor claims', async () => {
    const db = database();
    const value = JSON.parse(raw);
    value.components[0].label.name = 'ApI';
    const env = { DB: db, STATUS_CONFIG: JSON.stringify(value), INGEST_API_KEY: key };
    const time = Date.now();
    report(db, 'api', 'Users', time - 1000, 2);
    check(db, time - 1000, 1);
    db.sqlite.prepare('INSERT INTO monitor_state VALUES (?, ?, ?)').run('api', time + 60000, time);
    for (const name of ['API', 'aPi', 'api']) {
      expect((await worker.fetch(request({ name, class: 'Users' }), env)).status).toBe(202);
    }
    const response = await worker.fetch(new Request('https://status.example/api/status'), env);
    const status = await response.json();
    expect(status.components[0].name).toBe('api');
    expect(status.components[0].uptime).toBe(100);
    expect(status.active[0].count).toBe(5);
    expect(status.active[0].severity).toBe('elevated');
    expect(status.history.items).toHaveLength(1);
    expect(db.sqlite.query('SELECT DISTINCT component FROM reports').all()).toEqual([{ component: 'api' }]);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('OK'); };
    await worker.scheduled({}, env);
    expect(calls).toBe(0);
    expect(db.sqlite.query('SELECT COUNT(*) AS count FROM monitor_state').get().count).toBe(1);
  });

  test('requires a non-empty key and an exact bearer credential', async () => {
    const db = database();
    const env = { DB: db, STATUS_CONFIG: raw, INGEST_API_KEY: key };
    expect((await worker.fetch(request({ name: 'api', class: 'Users' }, ''), env)).status).toBe(401);
    expect((await worker.fetch(request({ name: 'api', class: 'Users' }, 'Bearer wrong'), env)).status).toBe(401);
    expect((await worker.fetch(request({ name: 'api', class: 'Users' }), { ...env, INGEST_API_KEY: '' })).status).toBe(503);
    expect((await worker.fetch(request({ name: 'api', class: 'Users' }), env)).status).toBe(202);
    expect(db.sqlite.query('SELECT COUNT(*) AS total FROM reports').get().total).toBe(1);
  });

  test('accepts short API keys and internal spaces with exact authentication', async () => {
    for (const apiKey of ['x', 'short key']) {
      const env = { DB: database(), STATUS_CONFIG: raw, INGEST_API_KEY: apiKey };
      expect((await worker.fetch(request({ name: 'api', class: 'Users' }, `Bearer ${apiKey}`), env)).status).toBe(202);
      expect((await worker.fetch(request({ name: 'api', class: 'Users' }, `Bearer ${apiKey}!`), env)).status).toBe(401);
    }
  });

  test('rejects invalid payloads and methods without writes', async () => {
    const db = database();
    const env = { DB: db, STATUS_CONFIG: raw, INGEST_API_KEY: key };
    for (const [body, expected] of [ ['{', 400], [null, 400], [{ name: 'api', class: '' }, 400], [{ name: 'absent', class: 'Users' }, 404], ['x'.repeat(4097), 413] ]) {
      expect((await worker.fetch(request(body), env)).status).toBe(expected);
    }
    expect((await worker.fetch(request('{}', `Bearer ${key}`, 'text/plain'), env)).status).toBe(415);
    expect((await worker.fetch(new Request('https://status.example/api/incidents'), env)).status).toBe(405);
    expect((await worker.fetch(new Request('https://status.example/api/history?offset=-1'), env)).status).toBe(400);
    expect(db.sqlite.query('SELECT COUNT(*) AS total FROM reports').get().total).toBe(0);
  });

  test('public routes expose neither the configuration nor secrets', async () => {
    const env = { DB: database(), STATUS_CONFIG: raw, INGEST_API_KEY: key };
    for (const path of ['/config.json', '/config.json.example', '/.dev.vars', '/wrangler.jsonc', '/src/worker.js']) {
      expect((await worker.fetch(new Request(`https://status.example${path}`), env)).status).toBe(404);
    }
    const response = await worker.fetch(new Request('https://status.example/api/status'), env);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(key);
    expect(text).not.toContain('private-header');
    expect(text).not.toContain('private.example');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('telegram', () => {
  const token = '123456:test-only-token-not-a-real-secret-0000';
  const telegramRaw = JSON.stringify({ ...JSON.parse(raw), telegram: { botToken: token } });

  function mockTelegram(updates = []) {
    const sent = [];
    globalThis.fetch = async (url, options) => {
      if (!String(url).startsWith('https://api.telegram.org/')) return new Response('OK');
      const method = String(url).split('/').at(-1);
      const body = JSON.parse(options.body);
      if (method === 'getMe') return Response.json({ ok: true, result: { username: 'status_bot' } });
      if (method === 'getUpdates') return Response.json({ ok: true, result: updates.splice(0).filter(update => update.update_id >= body.offset) });
      sent.push(body);
      return Response.json({ ok: true, result: {} });
    };
    return sent;
  }

  test('validates the bot token and keeps it private', async () => {
    expect(parseConfig(telegramRaw).telegram.botId).toBe(123456);
    for (const telegram of [null, {}, { botToken: 'invalid' }]) {
      expect(() => parseConfig(JSON.stringify({ ...JSON.parse(raw), telegram }))).toThrow();
    }
    const db = database();
    mockTelegram();
    const env = { DB: db, STATUS_CONFIG: telegramRaw, INGEST_API_KEY: key };
    await worker.scheduled({}, env);
    const text = await (await worker.fetch(new Request('https://status.example/api/status'), env)).text();
    expect(text).not.toContain(token);
    expect(JSON.parse(text).telegram).toEqual({ url: 'https://t.me/status_bot' });
  });

  test('subscribes chats and notifies once when incidents start and resolve', async () => {
    const db = database();
    const env = { DB: db, STATUS_CONFIG: telegramRaw, INGEST_API_KEY: key };
    const sent = mockTelegram([{ update_id: 7, message: { text: '/start', chat: { id: 42 } } }]);
    await worker.scheduled({}, env);
    expect(sent.map(message => message.chat_id)).toEqual([42]);
    sent.length = 0;

    expect((await worker.fetch(request({ name: 'reports-only', class: 'Login' }), env)).status).toBe(202);
    db.sqlite.exec('UPDATE telegram_bots SET claimed_at = 0');
    await Promise.all([worker.scheduled({}, env), worker.scheduled({}, env)]);
    const opened = sent.filter(message => message.text.includes('Reported issues with Login'));
    expect(opened).toHaveLength(1);
    expect(opened[0].chat_id).toBe(42);

    sent.length = 0;
    db.sqlite.exec(`UPDATE reports SET reported_at = reported_at - ${config.clearMs + 1000}`);
    db.sqlite.exec(`UPDATE telegram_incidents SET started_at = started_at - ${config.clearMs + 1000}, last_at = last_at - ${config.clearMs + 1000}`);
    await worker.scheduled({}, env);
    await worker.scheduled({}, env);
    expect(sent.filter(message => message.text.includes('Resolved: Login'))).toHaveLength(1);
    expect(db.sqlite.query('SELECT COUNT(*) AS total FROM telegram_incidents').get().total).toBe(0);
  });
});

test('cron claims prevent duplicate checks and redirects count as failures', async () => {
  const db = database();
  const env = { DB: db, STATUS_CONFIG: raw };
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    expect(options.redirect).toBe('manual');
    return new Response('', { status: 302 });
  };
  await Promise.all([worker.scheduled({}, env), worker.scheduled({}, env)]);
  expect(calls).toBe(1);
  expect(db.sqlite.query('SELECT ok, status_code FROM checks').get()).toEqual({ ok: 0, status_code: 302 });
  await worker.scheduled({}, env);
  expect(calls).toBe(1);
});
