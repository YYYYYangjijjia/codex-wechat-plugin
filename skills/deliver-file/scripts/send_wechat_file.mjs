import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { loadBridgeConfig } from "../../../dist/src/config/app-config.js";
import { BridgeService } from "../../../dist/src/daemon/bridge-service.js";
import { createStateStore } from "../../../dist/src/state/sqlite-state-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.resolve(__dirname, "..", "..", "..");
const defaultStateDb = path.join(pluginRoot, "state", "bridge.sqlite");

function parseArgs(argv) {
  const options = {
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--state-db":
        options.stateDb = argv[++index];
        break;
      case "--account-id":
        options.accountId = argv[++index];
        break;
      case "--peer-user-id":
        options.peerUserId = argv[++index];
        break;
      case "--context-token":
        options.contextToken = argv[++index];
        break;
      case "--file":
        options.filePath = argv[++index];
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }
  return options;
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required argument: ${label}`);
  }
  return value.trim();
}

function openDatabase(filePath) {
  return new DatabaseSync(filePath, { open: true });
}

function resolveAccount(db, options) {
  if (options.accountId) {
    const row = db.prepare("select account_id, token, base_url from accounts where account_id = ? and login_state = ?").get(options.accountId, "active");
    if (!row) {
      throw new Error(`Active account not found: ${options.accountId}`);
    }
    return row;
  }
  const row = db.prepare("select account_id, token, base_url from accounts where login_state = ? order by updated_at desc limit 1").get("active");
  if (!row) {
    throw new Error("No active bridge account found.");
  }
  return row;
}

function resolveConversation(db, accountId, options) {
  if (options.peerUserId) {
    const row = db.prepare("select conversation_key, account_id, peer_user_id, updated_at from conversations where account_id = ? and peer_user_id = ? order by updated_at desc limit 1").get(accountId, options.peerUserId);
    if (!row) {
      throw new Error(`Conversation not found for ${accountId} -> ${options.peerUserId}`);
    }
    return row;
  }
  const row = db.prepare("select conversation_key, account_id, peer_user_id, updated_at from conversations where account_id = ? order by updated_at desc limit 1").get(accountId);
  if (!row) {
    throw new Error(`No conversation found for account ${accountId}.`);
  }
  return row;
}

function resolveContextToken(db, accountId, peerUserId, explicitToken) {
  if (explicitToken?.trim()) {
    return explicitToken.trim();
  }
  const row = db.prepare("select context_token from context_tokens where account_id = ? and peer_user_id = ?").get(accountId, peerUserId);
  if (!row?.context_token) {
    throw new Error(`No context_token found for ${accountId} -> ${peerUserId}`);
  }
  return row.context_token;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const filePath = path.resolve(requireText(options.filePath, "--file"));
  const db = openDatabase(options.stateDb || defaultStateDb);
  try {
    const account = resolveAccount(db, options);
    if (!account.token) {
      throw new Error(`Account ${account.account_id} has no usable token.`);
    }
    const conversation = resolveConversation(db, account.account_id, options);
    const contextToken = resolveContextToken(db, account.account_id, conversation.peer_user_id, options.contextToken);

    if (options.dryRun) {
      console.log(JSON.stringify({
        ok: true,
        dryRun: true,
        filePath,
        accountId: account.account_id,
        peerUserId: conversation.peer_user_id,
        conversationKey: conversation.conversation_key,
      }, null, 2));
      return;
    }

    const config = loadBridgeConfig(pluginRoot);
    const stateStore = createStateStore({ databasePath: options.stateDb || defaultStateDb });
    try {
      const service = new BridgeService({
        ...config,
        workspaceDir: pluginRoot,
      }, stateStore);
      const result = await service.sendFileMessage({
        accountId: account.account_id,
        peerUserId: conversation.peer_user_id,
        contextToken,
        filePath,
      });

      console.log(JSON.stringify({
        ok: true,
        filePath,
        kind: result.kind,
        messageId: result.messageId,
        status: result.status || "sent",
        accountId: account.account_id,
        peerUserId: conversation.peer_user_id,
        conversationKey: conversation.conversation_key,
      }));
    } finally {
      stateStore.close();
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
