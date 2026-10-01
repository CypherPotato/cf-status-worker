import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { deploy } from '../scripts/deploy.js';

const roots = [];
const originalIds = [process.env.CLOUDFLARE_ACCOUNT_ID, process.env.CF_ACCOUNT_ID];
const key = 'offline-test-key-never-used-in-production-123456';
const uuid = '11111111-1111-4111-8111-111111111111';
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
  ['CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID'].forEach((name, index) => {
    if (originalIds[index] === undefined) delete process.env[name];
    else process.env[name] = originalIds[index];
  });
});

function fixture({ legacy = true, id = uuid, local = true } = {}) {
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CF_ACCOUNT_ID;
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '-') + '-UTC';
  const parent = join(tmpdir(), '.avi', 'visualizations', stamp);
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'deploy-test-'));
  roots.push(root);
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc.example', import.meta.url), 'utf8'));
  config.d1_databases[0].database_id = id;
  config.vars = { unrelated: 'preserved', ...(legacy ? { INGEST_API_KEY: key } : {}) };
  const text = `// Keep this comment\n${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(join(root, 'wrangler.jsonc.example'), text);
  if (local) writeFileSync(join(root, 'wrangler.jsonc'), text);
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    visualization: { tickFrequency: '1day', maxTimeSpan: '30day', clearIssuesAfter: '30min' },
    components: [{ label: { name: 'service-uptime', title: 'Service uptime' } }]
  }));
  return root;
}

test('deploy migrates legacy key, reuses database, applies migrations before atomic secret upload', async () => {
  const root = fixture();
  const calls = [];
  let transient;
  await deploy({ root, execute: async args => {
    calls.push(args);
    if (args[0] === 'd1' && args[1] === 'list') return JSON.stringify([{ name: 'worker-status', uuid }]);
    if (args[0] === 'deploy') {
      transient = args[args.indexOf('--secrets-file') + 1];
      const secrets = JSON.parse(readFileSync(transient));
      expect(secrets.INGEST_API_KEY).toBe(key);
      expect(JSON.parse(secrets.STATUS_CONFIG).components[0].label.name).toBe('service-uptime');
      expect(args.join(' ')).not.toContain(key);
    }
    return '';
  } });
  expect(calls.map(args => args.slice(0, 2).join(' '))).toEqual(['d1 list', 'd1 migrations', 'deploy --config']);
  expect(existsSync(transient)).toBe(false);
  const text = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
  expect(text).toContain('// Keep this comment');
  expect(parse(text).vars).toEqual({ unrelated: 'preserved' });
  expect(JSON.parse(readFileSync(join(root, 'deploy.secrets.json'))).INGEST_API_KEY).toBe(key);
});

test('first deploy creates database and persists a generated key; retry reuses both', async () => {
  const root = fixture({ legacy: false, id: '00000000-0000-0000-0000-000000000000', local: false });
  let created = false;
  const calls = [];
  const execute = async args => {
    calls.push(args);
    if (args[0] === 'secret') throw new Error('Worker "worker-status" not found.');
    if (args[1] === 'create') created = true;
    if (args[1] === 'list') return JSON.stringify(created ? [{ name: 'worker-status', uuid }] : []);
    return '';
  };
  await deploy({ root, execute });
  const saved = readFileSync(join(root, 'deploy.secrets.json'), 'utf8');
  expect(JSON.parse(saved).INGEST_API_KEY).toMatch(/^[a-f0-9]{64}$/);
  expect(parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).d1_databases[0].database_id).toBe(uuid);
  await deploy({ root, execute });
  expect(readFileSync(join(root, 'deploy.secrets.json'), 'utf8')).toBe(saved);
  expect(calls.filter(args => args[1] === 'create')).toHaveLength(1);
  expect(calls.filter(args => args[0] === 'secret')).toHaveLength(1);
});

test('dry run only bundles and leaves project configuration untouched', async () => {
  const root = fixture();
  const before = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
  const calls = [];
  await deploy({ root, dryRun: true, execute: async args => {
    calls.push(args);
    expect(args).toContain('--dry-run');
    expect(parse(readFileSync(args[args.indexOf('--config') + 1], 'utf8')).vars.INGEST_API_KEY).toBeUndefined();
    return '';
  } });
  expect(calls).toHaveLength(1);
  expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).toBe(before);
  expect(existsSync(join(root, 'deploy.secrets.json'))).toBe(false);
});

test('migration failure stops deployment and cleans no user data', async () => {
  const root = fixture();
  const calls = [];
  await expect(deploy({ root, execute: async args => {
    calls.push(args);
    if (args[1] === 'list') return JSON.stringify([{ name: 'worker-status', uuid }]);
    throw new Error('Migration failed');
  } })).rejects.toThrow('Migration failed');
  expect(calls.some(args => args[0] === 'deploy')).toBe(false);
  expect(existsSync(join(root, 'deploy.secrets.json'))).toBe(true);
});

test('existing remote key is never silently rotated', async () => {
  const root = fixture({ legacy: false });
  await expect(deploy({ root, execute: async () => JSON.stringify([{ name: 'INGEST_API_KEY' }]) })).rejects.toThrow('already exists');
  expect(existsSync(join(root, 'deploy.secrets.json'))).toBe(false);
});

test('invalid configuration and conflicting keys fail before any Cloudflare operation', async () => {
  const root = fixture();
  let called = false;
  const execute = async () => { called = true; return ''; };
  writeFileSync(join(root, 'deploy.secrets.json'), JSON.stringify({ INGEST_API_KEY: 'different-key-at-least-32-characters-123' }));
  await expect(deploy({ root, execute })).rejects.toThrow('Conflicting');
  writeFileSync(join(root, 'config.json'), '{}');
  await expect(deploy({ root, execute })).rejects.toThrow('config.json is invalid');
  expect(called).toBe(false);
});

test('config diagnostics identify syntax, field paths and duplicates without leaking values', async () => {
  const root = fixture();
  const path = join(root, 'config.json');
  const original = JSON.parse(readFileSync(path, 'utf8'));
  let calls = 0;
  const execute = async () => { calls++; return ''; };
  writeFileSync(path, '{\n  "private" "do-not-print-this-secret"\n}');
  await expect(deploy({ root, execute })).rejects.toThrow('line 2, column 13: ColonExpected');
  for (const [mutate, expected] of [
    [value => value.components[0].label.name = 'INVALID PRIVATE NAME', 'components[0].label.name: expected'],
    [value => value.components.push(value.components[0]), 'components[1].label.name: duplicates components[0].label.name'],
    [value => value.visualization.tickFrequency = '1sec', 'visualization.tickFrequency: must be at least 1min'],
    [value => value.components[0].ping = { url: 'do-not-print-this-secret', interval: '15min' }, 'components[0].ping.url: expected'],
    [value => value.components[0].ping = { url: 'https://example.com', interval: '15min', headers: { Authorization: 'do-not-print-this-secret\ninvalid' } }, 'components[0].ping.headers: invalid']
  ]) {
    const value = structuredClone(original);
    mutate(value);
    writeFileSync(path, JSON.stringify(value));
    let message;
    try { await deploy({ root, execute }); } catch (error) { message = error.message; }
    expect(message).toContain(expected);
    expect(message).not.toContain('do-not-print-this-secret');
    expect(message).not.toContain('INVALID PRIVATE NAME');
  }
  expect(calls).toBe(0);
});

test('deploy accepts short and space-containing keys but rejects empty keys', async () => {
  const root = fixture({ legacy: false });
  for (const apiKey of ['x', 'short key']) {
    writeFileSync(join(root, 'deploy.secrets.json'), JSON.stringify({ INGEST_API_KEY: apiKey }));
    let calls = 0;
    await deploy({ root, dryRun: true, execute: async args => {
      calls++;
      const secrets = JSON.parse(readFileSync(args[args.indexOf('--secrets-file') + 1]));
      expect(secrets.INGEST_API_KEY).toBe(apiKey);
      return '';
    } });
    expect(calls).toBe(1);
  }
  writeFileSync(join(root, 'deploy.secrets.json'), JSON.stringify({ INGEST_API_KEY: '' }));
  await expect(deploy({ root, dryRun: true })).rejects.toThrow('must be a non-empty string');
});

test('temporary secret file is deleted even when upload fails', async () => {
  const root = fixture();
  let transient;
  await expect(deploy({ root, dryRun: true, execute: async args => {
    transient = args[args.indexOf('--secrets-file') + 1];
    throw new Error('Upload failed');
  } })).rejects.toThrow('Upload failed');
  expect(existsSync(transient)).toBe(false);
});
