import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { MemoryRecord, MemoryStatus, MemoryType } from "../types.js";
import { Vault } from "../vault.js";
import { assertSafeSlug, type MemoryIdentity, type MemoryStore, type StoreInspection, type StoreUsageEvent, type StoredEmbedding } from "./memory-store.js";

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

export type VaultImportRecord = { record: MemoryRecord; archived: boolean; hasExplicitId: boolean };
export type VaultImportRevision = { slug: string; created: string; record: MemoryRecord };
export type VaultImportSnapshot = {
	records: VaultImportRecord[];
	revisions: VaultImportRevision[];
	usageEvents: StoreUsageEvent[];
	embeddings: { model: string; rows: StoredEmbedding[] }[];
};
export type VaultImportResult = {
	status: "imported" | "already_migrated" | "verified";
	completedAt: string | null;
	counts: Record<string, number>;
	hashes: { matched: number; mismatches: string[] };
};

const stableRecord = (record: MemoryRecord, archived: boolean): string => JSON.stringify({
	archived,
	record: {
		id: record.id, slug: record.slug, title: record.title, description: record.description,
		type: record.type, tags: record.tags, confidence: record.confidence,
		storageStrength: record.storageStrength, status: record.status, created: record.created,
		updated: record.updated, lastAccessed: record.lastAccessed, lastReinforced: record.lastReinforced,
		accessCount: record.accessCount, source: record.source, project: record.project,
		links: record.links, derivedFrom: record.derivedFrom, reviewAfter: record.reviewAfter,
		supersedes: record.supersedes, supersededBy: record.supersededBy,
		archiveReason: record.archiveReason, history: record.history, body: record.body,
	},
});

const recordHash = (record: MemoryRecord, archived: boolean): string => crypto.createHash("sha256").update(stableRecord(record, archived)).digest("hex");

/** SQLite가 기억 레코드와 부속 데이터를 원자적으로 영속한다. */
export class SqliteStore implements MemoryStore {
	readonly root: string;
	readonly nativeMemoryFiles: string[];
	readonly databasePath: string;
	private readonly db: DatabaseSync;
	private readonly vaultResources: Vault;
	private closed = false;

	constructor(root: string, databasePath = path.join(root, ".bbm", "store.sqlite"), options: { readOnly?: boolean } = {}) {
		this.root = path.resolve(root);
		this.databasePath = path.resolve(databasePath);
		if (!options.readOnly) fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
		this.vaultResources = new Vault(this.root, { readOnly: options.readOnly });
		this.nativeMemoryFiles = this.vaultResources.nativeMemoryFiles;
		this.db = new DatabaseSync(this.databasePath, options.readOnly ? { readOnly: true } : {});
		this.db.function("memory_identity_hash", { deterministic: true }, (value) => crypto.createHash("sha256").update(String(value)).digest("hex"));
		this.db.exec("PRAGMA foreign_keys = ON");
		this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		if (options.readOnly) return;
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

	/** Vault 스냅샷 전체를 하나의 즉시 트랜잭션으로 이관한다. */
	importVaultSnapshot(snapshot: VaultImportSnapshot, options: { merge?: boolean; markerKey: string; beforeCommit?: () => void; skipMarker?: boolean } ): VaultImportResult {
		return this.transaction(() => {
			const marker = this.getMeta(options.markerKey);
			if (marker) return { status: "already_migrated", completedAt: marker, counts: this.importCounts(), hashes: { matched: snapshot.records.length, mismatches: [] } };
			const existing = (this.db.prepare("SELECT COUNT(*) AS count FROM memories").get() as { count: number }).count;
			if (existing > 0 && !options.merge) throw new Error("표식 없는 비어 있지 않은 DB입니다 — --merge가 필요합니다");

			for (const item of snapshot.records) {
				assertSafeSlug(item.record.slug);
				if (item.hasExplicitId) {
					const byId = this.db.prepare("SELECT slug FROM memories WHERE id = ?").get(item.record.id) as { slug: string } | undefined;
					if (byId && byId.slug !== item.record.slug) this.db.prepare("DELETE FROM memories WHERE slug = ?").run(byId.slug);
				}
				const next = item.archived && item.record.status !== "archived" ? { ...item.record, status: "archived" as const } : item.record;
				const current = this.selectRecord(next.slug);
				if (!current || recordHash(current, current.status === "archived") !== recordHash(next, item.archived)) this.writeRecord(next);
			}

			if (!options.merge) this.db.exec("DELETE FROM memory_revisions");
			const revision = this.db.prepare("INSERT INTO memory_revisions(slug, created, record_json) VALUES(?, ?, ?)");
			for (const item of snapshot.revisions) revision.run(item.slug, item.created, JSON.stringify(item.record));
			if (!options.merge) this.db.exec("DELETE FROM usage_events");
			const usage = this.db.prepare("INSERT INTO usage_events(ts, payload) VALUES(?, ?)");
			for (const event of snapshot.usageEvents) usage.run(event.ts, JSON.stringify({ ...event, ts: undefined }));
			if (!options.merge) this.db.exec("DELETE FROM embeddings");
			const embedding = this.db.prepare(`
				INSERT INTO embeddings(model, key, hash, dim, vector, position) VALUES(?, ?, ?, ?, ?, ?)
				ON CONFLICT(model, key) DO UPDATE SET hash=excluded.hash, dim=excluded.dim, vector=excluded.vector, position=excluded.position
			`);
			for (const group of snapshot.embeddings) group.rows.forEach((row, position) => {
				const bytes = new Uint8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
				embedding.run(group.model, row.key, row.hash, row.vector.length, bytes, position);
			});

			const comparison = this.compareVaultSnapshot(snapshot);
			if (comparison.mismatches.length > 0) throw new Error(`이관 대조 불일치: ${comparison.mismatches.join(", ")}`);
			options.beforeCommit?.();
			const completedAt = new Date().toISOString();
			if (!options.skipMarker) this.setMeta(options.markerKey, completedAt);
			return { status: "imported", completedAt: options.skipMarker ? null : completedAt, counts: this.importCounts(), hashes: comparison };
		});
	}

	/** Vault 스냅샷과 현재 SQLite 레코드 해시를 비교한다. */
	compareVaultSnapshot(snapshot: VaultImportSnapshot): { matched: number; mismatches: string[] } {
		const mismatches: string[] = [];
		const compareMultiset = (label: string, expected: string[], actual: string[]): number => {
			const counts = (values: string[]): Map<string, number> => {
				const result = new Map<string, number>();
				for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
				return result;
			};
			const left = counts(expected);
			const right = counts(actual);
			let matched = 0;
			for (const [value, count] of left) matched += Math.min(count, right.get(value) ?? 0);
			if (expected.length !== actual.length || [...new Set([...left.keys(), ...right.keys()])].some((value) => left.get(value) !== right.get(value))) {
				mismatches.push(label);
			}
			return matched;
		};

		const expectedRecords = snapshot.records.map((item) => {
			const expected = item.archived && item.record.status !== "archived" ? { ...item.record, status: "archived" as const } : item.record;
			return `${expected.slug}\u0000${recordHash(expected, item.archived)}`;
		});
		const actualRecords = (this.db.prepare("SELECT slug, status FROM memories ORDER BY slug").all() as { slug: string; status: MemoryRecord["status"] }[])
			.map((row) => {
				const record = this.selectRecord(row.slug);
				return record ? `${row.slug}\u0000${recordHash(record, row.status === "archived")}` : `${row.slug}\u0000missing`;
			});
		const matched = compareMultiset("memories", expectedRecords, actualRecords);

		const expectedRevisions = snapshot.revisions.map((item) => `${item.slug}\u0000${item.created}\u0000${JSON.stringify(item.record)}`);
		const actualRevisions = (this.db.prepare("SELECT slug, created, record_json FROM memory_revisions").all() as { slug: string; created: string; record_json: string }[])
			.map((row) => `${row.slug}\u0000${row.created}\u0000${row.record_json}`);
		compareMultiset("revisions", expectedRevisions, actualRevisions);

		const canonicalEvent = (event: StoreUsageEvent): string => JSON.stringify(Object.keys(event).sort().map((key) => [key, event[key]]));
		compareMultiset("usage_events", snapshot.usageEvents.map(canonicalEvent), this.readUsageEvents().map(canonicalEvent));

		const expectedEmbeddings = snapshot.embeddings.flatMap((group) => group.rows.map((row, position) => {
			const bytes = Buffer.from(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength).toString("base64");
			return `${group.model}\u0000${row.key}\u0000${row.hash}\u0000${row.vector.length}\u0000${position}\u0000${bytes}`;
		}));
		const actualEmbeddings = (this.db.prepare("SELECT model, key, hash, dim, position, vector FROM embeddings").all() as { model: string; key: string; hash: string; dim: number; position: number; vector: Uint8Array }[])
			.map((row) => `${row.model}\u0000${row.key}\u0000${row.hash}\u0000${row.dim}\u0000${row.position}\u0000${Buffer.from(row.vector).toString("base64")}`);
		compareMultiset("embeddings", expectedEmbeddings, actualEmbeddings);
		return { matched, mismatches };
	}

	private importCounts(): Record<string, number> {
		const count = (table: string): number => (this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
		const statuses = this.db.prepare("SELECT status, COUNT(*) AS count FROM memories GROUP BY status ORDER BY status").all() as { status: string; count: number }[];
		return {
			memories: count("memories"),
			statusActive: statuses.find((row) => row.status === "active")?.count ?? 0,
			statusSuperseded: statuses.find((row) => row.status === "superseded")?.count ?? 0,
			statusArchived: statuses.find((row) => row.status === "archived")?.count ?? 0,
			tags: count("memory_tags"),
			links: count("memory_links"),
			history: count("memory_history"),
			derivedFrom: count("memory_derived_from"),
			revisions: count("memory_revisions"),
			usageEvents: count("usage_events"),
			embeddings: count("embeddings"),
		};
	}

	listSlugs(includeArchived = false): { slug: string; archived: boolean }[] {
		const where = includeArchived ? "" : "WHERE status <> 'archived'";
		return (this.db.prepare(`SELECT slug, status FROM memories ${where} ORDER BY slug`).all() as { slug: string; status: string }[])
			.map((row) => ({ slug: row.slug, archived: row.status === "archived" }));
	}

	filePath(_slug: string, _archived = false): string {
		return this.databasePath;
	}

	/** 기억 내용의 해시와 강화 정보 신원을 한 읽기 스냅샷에서 조회한다. */
	getIdentity(slug: string, archived = false): MemoryIdentity | null {
		assertSafeSlug(slug);
		const status = archived ? "AND status = 'archived'" : "AND status <> 'archived'";
		const row = this.db.prepare(`
			SELECT memory_identity_hash(json_array(
				id, slug, title, description, type, confidence, status, created, updated,
				source, project, review_after, supersedes, superseded_by, archive_reason, body,
				(SELECT json_group_array(value) FROM (SELECT value FROM memory_tags WHERE slug = m.slug ORDER BY position)),
				(SELECT json_group_array(value) FROM (SELECT value FROM memory_links WHERE slug = m.slug ORDER BY position)),
				(SELECT json_group_array(value) FROM (SELECT value FROM memory_history WHERE slug = m.slug ORDER BY position)),
				(SELECT json_group_array(value) FROM (SELECT value FROM memory_derived_from WHERE slug = m.slug ORDER BY position))
			)) AS content, json_array(storage_strength, last_accessed, last_reinforced, access_count) AS ranking
			FROM memories AS m WHERE slug = ? ${status}
		`).get(slug) as { content: string; ranking: string } | undefined;
		return row ? ["content", row.content, row.ranking] : null;
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

	/** 제한 시간 지정 시 usage만 별도 연결로 기록하고 즉시 닫는다. */
	appendUsageEvent(event: Omit<StoreUsageEvent, "ts"> & { ts?: string }, options: { timeoutMs?: number; throwOnError?: boolean } = {}): void {
		const ts = event.ts ?? new Date().toISOString();
		const payload = JSON.stringify({ ...event, ts: undefined });
		const deadline = performance.now() + (options.timeoutMs ?? 0);
		for (;;) {
			let db = this.db;
			try {
				if (options.timeoutMs !== undefined) {
					db = new DatabaseSync(this.databasePath);
					db.exec("PRAGMA busy_timeout = 0");
				}
				db.prepare("INSERT INTO usage_events(ts, payload) VALUES(?, ?)").run(ts, payload);
				return;
			} catch (error) {
				const code = (error as { errcode?: number }).errcode;
				if (options.timeoutMs === undefined || (code !== 5 && code !== 6) || performance.now() >= deadline) throw error;
			} finally {
				if (db !== this.db) db.close();
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
		}
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

	/** 하나의 읽기 트랜잭션에서 vault 내보내기용 원본과 순서를 보존한다. */
	exportVaultSnapshot(): VaultImportSnapshot {
		this.db.exec("BEGIN");
		try {
			if (this.db.prepare("PRAGMA foreign_key_check").all().length > 0) throw new Error("손상된 기억 연결");
			const records = (this.db.prepare("SELECT * FROM memories ORDER BY slug").all() as MemoryRow[])
				.map((row) => ({ record: this.rowToRecord(row), archived: row.status === "archived", hasExplicitId: true }));
			const revisions = (this.db.prepare("SELECT slug, created, record_json FROM memory_revisions ORDER BY sequence").all() as { slug: string; created: string; record_json: string }[])
				.map((row) => ({ slug: row.slug, created: row.created, record: JSON.parse(row.record_json) as MemoryRecord }));
			const usageEvents = (this.db.prepare("SELECT ts, payload FROM usage_events ORDER BY sequence").all() as UsageRow[]).map((row) => {
				const event: unknown = JSON.parse(row.payload);
				if (!event || typeof event !== "object" || Array.isArray(event) || ("ts" in event && event.ts !== row.ts)) throw new Error("손상된 usage event JSON");
				return { ...event, ts: row.ts } as StoreUsageEvent;
			});
			const groups = new Map<string, StoredEmbedding[]>();
			const rows = this.db.prepare("SELECT model, key, hash, dim, vector FROM embeddings ORDER BY model, position").all() as (EmbeddingRow & { model: string })[];
			for (const row of rows) {
				if (!Number.isSafeInteger(row.dim) || row.dim <= 0 || !(row.vector instanceof Uint8Array) || row.vector.byteLength !== row.dim * 4) throw new Error("손상된 vector 길이·차원");
				const vector = new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength));
				if (!vector.every(Number.isFinite)) throw new Error("손상된 vector 수치");
				const group = groups.get(row.model) ?? [];
				group.push({ key: row.key, hash: row.hash, vector });
				groups.set(row.model, group);
			}
			const embeddings = [...groups].map(([model, rows]) => ({ model, rows }));
			this.db.exec("COMMIT");
			return { records, revisions, usageEvents, embeddings };
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.db.close();
	}
}
