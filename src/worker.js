import { parseConfig } from './config.js';
import { purge, readStatus } from './status.js';
import { notifyTelegram, pollTelegram } from './telegram.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    };
    try {
      if (url.pathname === '/api/incidents') {
        if (request.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: { ...headers, Allow: 'POST' } });
        if (typeof env.INGEST_API_KEY !== 'string' || env.INGEST_API_KEY.length === 0) {
          return Response.json({ error: 'Ingestion is not configured.' }, { status: 503, headers });
        }
        const authorization = request.headers.get('Authorization') ?? '';
        const encoder = new TextEncoder();
        const [actual, expected] = await Promise.all([
          crypto.subtle.digest('SHA-256', encoder.encode(authorization)),
          crypto.subtle.digest('SHA-256', encoder.encode(`Bearer ${env.INGEST_API_KEY}`))
        ]);
        const actualBytes = new Uint8Array(actual);
        const expectedBytes = new Uint8Array(expected);
        let mismatch = 0;
        for (let index = 0; index < actualBytes.length; index++) mismatch |= actualBytes[index] ^ expectedBytes[index];
        if (mismatch) return Response.json({ error: 'Unauthorized.' }, { status: 401, headers: { ...headers, 'WWW-Authenticate': 'Bearer' } });
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          return Response.json({ error: 'Use application/json.' }, { status: 415, headers });
        }
        const reader = request.body?.getReader();
        let body = '';
        let size = 0;
        const decoder = new TextDecoder();
        if (reader) {
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > 4096) {
                await reader.cancel();
                return Response.json({ error: 'Body exceeds 4096 bytes.' }, { status: 413, headers });
              }
              body += decoder.decode(value, { stream: true });
            }
            body += decoder.decode();
          } finally {
            reader.releaseLock();
          }
        }
        let data;
        try { data = JSON.parse(body); } catch {
          return Response.json({ error: 'Invalid JSON.' }, { status: 400, headers });
        }
        if (!data || typeof data.name !== 'string' || typeof data.class !== 'string' ||
            !data.class.trim() || data.class.length > 120 || /[\u0000-\u001f\u007f]/.test(data.class)) {
          return Response.json({ error: 'Provide a component name and a class of 1–120 characters.' }, { status: 400, headers });
        }
        const config = parseConfig(env.STATUS_CONFIG);
        const name = data.name.toLowerCase();
        if (!config.components.some(component => component.label.name === name)) {
          return Response.json({ error: 'Unknown component.' }, { status: 404, headers });
        }
        const now = Date.now();
        await purge(env.DB, now - config.spanMs);
        await env.DB.prepare('INSERT INTO reports (component, class, reported_at) VALUES (?, ?, ?)')
          .bind(name, data.class.trim(), now).run();
        return Response.json({ accepted: true, receivedAt: now }, { status: 202, headers });
      }
      if (url.pathname === '/api/status' || url.pathname === '/api/history') {
        if (request.method !== 'GET') return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: { ...headers, Allow: 'GET' } });
        const config = parseConfig(env.STATUS_CONFIG);
        const offsetText = url.searchParams.get('offset') ?? '0';
        const offset = Number(offsetText);
        if (!/^\d+$/.test(offsetText) || !Number.isSafeInteger(offset) || offset > 1000000) {
          return Response.json({ error: 'Invalid history offset.' }, { status: 400, headers });
        }
        const now = Date.now();
        return Response.json(await readStatus(env.DB, config, now, offset, url.pathname === '/api/history'), { headers });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } });
      }
      if (!['/', '/index.html', '/scripts/app.js', '/styles/main.css', '/favicon.svg'].includes(url.pathname)) {
        return new Response('Not found', { status: 404, headers });
      }
      const asset = await env.ASSETS.fetch(request);
      const response = new Response(asset.body, asset);
      for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
      return response;
    } catch {
      console.error('Worker Status request failed. Check configuration and D1 migrations.');
      return Response.json({ error: 'Status service temporarily unavailable.' }, { status: 503, headers });
    }
  },

  async scheduled(controller, env) {
    const config = parseConfig(env.STATUS_CONFIG);
    const now = Date.now();
    await purge(env.DB, now - config.spanMs);
    const monitors = config.components.filter(component => component.ping);
    for (let offset = 0; offset < monitors.length; offset += 5) {
      await Promise.all(monitors.slice(offset, offset + 5).map(async ({ label, ping }) => {
        const claim = await env.DB.prepare(`INSERT INTO monitor_state (component, next_check_at, claimed_at)
          VALUES (?, ?, ?) ON CONFLICT(component) DO UPDATE SET
          next_check_at = excluded.next_check_at, claimed_at = excluded.claimed_at
          WHERE monitor_state.next_check_at <= ?`)
          .bind(label.name, now + ping.intervalMs, now, now).run();
        if (!claim.meta.changes) return;
        const started = Date.now();
        let statusCode = null;
        let ok = false;
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), ping.timeoutMs);
        try {
          const response = await fetch(ping.url, {
            headers: ping.headers, redirect: 'manual', signal: abort.signal, cache: 'no-store'
          });
          statusCode = response.status;
          ok = response.ok;
          await response.body?.cancel();
        } catch {
          ok = false;
        } finally {
          clearTimeout(timeout);
        }
        await env.DB.prepare(`INSERT INTO checks (component, checked_at, ok, latency_ms, status_code)
          VALUES (?, ?, ?, ?, ?)`)
          .bind(label.name, started, ok ? 1 : 0, Date.now() - started, statusCode).run();
      }));
    }

    if (config.telegram) {
      try {
        await pollTelegram(env.DB, config, now);
      } catch (error) {
        console.error(`Telegram polling failed: ${error.message}`);
      }
      await notifyTelegram(env.DB, config, Date.now());
    }
  }
};
