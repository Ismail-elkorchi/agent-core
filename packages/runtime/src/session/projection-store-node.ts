import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs, chmodSync, statSync } from 'node:fs';
import path from 'node:path';
import { canonicalJsonString, parseJsonObject, type JsonObject } from '@agent-core/json';
import { publishPrivateFile } from '@agent-core/persistence/node';
import { hashJson } from '@agent-core/persistence';

const MAX_NODE_BYTES = 16 * 1024 * 1024;
const SCHEMA = {
  namespaces: 'CREATE TABLE namespaces (name TEXT PRIMARY KEY) WITHOUT ROWID',
  nodes: 'CREATE TABLE nodes (namespace TEXT NOT NULL, hash TEXT NOT NULL, payload BLOB NOT NULL, UNIQUE(namespace, hash))',
  projection_root: 'CREATE TABLE projection_root (id INTEGER PRIMARY KEY CHECK(id=1), payload BLOB NOT NULL)'
};
interface StoreOwner {active: boolean; database?: DatabaseSync; staged?: string;}

/** Physical storage only. The immutable radix roots and original JSONL remain the validity owners. */
export class SessionIndexCorruptionError extends Error {}
export class SessionIndexStore {
  private readonly context = new AsyncLocalStorage<StoreOwner>();
  constructor(private readonly file: string) {}
  get inScope(): boolean {return this.owner() !== undefined;}
  private owner(): StoreOwner | undefined {const owner = this.context.getStore(); return owner?.active ? owner : undefined;}
  async scope<T>(operation: () => Promise<T>): Promise<T> {
    if (this.owner()) return operation();
    const owner: StoreOwner = {active: true};
    return this.context.run(owner, async () => {
      try {return await operation();} finally {
        owner.active = false;
        const database = owner.database; delete owner.database;
        database?.close();
        if (owner.staged) {await fs.rm(owner.staged, {force: true}); await fs.rm(`${owner.staged}-journal`, {force: true});}
      }
    });
  }
  private use<T>(operation: (database: DatabaseSync) => T): T {
    const owner = this.owner();
    if (owner?.database) return operation(owner.database);
    const file = owner?.staged ?? this.file;
    let exists = true;
    try {statSync(file);} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; exists = false;}
    const database = new DatabaseSync(file, {allowExtension: false, timeout: 0});
    try {
      if (!exists) {
        chmodSync(file, 0o600);
        database.exec(Object.values(SCHEMA).join(';'));
      }
      // Existing files are inspected before CREATE or journal-mode changes, so even a
      // schema-invalid prior database survives a cancelled replacement byte-for-byte.
      const schema = database.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN ('nodes','namespaces','projection_root') AND length(sql)<=1024 LIMIT 4").all();
      if (schema.length !== 3 || schema.some(row => typeof row.name !== 'string' || row.sql !== SCHEMA[row.name as keyof typeof SCHEMA]))
        throw new SessionIndexCorruptionError('Incompatible projection database schema.');
      database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL');
      if (owner) owner.database = database;
      return operation(database);
    } finally {if (!owner?.database) database.close();}
  }
  async prepare(): Promise<void> {await fs.mkdir(path.dirname(this.file), {recursive: true, mode: 0o700});}
  read(namespace: string, hash: string): {value: JsonObject; bytes: number} | undefined {
    return this.use(database => {
      // SQLite evaluates length without returning the blob to JavaScript. Keep both queries in
      // one synchronous connection operation; our index lock excludes projection writers.
      const size = database.prepare('SELECT typeof(payload) AS type, length(payload) AS bytes FROM nodes WHERE namespace=? AND hash=?').get(namespace, hash);
      if (!size) return undefined;
      if (size.type !== 'blob' || typeof size.bytes !== 'number' || size.bytes < 1 || size.bytes > MAX_NODE_BYTES) throw new TypeError('Projection node exceeds its byte bound.');
      const row = database.prepare("SELECT payload FROM nodes WHERE namespace=? AND hash=? AND typeof(payload)='blob' AND length(payload)<=?").get(namespace, hash, MAX_NODE_BYTES);
      if (!(row?.payload instanceof Uint8Array) || row.payload.byteLength !== size.bytes) throw new TypeError('Invalid projection node payload.');
      const value = parseJsonObject(JSON.parse(Buffer.from(row.payload).toString('utf8')), {maxTotalBytes: MAX_NODE_BYTES, maxStringBytes: MAX_NODE_BYTES, maxDepth: 64, maxCollectionEntries: 50_000});
      if (hashJson(value) !== hash) throw new TypeError('Projection node hash mismatch.');
      return {value, bytes: size.bytes};
    });
  }
  write(namespace: string, values: readonly JsonObject[]): void {
    this.transaction(database => {
      database.prepare('INSERT OR IGNORE INTO namespaces(name) VALUES(?)').run(namespace);
      const insert = database.prepare('INSERT OR REPLACE INTO nodes(namespace,hash,payload) VALUES(?,?,?)');
      for (const value of values) {
        const payload = Buffer.from(canonicalJsonString(value));
        if (payload.length > MAX_NODE_BYTES) throw new TypeError('Projection node exceeds its byte bound.');
        insert.run(namespace, hashJson(value), payload);
      }
    });
  }
  remove(namespace: string, hashes: readonly string[]): void {
    if (hashes.length === 0) return;
    this.transaction(database => {const remove = database.prepare('DELETE FROM nodes WHERE namespace=? AND hash=?'); for (const hash of hashes) remove.run(namespace, hash);});
  }
  removeNamespace(namespace: string): void {this.transaction(database => {database.prepare('DELETE FROM nodes WHERE namespace=?').run(namespace); database.prepare('DELETE FROM namespaces WHERE name=?').run(namespace);});}
  retireNamespaces(namespace: string): void {this.use(database => {
    const retired = database.prepare("SELECT substr(name,1,42) AS name, length(name) AS bytes FROM namespaces WHERE name<>'values' AND name<>? LIMIT 65").all(namespace);
    if (retired.length > 64) throw new SessionIndexCorruptionError('Excessive projection namespaces.');
    for (const row of retired) {
      if (typeof row.name !== 'string' || row.bytes !== 41 || !/^main-[a-f0-9-]{36}$/u.test(row.name)) throw new SessionIndexCorruptionError('Invalid projection namespace.');
      this.removeNamespace(row.name);
    }
  });}
  private transaction(operation: (database: DatabaseSync) => void): void {
    this.use(database => {
      if (database.isTransaction) {operation(database); return;}
      database.exec('BEGIN IMMEDIATE');
      try {operation(database); database.exec('COMMIT');} catch (error) {try {database.exec('ROLLBACK');} catch { /* Preserve the transaction failure. */ } throw error;}
    });
  }
  async commit<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!this.owner()) throw new Error('Projection transaction requires scoped ownership.');
    const database = this.use(value => value);
    database.exec('BEGIN IMMEDIATE');
    try {const result = await operation(); signal?.throwIfAborted(); database.exec('COMMIT'); return result;}
    catch (error) {try {database.exec('ROLLBACK');} catch { /* Preserve the transaction failure. */ } throw error;}
  }
  root(): {value: JsonObject; bytes: number} {
    return this.use(database => {
      const size = database.prepare('SELECT typeof(payload) AS type, length(payload) AS bytes FROM projection_root WHERE id=1').get();
      if (size?.type !== 'blob' || typeof size.bytes !== 'number' || size.bytes < 1 || size.bytes > MAX_NODE_BYTES)
        throw new SessionIndexCorruptionError('Missing or oversized projection root.');
      const row = database.prepare("SELECT payload FROM projection_root WHERE id=1 AND typeof(payload)='blob' AND length(payload)<=?").get(MAX_NODE_BYTES);
      if (!(row?.payload instanceof Uint8Array) || row.payload.byteLength !== size.bytes) throw new SessionIndexCorruptionError('Invalid projection root payload.');
      return {value: parseJsonObject(JSON.parse(Buffer.from(row.payload).toString('utf8')), {maxTotalBytes: MAX_NODE_BYTES, maxStringBytes: MAX_NODE_BYTES, maxDepth: 64, maxCollectionEntries: 50_000}), bytes: size.bytes};
    });
  }
  publish(value: JsonObject): void {
    this.use(database => {
      if (!database.isTransaction) throw new Error('Projection publication requires its transaction.');
      const payload = Buffer.from(canonicalJsonString(value));
      if (payload.length > MAX_NODE_BYTES) throw new TypeError('Projection root exceeds its byte bound.');
      database.prepare('INSERT OR REPLACE INTO projection_root(id,payload) VALUES(1,?)').run(payload);
    });
  }
  async completeRepair(signal?: AbortSignal): Promise<void> {
    const owner = this.owner();
    if (!owner?.staged) return;
    owner.database?.close(); delete owner.database;
    const staged = owner.staged;
    // No connection survives the Windows replacement boundary. On failure the canonical
    // path, rather than an assumed rollback, determines whether publication happened.
    signal?.throwIfAborted();
    delete owner.staged;
    try {await publishPrivateFile(staged, this.file);}
    finally {await fs.rm(staged, {force: true}); await fs.rm(`${staged}-journal`, {force: true});}
  }
  async repairStorage(): Promise<void> {
    await this.prepare();
    try {this.use(database => {
      const names = database.prepare('SELECT substr(name,1,42) AS name,length(name) AS bytes FROM namespaces LIMIT 65').all();
      if (names.length > 64 || names.some(row => row.name !== 'values' && (row.bytes !== 41 || typeof row.name !== 'string' || !/^main-[a-f0-9-]{36}$/u.test(row.name)))) throw new SessionIndexCorruptionError('Invalid projection namespaces.');
      const result = database.prepare('PRAGMA quick_check').get(); if (result?.quick_check !== 'ok') throw new Error('Corrupt projection database.');});}
    catch (error) {
      const code = (error as {errcode?: number}).errcode;
      const sqliteCode = code === undefined ? undefined : code & 255;
      if (sqliteCode !== 11 && sqliteCode !== 26 && !(error instanceof SessionIndexCorruptionError) && !(error instanceof Error && error.message === 'Corrupt projection database.')) throw error;
      const owner = this.owner(); owner?.database?.close(); if (owner) delete owner.database;
      if (!owner) throw new Error('Projection repair requires scoped ownership.', {cause: error});
      owner.staged = `${this.file}.rebuild`;
      await fs.rm(owner.staged, {force: true});
      await fs.rm(`${owner.staged}-journal`, {force: true});
    }
  }
}
