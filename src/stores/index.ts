import fs from "node:fs";
import path from "node:path";
import { FileStore } from "./file-store.js";
import type { MemoryStore } from "./memory-store.js";
import { SqliteStore } from "./sqlite-store.js";

export type StoreEnvironment = {
	BBM_STORE?: string;
	BBM_SQLITE_PATH?: string;
};

export type StoreFactory = (root: string, env: StoreEnvironment) => MemoryStore;

export const VAULT_IMPORT_COMPLETED_META_KEY = "vault_import_completed_at";

/** 저장소 종류를 생성 함수에 연결해 새 구현을 등록 한 줄로 확장한다. */
export const STORE_FACTORIES: Readonly<Record<string, StoreFactory>> = Object.freeze({
	sqlite: (root, env) => new SqliteStore(root, env.BBM_SQLITE_PATH || path.join(root, ".bbm", "store.sqlite")),
	file: (root) => new FileStore(root),
});

export function createMemoryStore(root: string, env: StoreEnvironment = process.env): MemoryStore {
	const kind = env.BBM_STORE || "sqlite";
	const factory = STORE_FACTORIES[kind];
	if (!factory) throw new Error(`지원하지 않는 BBM_STORE 값: ${kind}`);
	return factory(path.resolve(root), env);
}

function hasLegacyMarkdown(root: string): boolean {
	return ["memories", "archive"].some((name) => {
		try {
			return fs.readdirSync(path.join(root, name), { withFileTypes: true }).some((entry) => entry.isFile() && entry.name.endsWith(".md"));
		} catch {
			return false;
		}
	});
}

function validMigrationTimestamp(value: string | null): boolean {
	if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
	const normalized = value.includes(".") ? value : value.replace(/Z$/, ".000Z");
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === normalized;
}

/** 빈 SQLite와 기존 Markdown이 함께 있으면 명시적 이관 전까지 기억 접근을 막는다. */
export function requiresVaultMigration(store: MemoryStore): boolean {
	if (!(store instanceof SqliteStore)) return false;
	const state = store.inspect();
	if (state.memories + state.archived !== 0) return false;
	if (!hasLegacyMarkdown(store.root)) return false;
	return !validMigrationTimestamp(store.getMeta(VAULT_IMPORT_COMPLETED_META_KEY));
}

export { FileStore } from "./file-store.js";
export type { MemoryStore, StoreInspection, StoreUsageEvent, StoredEmbedding } from "./memory-store.js";
export { SqliteStore } from "./sqlite-store.js";
