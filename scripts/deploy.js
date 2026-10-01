import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEdits, modify, parse, printParseErrorCode } from 'jsonc-parser';
import { ConfigValidationError, parseConfig } from '../src/config.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function runWrangler(args, { root, secrets }) {
  const child = Bun.spawn(['node', join(projectRoot, 'node_modules/wrangler/bin/wrangler.js'), ...args], {
    cwd: root,
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited
  ]);
  let output = `${stdout}\n${stderr}`;
  for (const value of secrets) if (value) output = output.replaceAll(value, '[REDACTED]');
  if (exitCode !== 0) throw new Error(`Wrangler ${args[0]} failed (${exitCode}).\n${output}`);
  if (!args.includes('--json')) console.log(output.trim());
  return stdout;
}

export async function deploy({ root = projectRoot, dryRun = false, execute = runWrangler } = {}) {
  const configPath = join(root, 'config.json');
  const wranglerPath = join(root, 'wrangler.jsonc');
  const keyPath = join(root, 'deploy.secrets.json');
  if (!existsSync(configPath)) throw new Error('Create config.json from config.json.example and configure your services first.');
  const rawStatus = readFileSync(configPath, 'utf8');
  const syntaxErrors = [];
  parse(rawStatus, syntaxErrors, { disallowComments: true, allowTrailingComma: false });
  if (syntaxErrors.length) {
    const first = syntaxErrors[0];
    const lines = rawStatus.slice(0, first.offset).split(/\r\n|\r|\n/);
    throw new Error(`config.json is invalid at line ${lines.length}, column ${lines.at(-1).length + 1}: ${printParseErrorCode(first.error)}. Use strict JSON: double-quoted keys/strings, no comments or trailing commas. No deployment was performed.`);
  }
  try { parseConfig(rawStatus); } catch (error) {
    const detail = error instanceof ConfigValidationError ? error.message : 'Unexpected configuration validation failure.';
    throw new Error(`config.json is invalid: ${detail} No deployment was performed.`);
  }
  const statusConfig = JSON.stringify(JSON.parse(rawStatus));
  let text = readFileSync(existsSync(wranglerPath) ? wranglerPath : join(root, 'wrangler.jsonc.example'), 'utf8');
  const errors = [];
  const config = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !config || typeof config !== 'object') throw new Error('Invalid wrangler.jsonc.');
  if (config.env && Object.keys(config.env).length) throw new Error('This deploy script supports the default environment only. Remove named environments or deploy them explicitly with Wrangler.');
  const databaseIndex = config.d1_databases?.findIndex(item => item.binding === 'DB') ?? -1;
  const database = config.d1_databases?.[databaseIndex];
  if (!database?.database_name || !config.name || !config.main || !config.assets?.directory) {
    throw new Error('Wrangler configuration requires a Worker name, main, assets directory and a named D1 binding DB.');
  }
  for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID']) {
    if (process.env[name] && !/^[a-f0-9]{32}$/i.test(process.env[name])) {
      throw new Error(`${name} contains an invalid account ID. Remove it to use wrangler login, or correct it.`);
    }
  }

  let savedSecrets = {};
  if (existsSync(keyPath)) {
    try { savedSecrets = JSON.parse(readFileSync(keyPath, 'utf8')); } catch {
      throw new Error('deploy.secrets.json is not valid JSON.');
    }
    if (!savedSecrets || Array.isArray(savedSecrets) || typeof savedSecrets !== 'object') {
      throw new Error('deploy.secrets.json must contain a JSON object.');
    }
  }
  const legacyKey = config.vars?.INGEST_API_KEY;
  let apiKey = savedSecrets.INGEST_API_KEY ?? legacyKey;
  if (savedSecrets.INGEST_API_KEY !== undefined && legacyKey !== undefined && savedSecrets.INGEST_API_KEY !== legacyKey) {
    throw new Error('Conflicting INGEST_API_KEY values in deploy.secrets.json and wrangler.jsonc. Choose the intended key before deploying.');
  }
  if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length === 0)) {
    throw new Error('INGEST_API_KEY must be a non-empty string.');
  }
  if (apiKey === undefined) {
    if (dryRun) {
      apiKey = 'dry-run-placeholder-not-for-production-000000';
    } else {
      // Preserve a dashboard-provisioned key: secrets cannot be read back through Wrangler.
      if (!existsSync(wranglerPath)) writeFileSync(wranglerPath, text);
      let remoteSecrets;
      try {
        remoteSecrets = JSON.parse(await execute(['secret', 'list', '--name', config.name, '--config', wranglerPath], { root, secrets: [statusConfig] }));
      } catch (error) {
        if (!error.message.includes(`Worker "${config.name}" not found.`)) throw error;
        remoteSecrets = [];
      }
      if (remoteSecrets.some(secret => secret.name === 'INGEST_API_KEY')) {
        throw new Error('A remote INGEST_API_KEY already exists. Put the same key in deploy.secrets.json to avoid rotating it unintentionally.');
      }
      apiKey = randomBytes(32).toString('hex');
    }
  }
  const context = { root, secrets: [apiKey, statusConfig, rawStatus] };
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' };
  for (const field of ['INGEST_API_KEY', 'STATUS_CONFIG']) {
    if (Object.hasOwn(config.vars ?? {}, field)) {
      text = applyEdits(text, modify(text, ['vars', field], undefined, { formattingOptions }));
    }
  }
  if (!dryRun) {
    if (savedSecrets.INGEST_API_KEY === undefined) {
      writeFileSync(keyPath, `${JSON.stringify({ ...savedSecrets, INGEST_API_KEY: apiKey }, null, 2)}\n`, { mode: 0o600 });
    }
    writeFileSync(wranglerPath, text);
    console.log('[deploy] Private API key stored in deploy.secrets.json (not printed).');
    if (legacyKey !== undefined) console.log('[deploy] Migrated existing API key out of Wrangler vars; the key was not rotated.');
    console.log('[deploy] Checking D1 database.');
    let databases = JSON.parse(await execute(['d1', 'list', '--json', '--config', wranglerPath], context));
    const placeholder = !database.database_id || database.database_id === '00000000-0000-0000-0000-000000000000';
    let selected = placeholder ? databases.find(item => item.name === database.database_name) : databases.find(item => item.uuid === database.database_id);
    if (!selected && !placeholder) throw new Error('Configured D1 database ID does not exist in the selected account. No replacement database was created.');
    if (!selected) {
      console.log('[deploy] Creating D1 database.');
      await execute(['d1', 'create', database.database_name, '--update-config=false', '--config', wranglerPath], context);
      databases = JSON.parse(await execute(['d1', 'list', '--json', '--config', wranglerPath], context));
      selected = databases.find(item => item.name === database.database_name);
    }
    if (!selected?.uuid) throw new Error('Could not resolve the D1 database after creation.');
    if (selected.uuid !== database.database_id) {
      text = applyEdits(text, modify(text, ['d1_databases', databaseIndex, 'database_id'], selected.uuid, { formattingOptions }));
      writeFileSync(wranglerPath, text);
    }
    console.log('[deploy] Applying remote D1 migrations.');
    await execute(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', wranglerPath], context);
  }

  const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '-') + '-UTC';
  const temporaryRoot = join(tmpdir(), '.avi', 'visualizations', stamp);
  mkdirSync(temporaryRoot, { recursive: true });
  const temporary = mkdtempSync(join(temporaryRoot, 'worker-status-deploy-'));
  try {
    const secretsPath = join(temporary, 'secrets.json');
    writeFileSync(secretsPath, JSON.stringify({ STATUS_CONFIG: statusConfig, INGEST_API_KEY: apiKey }), { mode: 0o600 });
    let deployConfig = wranglerPath;
    if (dryRun) {
      const preview = parse(text);
      preview.main = resolve(root, preview.main);
      preview.assets.directory = resolve(root, preview.assets.directory);
      for (const binding of preview.d1_databases) binding.migrations_dir = resolve(root, binding.migrations_dir ?? 'migrations');
      deployConfig = join(temporary, 'wrangler.jsonc');
      writeFileSync(deployConfig, JSON.stringify(preview));
    }
    console.log(dryRun ? '[deploy] Validating bundle only; no remote or project configuration changes.' : '[deploy] Publishing Worker, assets, cron and private secrets together.');
    await execute(['deploy', '--config', deployConfig, '--secrets-file', secretsPath, ...(dryRun ? ['--dry-run'] : [])], context);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  console.log(dryRun ? '[deploy] Dry run complete.' : '[deploy] Complete. API key: deploy.secrets.json. Keep this file private.');
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: bun run deploy [--dry-run]\n\nWithout flags: validate config.json, prepare local Wrangler config and private API key,\nreuse or create D1, apply remote migrations, then deploy with both secrets.\nRequires a prior wrangler login or valid Cloudflare API credentials.\n\n--dry-run  Validate configuration and bundle without remote or project config changes.\n--help     Show this help.\n\nThe key is reused from deploy.secrets.json or legacy Wrangler vars, or generated\nonce when no local/remote key exists. Existing keys are never rotated automatically.`);
  } else {
    try {
      if (args.some(arg => arg !== '--dry-run')) throw new Error('Unknown option. Use --help for supported options.');
      await deploy({ dryRun: args.includes('--dry-run') });
    } catch (error) {
      console.error(`[deploy] ${error.message}`);
      process.exitCode = 1;
    }
  }
}
