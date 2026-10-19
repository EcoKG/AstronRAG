import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MemoryRecord, MemoryStatus, MemoryType } from "../types.js";
import { Vault } from "../vault.js";
import { assertSafeSlug, type MemoryStore, type StoreInspection, type StoreUsageEvent, type StoredEmbedding } from "./memory-store.js";

const SCHEMA_VERSION = "1";
const BUSY_TIMEOUT_MS = 5000;
const JOURNAL_MODE = "DELETE";
const RESERVED_BASENAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

type MemoryRow = {
	id: string;
	slug: string;
	title: string;
	description: string;
	type: string;
	confidence: number;
	storage_strength: number;
	status: string;
	created: string;
	updated: string;
	last_accessed: string;
	last_reinforced: string;
	access_count: number;
	source: string | null;
	project: string | null;
	review_after: string | null;
	supersedes: string | null;
	superseded_by: string | null;
	archive_reason: string | null;
	body: string;
};

type UsageRow = { ts: string; payload: string };
type EmbeddingRow = { key: string; hash: string; dim: number; vector: Uint8Array };

/** SQLite가 기억 레코드와 부속 데이터를 원자적으로 영속한다. */
export class SqliteStore implements MemoryStore {
	readonly root: string;
	readonly nativeMemoryFiles: string[];
	readonly databasePath: string;
	private readonly db: DatabaseSync;
	private readonly vaultResources: Vault;
	private closed = false;

	constructor(root: string, databasePath = path.join(root, ".bbm", "store.sqlite")) {
		this.root = path.resolve(root);
		this.databasePath = path.resolve(databasePath);
		fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
		this.vaultResources = new Vault(this.root);
		this.nativeMemoryFiles = this.vaultResources.nativeMemoryFiles;
		this.db = new DatabaseSync(this.databasePath);
		this.db.exec("PRAGMA foreign_keys = ON");
		this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		// DELETE 저널은 SQLite WAL-reset 결함을 피한다. 런타임 SQLite가 3.51.3 이상 또는 3.50.7 백포트가 되면 WAL을 재검토한다: https://www.sqlite.org/wal.html
		this.db.exec(`PRAGMA journal_mode = ${JOURNAL_MODE}`);
		this.initializeSchema();
	}

	private initializeSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS memories (
				slug TEXT PRIMARY KEY,
				id TEXT NOT NULL UNIQUE,
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				type TEXT NOT NULL,
				confidence REAL NOT NULL,
				storage_strength REAL NOT NULL,
				status TEXT NOT NULL,
				created TEXT NOT NULL,
				updated TEXT NOT NULL,
				last_accessed TEXT NOT NULL,
				last_reinforced TEXT NOT NULL,
				access_count INTEGER NOT NULL,
				source TEXT,
				project TEXT,
				review_after TEXT,
				supersedes TEXT,
				superseded_by TEXT,
				archive_reason TEXT,
				body TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS memory_tags (
				slug TEXT NOT NULL REFERENCES memories(slug) ON DELETE CASCADE,
				position INTEGER NOT NULL,
				value TEXT NOT NULL,
				PRIMARY KEY (slug, position)
			);
			CREATE TABLE IF NOT EXISTS memory_links (
				slug TEXT NOT NULL REFERENCES memories(slug) ON DELETE CASCADE,
				position INTEGER NOT NULL,
				value TEXT NOT NULL,
				PRIMARY KEY (slug, position)
			);
			CREATE TABLE IF NOT EXISTS memory_history (
				slug TEXT NOT NULL REFERENCES memories(slug) ON DELETE CASCADE,
				position INTEGER NOT NULL,
				value TEXT NOT NULL,
				PRIMARY KEY (slug, position)
			);
			CREATE TABLE IF NOT EXISTS memory_derived_from (
				slug TEXT NOT NULL REFERENCES memories(slug) ON DELETE CASCADE,
				position INTEGER NOT NULL,
				value TEXT NOT NULL,
				PRIMARY KEY (slug, position)
			);
			CREATE TABLE IF NOT EXISTS memory_revisions (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				slug TEXT NOT NULL,
				created TEXT NOT NULL,
				record_json TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS memory_revisions_slug_sequence ON memory_revisions(slug, sequence DESC);
			CREATE TABLE IF NOT EXISTS usage_events (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				ts TEXT NOT NULL,
				payload TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS embeddings (
				model TEXT NOT NULL,
				key TEXT NOT NULL,
				hash TEXT NOT NULL,
				dim INTEGER NOT NULL,
				vector BLOB NOT NULL,
				position INTEGER NOT NULL,
				PRIMARY KEY (model, key)
			);
			CREATE TABLE IF NOT EXISTS store_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`);
		this.db.prepare("INSERT INTO store_meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO NOTHING").run(SCHEMA_VERSION);
	}

	private transaction<T>(run: () => T): T {
		// 부하 10회 중 BUSY 소진 0회 관측(.astron-logs/cause-final-load-results.log).
		for (let attempt = 0; ; attempt++) {
			try {
				this.db.exec("BEGIN IMMEDIATE");
				break;
			} catch (error) {
				if (attempt >= 2 || !(error instanceof Error) || !/SQLITE_BUSY|database is locked/i.test(error.message)) throw error;
			}
		}
		try {
			const result = run();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				/* 트랜잭션 본문 오류를 보존한다. */
			}
			throw error;
		}
	}

	private childValues(table: "memory_tags" | "memory_links" | "memory_history" | "memory_derived_from", slug: string): string[] {
		return (this.db.prepare(`SELECT value FROM ${table} WHERE slug = ? ORDER BY position`).all(slug) as { value: string }[]).map((row) => row.value);
	}

	private rowToRecord(row: MemoryRow): MemoryRecord {
		const derivedFrom = this.childValues("memory_derived_from", row.slug);
		return {
			id: row.id,
			slug: row.slug,
			title: row.title,
			description: row.description,
			type: row.type as MemoryType,
			tags: this.childValues("memory_tags", row.slug),
			confidence: row.confidence,
			storageStrength: row.storage_strength,
			status: row.status as MemoryStatus,
			created: row.created,
			updated: row.updated,
			lastAccessed: row.last_accessed,
			lastReinforced: row.last_reinforced,
			accessCount: row.access_count,
			source: row.source ?? undefined,
			project: row.project ?? undefined,
			links: this.childValues("memory_links", row.slug),
			derivedFrom: derivedFrom.length > 0 ? derivedFrom : undefined,
			reviewAfter: row.review_after ?? undefined,
			supersedes: row.supersedes ?? undefined,
			supersededBy: row.superseded_by ?? undefined,
			archiveReason: row.archive_reason ?? undefined,
			history: this.childValues("memory_history", row.slug),
			body: row.body,
		};
	}

	private selectRecord(slug: string, archived?: boolean): MemoryRecord | null {
		const status = archived === undefined ? "" : archived ? "AND status = 'archived'" : "AND status <> 'archived'";
		const row = this.db.prepare(`SELECT * FROM memories WHERE slug = ? ${status}`).get(slug) as MemoryRow | undefined;
		return row ? this.rowToRecord(row) : null;
	}

	private writeChildren(table: "memory_tags" | "memory_links" | "memory_history" | "memory_derived_from", slug: string, values: string[]): void {
		this.db.prepare(`DELETE FROM ${table} WHERE slug = ?`).run(slug);
		const insert = this.db.prepare(`INSERT INTO ${table}(slug, position, value) VALUES(?, ?, ?)`);
		values.forEach((value, position) => insert.run(slug, position, value));
	}

	private writeRecord(record: MemoryRecord, exclusive = false): void {
		this.db.prepare(`
			INSERT INTO memories(
				slug, id, title, description, type, confidence, storage_strength, status,
				created, updated, last_accessed, last_reinforced, access_count, source,
				project, review_after, supersedes, superseded_by, archive_reason, body
			) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			${exclusive ? "" : `ON CONFLICT(slug) DO UPDATE SET
				id=excluded.id, title=excluded.title, description=excluded.description, type=excluded.type,
				confidence=excluded.confidence, storage_strength=excluded.storage_strength, status=excluded.status,
				created=excluded.created, updated=excluded.updated, last_accessed=excluded.last_accessed,
				last_reinforced=excluded.last_reinforced, access_count=excluded.access_count, source=excluded.source,
				project=excluded.project, review_after=excluded.review_after, supersedes=excluded.supersedes,
				superseded_by=excluded.superseded_by, archive_reason=excluded.archive_reason, body=excluded.body`}
		`).run(
			record.slug, record.id, record.title, record.description, record.type, record.confidence,
			record.storageStrength, record.status, record.created, record.updated, record.lastAccessed,
			record.lastReinforced, record.accessCount, record.source ?? null, record.project ?? null,
			record.reviewAfter ?? null, record.supersedes ?? null, record.supersededBy ?? null,
			record.archiveReason ?? null, record.body,
		);
		this.writeChildren("memory_tags", record.slug, record.tags);
		this.writeChildren("memory_links", record.slug, record.links);
		this.writeChildren("memory_history", record.slug, record.history);
		this.writeChildren("memory_derived_from", record.slug, record.derivedFrom ?? []);
	}

	listSlugs(includeArchived = false): { slug: string; archived: boolean }[] {
		const where = includeArchived ? "" : "WHERE status <> 'archived'";
		return (this.db.prepare(`SELECT slug, status FROM memories ${where} ORDER BY slug`).all() as { slug: string; status: string }[])
			.map((row) => ({ slug: row.slug, archived: row.status === "archived" }));
	}

	filePath(_slug: string, _archived = false): string {
		return this.databasePath;
	}

	exists(slug: string): boolean {
		assertSafeSlug(slug);
		return this.db.prepare("SELECT 1 AS found FROM memories WHERE slug = ?").get(slug) !== undefined;
	}

	read(slug: string, archived = false): MemoryRecord | null {
		assertSafeSlug(slug);
		return this.selectRecord(slug, archived);
	}

	find(slug: string): { record: MemoryRecord; archived: boolean } | null {
		assertSafeSlug(slug);
		const record = this.selectRecord(slug);
		return record ? { record, archived: record.status === "archived" } : null;
	}

	write(record: MemoryRecord, archived = false): void {
		assertSafeSlug(record.slug);
		const next = archived && record.status !== "archived" ? { ...record, status: "archived" as const } : record;
		this.transaction(() => this.writeRecord(next));
	}

	updateRecord(slug: string, update: (record: MemoryRecord) => MemoryRecord): MemoryRecord | null {
		assertSafeSlug(slug);
		return this.transaction(() => {
			const current = this.selectRecord(slug);
			if (!current) return null;
			const next = update(current);
			if (next.slug !== slug) throw new Error("updateRecord는 slug를 바꿀 수 없습니다");
			this.writeRecord(next);
			return next;
		});
	}

	createNew(record: MemoryRecord): string {
		assertSafeSlug(record.slug);
		const base = record.slug;
		for (let n = 1; n < 1000; n++) {
			const slug = n === 1 ? base : `${base}-${n}`;
			try {
				this.transaction(() => {
					if (this.db.prepare("SELECT 1 FROM memories WHERE slug = ?").get(slug)) throw new Error("slug-exists");
					record.slug = slug;
					this.writeRecord(record, true);
				});
				return slug;
			} catch (error) {
				if (error instanceof Error && (error.message === "slug-exists" || /UNIQUE constraint failed: memories\.slug/.test(error.message))) continue;
				throw error;
			}
		}
		throw new Error(`slug 확보 실패 (1000회 시도): ${base}`);
	}

	snapshotRevision(slug: string, archived: boolean, keep = 3): void {
		assertSafeSlug(slug);
		this.transaction(() => {
			const record = this.selectRecord(slug, archived);
			if (!record) return;
			this.db.prepare("INSERT INTO memory_revisions(slug, created, record_json) VALUES(?, ?, ?)")
				.run(slug, new Date().toISOString(), JSON.stringify(record));
			this.db.prepare(`
				DELETE FROM memory_revisions
				WHERE slug = ? AND sequence NOT IN (
					SELECT sequence FROM memory_revisions WHERE slug = ? ORDER BY sequence DESC LIMIT ?
				)
			`).run(slug, slug, Math.max(0, keep));
		});
	}

	listRevisions(slug: string): string[] {
		assertSafeSlug(slug);
		return (this.db.prepare("SELECT record_json FROM memory_revisions WHERE slug = ? ORDER BY sequence DESC").all(slug) as { record_json: string }[])
			.map((row) => row.record_json);
	}

	moveToArchive(slug: string): void {
		assertSafeSlug(slug);
		this.db.prepare("UPDATE memories SET status = 'archived' WHERE slug = ?").run(slug);
	}

	writeIndex(markdown: string): void {
		this.vaultResources.writeIndex(markdown);
	}

	inspect(): StoreInspection {
		const counts = this.db.prepare(`
			SELECT
				SUM(CASE WHEN status <> 'archived' THEN 1 ELSE 0 END) AS memories,
				SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived
			FROM memories
		`).get() as { memories: number | null; archived: number | null };
		const base = this.vaultResources.inspect();
		return { ...base, memories: counts.memories ?? 0, archived: counts.archived ?? 0 };
	}

	makeSlug(title: string): string {
		let base = title.trim().replace(/[\\/:*?"<>|#^[\]{}]/g, "").replace(/\s+/g, "-").toLowerCase().slice(0, 80);
		base = base.replace(/[. ]+$/, "");
		if (!base) base = "memory";
		if (RESERVED_BASENAMES.test(base)) base = `${base}_`;
		let slug = base;
		for (let n = 2; this.exists(slug); n++) slug = `${base}-${n}`;
		return slug;
	}

	appendUsageEvent(event: Omit<StoreUsageEvent, "ts"> & { ts?: string }): void {
		const ts = event.ts ?? new Date().toISOString();
		this.db.prepare("INSERT INTO usage_events(ts, payload) VALUES(?, ?)").run(ts, JSON.stringify({ ...event, ts: undefined }));
	}

	readUsageEvents(): StoreUsageEvent[] {
		return (this.db.prepare("SELECT ts, payload FROM usage_events ORDER BY sequence").all() as UsageRow[]).map((row) => {
			const event = JSON.parse(row.payload) as Omit<StoreUsageEvent, "ts">;
			return { ...event, ts: row.ts } as StoreUsageEvent;
		});
	}

	loadEmbeddings(model: string, expectedDim?: number): StoredEmbedding[] {
		const rows = this.db.prepare("SELECT key, hash, dim, vector FROM embeddings WHERE model = ? ORDER BY position").all(model) as EmbeddingRow[];
		if (expectedDim && rows.some((row) => row.dim !== expectedDim)) return [];
		return rows.flatMap((row) => {
			if (row.dim <= 0 || row.vector.byteLength !== row.dim * 4) return [];
			const bytes = row.vector;
			return [{
				key: row.key,
				hash: row.hash,
				vector: new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
			}];
		});
	}

	replaceEmbeddings(model: string, rows: StoredEmbedding[]): void {
		this.transaction(() => {
			this.db.prepare("DELETE FROM embeddings WHERE model = ?").run(model);
			const insert = this.db.prepare("INSERT INTO embeddings(model, key, hash, dim, vector, position) VALUES(?, ?, ?, ?, ?, ?)");
			rows.forEach((row, position) => {
				const bytes = new Uint8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
				insert.run(model, row.key, row.hash, row.vector.length, bytes, position);
			});
		});
	}

	getMeta(key: string): string | null {
		const row = this.db.prepare("SELECT value FROM store_meta WHERE key = ?").get(key) as { value: string } | undefined;
		return row?.value ?? null;
	}

	setMeta(key: string, value: string): void {
		this.db.prepare("INSERT INTO store_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
	}

	journalMode(): string {
		const row = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
		return row.journal_mode;
	}

	integrityCheck(): string {
		const row = this.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
		return row.integrity_check;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.db.close();
	}
}
