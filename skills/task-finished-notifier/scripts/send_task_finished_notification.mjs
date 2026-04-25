import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const bundleRoot = path.resolve(__dirname, '..', '..', '..');
const installedPluginRoot = path.join(os.homedir(), '.codex', 'plugins', 'codex-wechat-bridge');
const defaultStateDb = path.join(installedPluginRoot, 'state', 'bridge.sqlite');
const defaultAppServerUrl = process.env.CODEX_APP_SERVER_URL?.trim() || 'ws://127.0.0.1:4500';
const currentScriptUrl = import.meta.url;
const invokedScriptUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

function parseArgs(argv) {
  const options = {
    dryRun: false,
    useBridgeSession: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--use-bridge-session':
        options.useBridgeSession = true;
        break;
      case '--state-db':
        options.stateDb = argv[++i];
        break;
      case '--account-id':
        options.accountId = argv[++i];
        break;
      case '--peer-user-id':
        options.peerUserId = argv[++i];
        break;
      case '--session-id':
        options.sessionId = argv[++i];
        break;
      case '--session-name':
        options.sessionName = argv[++i];
        break;
      case '--payload-file':
        options.payloadFile = argv[++i];
        break;
      case '--overview':
        options.overview = argv[++i];
        break;
      case '--results':
        options.results = argv[++i];
        break;
      case '--next-step':
        options.nextStep = argv[++i];
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }
  return options;
}

function stripUtf8Bom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readPayloadFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  const raw = stripUtf8Bom(fs.readFileSync(resolvedPath, 'utf8'));
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Payload file must contain a JSON object: ${resolvedPath}`);
  }
  return parsed;
}

function containsNonAscii(value) {
  return typeof value === 'string' && /[^\x00-\x7F]/.test(value);
}

function assertAsciiSafeCliContent(options) {
  const unsafeFlags = [
    ['--overview', options.overview],
    ['--results', options.results],
    ['--next-step', options.nextStep],
    ['--session-name', options.sessionName],
  ].filter(([, value]) => containsNonAscii(value));

  if (unsafeFlags.length === 0) {
    return;
  }

  const flagList = unsafeFlags.map(([flag]) => flag).join(', ');
  throw new Error(
    `Non-ASCII notification content was provided through CLI flags (${flagList}). Use --payload-file with a UTF-8 JSON file instead.`,
  );
}

function mergeOptionsWithPayload(options, payload) {
  return {
    ...payload,
    ...Object.fromEntries(
      Object.entries(options).filter(([, value]) => value !== undefined),
    ),
  };
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing required argument: ${label}`);
  }
  return value.trim();
}

function openDatabase(filePath) {
  return new DatabaseSync(filePath, { open: true });
}

function resolveRuntimePluginRoot(options) {
  if (options.stateDb) {
    return path.dirname(path.dirname(path.resolve(options.stateDb)));
  }
  if (fs.existsSync(path.join(installedPluginRoot, 'dist', 'src', 'cli', 'status.js'))) {
    return installedPluginRoot;
  }
  return bundleRoot;
}

async function loadRuntimeModules(runtimeRoot) {
  const toUrl = (relativePath) => pathToFileURL(path.join(runtimeRoot, relativePath)).href;
  const [
    { loadBridgeConfig },
    { BridgeService },
    { createStateStore },
    { AppServerClient },
    { WebSocketAppServerTransport },
  ] = await Promise.all([
    import(toUrl('dist/src/config/app-config.js')),
    import(toUrl('dist/src/daemon/bridge-service.js')),
    import(toUrl('dist/src/state/sqlite-state-store.js')),
    import(toUrl('dist/src/codex/app-server-client.js')),
    import(toUrl('dist/src/codex/app-server-websocket-transport.js')),
  ]);
  return {
    loadBridgeConfig,
    BridgeService,
    createStateStore,
    AppServerClient,
    WebSocketAppServerTransport,
  };
}

function resolveAccount(db, options) {
  if (options.accountId) {
    const row = db.prepare('select account_id, token, base_url from accounts where account_id = ? and login_state = ?').get(options.accountId, 'active');
    if (!row) {
      throw new Error(`Active account not found: ${options.accountId}`);
    }
    return row;
  }
  const row = db.prepare('select account_id, token, base_url from accounts where login_state = ? order by rowid desc limit 1').get('active');
  if (!row) {
    throw new Error('No active bridge account found.');
  }
  return row;
}

function resolveConversation(db, accountId, options) {
  if (options.peerUserId) {
    const row = db.prepare('select conversation_key, account_id, peer_user_id, runner_thread_id, runner_cwd from conversations where account_id = ? and peer_user_id = ? order by updated_at desc limit 1').get(accountId, options.peerUserId);
    if (!row) {
      throw new Error(`Conversation not found for ${accountId} -> ${options.peerUserId}`);
    }
    return row;
  }
  const row = db.prepare('select conversation_key, account_id, peer_user_id, runner_thread_id, runner_cwd from conversations where account_id = ? order by updated_at desc limit 1').get(accountId);
  if (!row) {
    throw new Error(`No conversation found for account ${accountId}.`);
  }
  return row;
}

function resolveContextToken(db, accountId, peerUserId) {
  const row = db.prepare('select context_token from context_tokens where account_id = ? and peer_user_id = ?').get(accountId, peerUserId);
  if (!row?.context_token) {
    throw new Error(`No context_token found for ${accountId} -> ${peerUserId}`);
  }
  return row.context_token;
}

export function resolveSourceSessionId(options, conversation, env = process.env) {
  const explicitSessionId = options.sessionId?.trim();
  if (explicitSessionId) {
    return explicitSessionId;
  }
  if (options.useBridgeSession) {
    return conversation.runner_thread_id || 'unknown';
  }
  const currentCodexThreadId = env.CODEX_THREAD_ID?.trim();
  if (currentCodexThreadId) {
    return currentCodexThreadId;
  }
  return 'unknown';
}

async function resolveSessionName(options, runtimeModules) {
  const {
    AppServerClient,
    WebSocketAppServerTransport,
  } = runtimeModules;
  if (!options.sessionId || options.sessionId === 'unknown') {
    return options.sessionName?.trim() || 'unknown';
  }
  try {
    const transport = new WebSocketAppServerTransport({ url: defaultAppServerUrl });
    const client = new AppServerClient({
      transport,
      clientInfo: { name: 'codex-wechat-bridge', version: '0.1.0' },
    });
    await client.initialize();
    const sessions = await client.listThreads({ limit: 50 });
    const listed = sessions.find((session) => session.id === options.sessionId);
    if (listed?.name?.trim()) {
      client.close();
      return listed.name.trim();
    }
    const resumed = await client.resumeThread({ threadId: options.sessionId });
    client.close();
    return options.sessionName?.trim() || resumed.name?.trim() || resumed.id || 'unknown';
  } catch {
    return options.sessionName?.trim() || 'unknown';
  }
}

function formatTimestamp() {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function buildMessage({ sessionId, sessionName, overview, results, nextStep }) {
  return [
    '<💡Task Finished>:',
    `- Session ID: ${sessionId}`,
    `- Session Name: ${sessionName}`,
    `- Task Overview: ${overview}`,
    `- Final Results: ${results}`,
    `- Next Step: ${nextStep}`,
    `- Timestamp: ${formatTimestamp()}`,
  ].join('\n');
}

async function main() {
  const parsedOptions = parseArgs(process.argv.slice(2));
  assertAsciiSafeCliContent(parsedOptions);
  const options = parsedOptions.payloadFile
    ? mergeOptionsWithPayload(parsedOptions, readPayloadFile(parsedOptions.payloadFile))
    : parsedOptions;
  const runtimeRoot = resolveRuntimePluginRoot(options);
  const runtimeModules = await loadRuntimeModules(runtimeRoot);
  const overview = requireText(options.overview, '--overview');
  const results = requireText(options.results, '--results');
  const nextStep = requireText(options.nextStep, '--next-step');
  const dbPath = options.stateDb || path.join(runtimeRoot, 'state', 'bridge.sqlite');
  const db = openDatabase(dbPath);
  try {
    const account = resolveAccount(db, options);
    const conversation = resolveConversation(db, account.account_id, options);
    const contextToken = resolveContextToken(db, account.account_id, conversation.peer_user_id);
    const sessionId = resolveSourceSessionId(options, conversation);
    const sessionName = await resolveSessionName({
      sessionId,
      sessionName: options.sessionName,
    }, runtimeModules);
    const text = buildMessage({ sessionId, sessionName, overview, results, nextStep });

    if (options.dryRun) {
      console.log(text);
      return;
    }

    const { loadBridgeConfig, createStateStore, BridgeService } = runtimeModules;
    const config = loadBridgeConfig(runtimeRoot);
    const stateStore = createStateStore({ databasePath: dbPath });
    try {
      const service = new BridgeService({
        ...config,
        workspaceDir: runtimeRoot,
      }, stateStore);
      const result = await service.sendTextMessage({
        accountId: account.account_id,
        peerUserId: conversation.peer_user_id,
        contextToken,
        text,
      });
      console.log(JSON.stringify({
        ok: true,
        messageId: result.messageId,
        status: result.status || 'sent',
        sessionId,
        sessionName,
      }));
    } finally {
      stateStore.close();
    }
  } finally {
    db.close();
  }
}

if (invokedScriptUrl === currentScriptUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
