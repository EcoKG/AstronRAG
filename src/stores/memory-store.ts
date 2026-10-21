import type { MemoryRecord } from "../types.js";

export interface RecommendationFeedback {
	event_id: string;
	policy_version: string;
	catalog_revision: string;
	rule_id: string;
	model: string;
	effort: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
	role: "research" | "plan" | "impl" | "review" | "ship" | "ops" | "coordinator";
	size?: "small" | "medium" | "large";
	risk: "normal" | "high";
	novelty?: "new" | "existing";
	cross_review_of?: string;
	input_tokens: number;
	output_tokens: number;
	cost_usd: number | null;
	duration_ms: number;
	reverts: number;
	verdict: "pass" | "fail" | "inconclusive";
}
export type RuleStatistics = Record<string, { samples: number; successes: number }>;

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
	/** 사용 이벤트 추가의 제한 시간과 오류 전달 정책을 지정한다. */
	appendUsageEvent(event: Omit<StoreUsageEvent, "ts"> & { ts?: string }, options?: { timeoutMs?: number; throwOnError?: boolean }): void;
	readUsageEvents(): StoreUsageEvent[];
	loadEmbeddings(model: string, expectedDim?: number): StoredEmbedding[];
	replaceEmbeddings(model: string, rows: StoredEmbedding[]): void;
	getMeta(key: string): string | null;
	setMeta(key: string, value: string): void;
	recordRecommendationFeedback?(event: RecommendationFeedback): { duplicate: boolean };
	recommendationFeedbackStats?(policyVersion: string, catalogRevision: string): RuleStatistics;
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
