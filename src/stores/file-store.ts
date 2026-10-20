import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MemoryRecord } from "../types.js";
import { Vault } from "../vault.js";
import { assertSafeSlug, type MemoryIdentity, type MemoryStore, type StoreUsageEvent, type StoredEmbedding, type StoreInspection } from "./memory-store.js";

const USAGE_FILE = ".bbm-usage.jsonl";
const META_FILE = "store-meta.json";
const VECTOR_DIR = ".bbm-index";
const VECTOR_BIN = "vectors.v1.bin";
const VECTOR_META = "vectors.v1.meta.json";
const MAX_USAGE_BYTES = 5 * 1024 * 1024;

type VectorMeta = {
	version: 1;
	model: string;
	dim: number;
	bin: string;
	keys: [string, string][];
};

const hash = (data: Uint8Array): string => crypto.createHash("sha256").update(data).digest("hex");

/** 기존 Markdown 볼트 형식을 저장소 계약에 연결한다. */
export class FileStore implements MemoryStore {
	readonly vault: Vault;
	readonly root: string;
	readonly nativeMemoryFiles: string[];

	constructor(root: string, options: { readOnly?: boolean } = {}) {
		this.vault = new Vault(root, options);
		this.root = this.vault.root;
		this.nativeMemoryFiles = this.vault.nativeMemoryFiles;
	}

	listSlugs(includeArchived = false): { slug: string; archived: boolean }[] {
		return this.vault.listSlugs(includeArchived);
	}

	filePath(slug: string, archived = false): string {
		return this.vault.filePath(slug, archived);
	}

	/** 기억 파일의 inode·수정 시각·크기를 조회한다. */
	getIdentity(slug: string, archived = false): MemoryIdentity | null {
		assertSafeSlug(slug);
		try {
			const st = fs.statSync(this.filePath(slug, archived), { bigint: true, throwIfNoEntry: false });
			return st ? [String(st.ino), String(st.mtimeNs), String(st.size)] : null;
		} catch {
			return null;
		}
	}

	exists(slug: string): boolean {
		return this.vault.exists(slug);
	}

	read(slug: string, archived = false): MemoryRecord | null {
		assertSafeSlug(slug);
		return this.vault.read(slug, archived);
	}

	find(slug: string): { record: MemoryRecord; archived: boolean } | null {
		assertSafeSlug(slug);
		return this.vault.find(slug);
	}

	write(record: MemoryRecord, archived = false): void {
		assertSafeSlug(record.slug);
		this.vault.write(record, archived);
	}

	updateRecord(slug: string, update: (record: MemoryRecord) => MemoryRecord): MemoryRecord | null {
		const found = this.find(slug);
		if (!found) return null;
		const next = update(found.record);
		this.write(next, found.archived);
		return next;
	}

	createNew(record: MemoryRecord): string {
		assertSafeSlug(record.slug);
		return this.vault.createNew(record);
	}

	snapshotRevision(slug: string, archived: boolean, keep = 3): void {
		assertSafeSlug(slug);
		this.vault.snapshotRevision(slug, archived, keep);
	}

	listRevisions(slug: string): string[] {
		assertSafeSlug(slug);
		const dir = path.join(this.root, "archive", "revisions");
		try {
			return fs.readdirSync(dir).filter((name) => name.startsWith(`${slug}.`) && name.endsWith(".md")).sort();
		} catch {
			return [];
		}
	}

	moveToArchive(slug: string): void {
		assertSafeSlug(slug);
		this.vault.moveToArchive(slug);
	}

	writeIndex(markdown: string): void {
		this.vault.writeIndex(markdown);
	}

	inspect(): StoreInspection {
		return this.vault.inspect();
	}

	makeSlug(title: string): string {
		return this.vault.makeSlug(title);
	}

	appendUsageEvent(event: Omit<StoreUsageEvent, "ts"> & { ts?: string }): void {
		const fp = path.join(this.root, USAGE_FILE);
		try {
			if (fs.existsSync(fp) && fs.statSync(fp).size > MAX_USAGE_BYTES) fs.renameSync(fp, `${fp}.old`);
			fs.appendFileSync(fp, `${JSON.stringify({ ...event, ts: event.ts ?? new Date().toISOString() })}\n`, "utf8");
		} catch {
			/* 사용량 계측은 기억 동작을 막지 않는다. */
		}
	}

	readUsageEvents(): StoreUsageEvent[] {
		try {
			return fs.readFileSync(path.join(this.root, USAGE_FILE), "utf8")
				.split(/\r?\n/)
				.filter(Boolean)
				.flatMap((line) => {
					try {
						return [JSON.parse(line) as StoreUsageEvent];
					} catch {
						return [];
					}
				});
		} catch {
			return [];
		}
	}

	loadEmbeddings(model: string, expectedDim?: number): StoredEmbedding[] {
		try {
			const dir = path.join(this.root, VECTOR_DIR);
			const meta = JSON.parse(fs.readFileSync(path.join(dir, VECTOR_META), "utf8")) as VectorMeta;
			const bin = fs.readFileSync(path.join(dir, VECTOR_BIN));
			if (meta.version !== 1 || meta.model !== model || meta.dim <= 0 || (expectedDim && meta.dim !== expectedDim)) return [];
			if (bin.length !== meta.keys.length * meta.dim * 4 || hash(bin) !== meta.bin) return [];
			const values = new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
			return meta.keys.map(([key, rowHash], index) => ({
				key,
				hash: rowHash,
				vector: values.slice(index * meta.dim, (index + 1) * meta.dim),
			}));
		} catch {
			return [];
		}
	}

	replaceEmbeddings(model: string, rows: StoredEmbedding[]): void {
		if (rows.length === 0) {
			const dir = path.join(this.root, VECTOR_DIR);
			fs.rmSync(path.join(dir, VECTOR_BIN), { force: true });
			fs.rmSync(path.join(dir, VECTOR_META), { force: true });
			return;
		}
		const dim = rows[0].vector.length;
		if (dim === 0 || rows.some((row) => row.vector.length !== dim)) throw new Error("임베딩 차원이 일치하지 않습니다");
		const bytes = new Uint8Array(rows.length * dim * 4);
		rows.forEach((row, index) => bytes.set(new Uint8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength), index * dim * 4));
		const dir = path.join(this.root, VECTOR_DIR);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, VECTOR_BIN), bytes);
		const meta: VectorMeta = { version: 1, model, dim, bin: hash(bytes), keys: rows.map((row) => [row.key, row.hash]) };
		fs.writeFileSync(path.join(dir, VECTOR_META), JSON.stringify(meta), "utf8");
	}

	getMeta(key: string): string | null {
		try {
			const data = JSON.parse(fs.readFileSync(path.join(this.root, ".bbm", META_FILE), "utf8")) as Record<string, string>;
			return data[key] ?? null;
		} catch {
			return null;
		}
	}

	setMeta(key: string, value: string): void {
		const dir = path.join(this.root, ".bbm");
		fs.mkdirSync(dir, { recursive: true });
		let data: Record<string, string> = {};
		try {
			data = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), "utf8")) as Record<string, string>;
		} catch {
			data = {};
		}
		data[key] = value;
		fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify(data), "utf8");
	}

	close(): void {}
}
