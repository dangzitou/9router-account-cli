#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const APP_NAME = "9router";
const COLUMNS = new Set([
  "id",
  "provider",
  "authType",
  "name",
  "email",
  "priority",
  "isActive",
  "createdAt",
  "updatedAt",
]);

main().catch((error) => {
  console.error(`Error: ${error?.message || error}`);
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "help";

  if (command === "help" || args.help || args.h) return printHelp();
  if (command === "self-test") return selfTest();

  const dbPath = resolveDbPath(args);

  if (command === "detect") {
    console.log(dbPath);
    return;
  }

  const sqlite = await loadSqlite();
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    applyPragmas(db);
    assertProviderConnectionsTable(db, dbPath);

    if (command === "list") {
      return listConnections(db, args);
    }
    if (command === "import") {
      return importConnections(db, dbPath, args);
    }
    if (command === "delete") {
      return deleteConnection(db, dbPath, args);
    }

    throw new Error(`Unknown command: ${command}`);
  } finally {
    db.close();
  }
}

function printHelp() {
  console.log(`Usage:
  9r-account detect [--db PATH | --data-dir DIR]
  9r-account list [--provider codex] [--db PATH | --data-dir DIR]
  9r-account import <account.json|-> [options]
  9r-account delete <id|email|name> [--provider codex] [options]

Options:
  --db PATH          Use an explicit 9router SQLite DB path
  --data-dir DIR    Use a 9router data dir; DB is DIR/db/data.sqlite
  --provider ID     Default provider for JSON without provider (default: codex)
  --dry-run         Show what would change without writing
  --no-backup       Do not create data.sqlite.bak.<timestamp> before writing
  --activate        Force isActive=true and testStatus=active on imported accounts
  --clear-proxy     Remove providerSpecificData.proxyPoolId on imported accounts
  --json            Print list output as JSON
  --help            Show this help

Examples:
  9r-account import ./codex-account.json --activate --clear-proxy
  cat ./codex-account.json | 9r-account import -
  DATA_DIR=/app/data 9r-account import ./account.json`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("-")) {
      out._.push(arg);
      continue;
    }

    const key = arg.replace(/^-+/, "");
    if (["dry-run", "no-backup", "activate", "clear-proxy", "json", "help", "h"].includes(key)) {
      out[key] = true;
      continue;
    }

    const value = argv[i + 1];
    if (!value || value.startsWith("-")) {
      throw new Error(`Missing value for --${key}`);
    }
    out[key] = value;
    i++;
  }
  return out;
}

async function loadSqlite() {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function emitWarningSilently(warning, ...rest) {
    const name = typeof warning === "object" ? warning?.name : rest[0];
    const message = typeof warning === "string" ? warning : warning?.message;
    if (name === "ExperimentalWarning" && String(message || "").includes("SQLite")) return;
    return originalEmitWarning.call(process, warning, ...rest);
  };
  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function resolveDbPath(args) {
  if (args.db) return path.resolve(String(args.db));
  const dataDir = args["data-dir"] || process.env.DATA_DIR || defaultDataDir();
  return path.join(path.resolve(String(dataDir)), "db", "data.sqlite");
}

function defaultDataDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

function applyPragmas(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
}

function assertProviderConnectionsTable(db, dbPath) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'providerConnections'").get();
  if (!row) {
    throw new Error(`providerConnections table not found in ${dbPath}. Start 9router once to initialize the database.`);
  }
}

function listConnections(db, args) {
  const rows = args.provider
    ? db.prepare("SELECT * FROM providerConnections WHERE provider = ? ORDER BY provider, priority, updatedAt DESC").all(args.provider)
    : db.prepare("SELECT * FROM providerConnections ORDER BY provider, priority, updatedAt DESC").all();

  const connections = rows.map(rowToConn);
  if (args.json) {
    console.log(JSON.stringify(connections.map(redact), null, 2));
    return;
  }

  if (connections.length === 0) {
    console.log("No provider connections found.");
    return;
  }

  for (const c of connections) {
    const status = c.isActive ? "active" : "inactive";
    const test = c.testStatus ? ` test=${c.testStatus}` : "";
    console.log(`${c.provider} ${c.authType} ${c.id} ${c.email || c.name || "-"} priority=${c.priority || "-"} ${status}${test}`);
  }
}

function importConnections(db, dbPath, args) {
  const inputPath = args._[1];
  if (!inputPath) throw new Error("Missing input JSON path. Use '-' to read from stdin.");

  const payload = JSON.parse(readInput(inputPath));
  const items = normalizePayload(payload);
  if (items.length === 0) throw new Error("No account objects found in input.");

  const providerDefault = args.provider || "codex";
  const now = new Date().toISOString();
  const prepared = items.map((item) => normalizeConnectionInput(item, providerDefault, now, args));

  if (args["dry-run"]) {
    for (const item of prepared) {
      const existing = findExisting(db, item);
      console.log(`${existing ? "update" : "insert"} ${item.provider} ${item.authType} ${existing?.id || item.id} ${item.email || item.name || "-"}`);
    }
    return;
  }

  if (!args["no-backup"]) backupDb(dbPath);

  const results = runInTransaction(db, () => {
    const results = [];
    for (const item of prepared) {
      const existing = findExisting(db, item);
      const next = mergeForUpsert(db, existing, item, now);
      upsertConnection(db, next);
      reorderProvider(db, next.provider);
      results.push({ action: existing ? "updated" : "inserted", connection: next });
    }
    return results;
  });

  for (const result of results) {
    const c = result.connection;
    console.log(`${result.action} ${c.provider} ${c.authType} ${c.id} ${c.email || c.name || "-"}`);
    if (c.authType === "oauth" && !c.refreshToken) {
      console.log(`warning ${c.id}: no refreshToken found; this account may stop working after accessToken expiry.`);
    }
  }
}

function deleteConnection(db, dbPath, args) {
  const target = args._[1];
  if (!target) throw new Error("Missing id/email/name to delete.");

  const providerClause = args.provider ? " AND provider = ?" : "";
  const params = args.provider ? [target, target, target, args.provider] : [target, target, target];
  const row = db.prepare(
    `SELECT * FROM providerConnections WHERE (id = ? OR email = ? OR name = ?)${providerClause} LIMIT 1`
  ).get(...params);

  if (!row) {
    console.log(`not found ${target}`);
    return;
  }
  const conn = rowToConn(row);
  if (args["dry-run"]) {
    console.log(`delete ${conn.provider} ${conn.authType} ${conn.id} ${conn.email || conn.name || "-"}`);
    return;
  }

  if (!args["no-backup"]) backupDb(dbPath);
  runInTransaction(db, () => {
    db.prepare("DELETE FROM providerConnections WHERE id = ?").run(conn.id);
    reorderProvider(db, conn.provider);
  });
  console.log(`deleted ${conn.provider} ${conn.authType} ${conn.id} ${conn.email || conn.name || "-"}`);
}

function readInput(inputPath) {
  if (inputPath === "-") {
    return fs.readFileSync(0, "utf8");
  }
  return fs.readFileSync(path.resolve(inputPath), "utf8");
}

function normalizePayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.providerConnections)) return payload.providerConnections;
  if (payload && typeof payload === "object") return [payload];
  return [];
}

function normalizeConnectionInput(input, providerDefault, now, args) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Each account must be a JSON object.");
  }

  const c = { ...input };
  c.provider = c.provider || providerDefault;
  c.authType = c.authType || "oauth";
  c.id = c.id || crypto.randomUUID();
  c.name = c.name || c.email || null;
  c.email = c.email || null;
  c.isActive = c.isActive === undefined ? true : !!c.isActive;
  c.createdAt = c.createdAt || now;
  c.updatedAt = now;

  if (args.activate) {
    c.isActive = true;
    c.testStatus = "active";
    delete c.lastError;
    delete c.lastErrorAt;
    delete c.errorCode;
  }

  if (args["clear-proxy"] && c.providerSpecificData && typeof c.providerSpecificData === "object") {
    c.providerSpecificData = { ...c.providerSpecificData };
    delete c.providerSpecificData.proxyPoolId;
  }

  return c;
}

function findExisting(db, c) {
  let row = db.prepare("SELECT * FROM providerConnections WHERE id = ?").get(c.id);
  if (row) return rowToConn(row);

  if (c.authType === "oauth" && c.email) {
    row = db.prepare("SELECT * FROM providerConnections WHERE provider = ? AND authType = ? AND email = ? LIMIT 1")
      .get(c.provider, c.authType, c.email);
    if (row) return rowToConn(row);
  }

  if (c.authType === "apikey" && c.name) {
    row = db.prepare("SELECT * FROM providerConnections WHERE provider = ? AND authType = ? AND name = ? LIMIT 1")
      .get(c.provider, c.authType, c.name);
    if (row) return rowToConn(row);
  }

  return null;
}

function mergeForUpsert(db, existing, input, now) {
  if (existing) {
    return {
      ...existing,
      ...input,
      id: existing.id,
      createdAt: existing.createdAt || input.createdAt || now,
      updatedAt: now,
    };
  }

  return {
    ...input,
    priority: input.priority || nextPriority(db, input.provider),
    createdAt: input.createdAt || now,
    updatedAt: now,
  };
}

function nextPriority(db, provider) {
  const row = db.prepare("SELECT MAX(priority) AS maxPriority FROM providerConnections WHERE provider = ?").get(provider);
  return Number(row?.maxPriority || 0) + 1;
}

function upsertConnection(db, c) {
  const row = connToRow(c);
  db.prepare(`
    INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      provider = excluded.provider,
      authType = excluded.authType,
      name = excluded.name,
      email = excluded.email,
      priority = excluded.priority,
      isActive = excluded.isActive,
      data = excluded.data,
      updatedAt = excluded.updatedAt
  `).run(
    row.id,
    row.provider,
    row.authType,
    row.name,
    row.email,
    row.priority,
    row.isActive,
    row.data,
    row.createdAt,
    row.updatedAt,
  );
}

function reorderProvider(db, provider) {
  const rows = db.prepare("SELECT * FROM providerConnections WHERE provider = ?").all(provider).map(rowToConn);
  rows.sort((a, b) => {
    const priorityDiff = Number(a.priority || 0) - Number(b.priority || 0);
    if (priorityDiff !== 0) return priorityDiff;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
  const stmt = db.prepare("UPDATE providerConnections SET priority = ? WHERE id = ?");
  rows.forEach((c, index) => stmt.run(index + 1, c.id));
}

function runInTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function rowToConn(row) {
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    priority: row.priority,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function connToRow(c) {
  const rest = {};
  for (const [key, value] of Object.entries(c)) {
    if (!COLUMNS.has(key) && value !== undefined) rest[key] = value;
  }
  return {
    id: c.id,
    provider: c.provider,
    authType: c.authType,
    name: c.name ?? null,
    email: c.email ?? null,
    priority: c.priority ?? null,
    isActive: c.isActive === false ? 0 : 1,
    data: JSON.stringify(rest),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function backupDb(dbPath) {
  if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const backupPath = `${dbPath}.bak.${stamp}`;
  fs.copyFileSync(dbPath, backupPath);
  console.log(`backup ${backupPath}`);
}

function redact(c) {
  const copy = { ...c };
  for (const key of ["apiKey", "accessToken", "refreshToken", "idToken"]) {
    if (copy[key]) copy[key] = "[redacted]";
  }
  return copy;
}

async function selfTest() {
  const sqlite = await loadSqlite();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-account-"));
  const dbPath = path.join(tmpDir, "data.sqlite");
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE providerConnections (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        authType TEXT NOT NULL,
        name TEXT,
        email TEXT,
        priority INTEGER,
        isActive INTEGER DEFAULT 1,
        data TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);

    const now = new Date().toISOString();
    const account = normalizeConnectionInput({
      provider: "codex",
      authType: "oauth",
      email: "test@example.com",
      accessToken: "access-1",
      providerSpecificData: { chatgptPlanType: "free", proxyPoolId: "old-proxy" },
    }, "codex", now, { activate: true, "clear-proxy": true });
    const next = mergeForUpsert(db, null, account, now);
    runInTransaction(db, () => {
      upsertConnection(db, next);
      reorderProvider(db, "codex");
    });

    const again = normalizeConnectionInput({
      provider: "codex",
      authType: "oauth",
      email: "test@example.com",
      accessToken: "access-2",
    }, "codex", now, {});
    const existing = findExisting(db, again);
    runInTransaction(db, () => {
      upsertConnection(db, mergeForUpsert(db, existing, again, now));
    });

    const rows = db.prepare("SELECT * FROM providerConnections").all().map(rowToConn);
    if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}`);
    if (rows[0].accessToken !== "access-2") throw new Error("Expected update to replace accessToken");
    if (rows[0].providerSpecificData?.proxyPoolId) throw new Error("Expected proxyPoolId to be cleared");
    console.log(`self-test ok ${dbPath}`);
  } finally {
    db.close();
  }
}
