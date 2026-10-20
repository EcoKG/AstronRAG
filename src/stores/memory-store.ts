import type { MemoryRecord } from "../types.js";

/** 파일의 inode·수정 시각·크기 또는 [content, 내용 해시, 순위 신원]을 나타낸다. */
export type MemoryIdentity = [string, string, string];

export interface StoreUsageEvent {
	ts: string;
	pid?: string;
	tool: string;
	ok: boolean;
	[key: string]: unknown;
}

export interface StoredEmbedding {
	key: string;
	hash: string;
	vector: Float32Array;
}

export interface StoreInspection {
	memories: number;
	archived: number;
	quarantined: number;
	hasMarker: boolean;
}

/** 기억 영속 계층이 제공해야 하는 저장소 중립 계약을 정의한다. */
export interface MemoryStore {
	readonly root: string;
	readonly nativeMemoryFiles: string[];
	listSlugs(includeArchived?: boolean): { slug: string; archived: boolean }[];
	filePath(slug: string, archived?: boolean): string;
	getIdentity?(slug: string, archived?: boolean): MemoryIdentity | null;
	exists(slug: string): boolean;
	read(slug: string, archived?: boolean): MemoryRecord | null;
	find(slug: string): { record: MemoryRecord; archived: boolean } | null;
	write(record: MemoryRecord, archived?: boolean): void;
	updateRecord(slug: string, update: (record: MemoryRecord) => MemoryRecord): MemoryRecord | null;
	createNew(record: MemoryRecord): string;
	snapshotRevision(slug: string, archived: boolean, keep?: number): void;
	listRevisions(slug: string): string[];
	moveToArchive(slug: string): void;
	writeIndex(markdown: string): void;
	inspect(): StoreInspection;
	makeSlug(title: string): string;
	appendUsageEvent(event: Omit<StoreUsageEvent, "ts"> & { ts?: string }): void;
	readUsageEvents(): StoreUsageEvent[];
	loadEmbeddings(model: string, expectedDim?: number): StoredEmbedding[];
	replaceEmbeddings(model: string, rows: StoredEmbedding[]): void;
	getMeta(key: string): string | null;
	setMeta(key: string, value: string): void;
	close(): void;
}

export function assertSafeSlug(slug: string): void {
	if (
		slug.length === 0 ||
		slug === "." ||
		slug === ".." ||
		slug.includes("/") ||
		slug.includes("\\") ||
		/^[A-Za-z]:/.test(slug)
	) {
		throw new Error(`허용되지 않는 slug: ${slug}`);
	}
}
