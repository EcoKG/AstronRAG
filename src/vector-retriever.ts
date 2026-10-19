import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logWarn } from "./log.js";
import { inScope, stripLinkSection, type ScopeFilter } from "./retriever.js";
import type { MemoryStore as Storage } from "./stores/memory-store.js";
import type { MemoryRecord } from "./types.js";

/** 임베딩 모델 — 다국어 e5 small */
export const MODEL_ID = "Xenova/multilingual-e5-small";
/** 모델 가중치 형식 — 8비트 양자화 ONNX */
export const DTYPE = "q8";
/** 벡터로만 들어온 후보의 관련도 점수 = VECTOR_WEIGHT × 코사인 */
export const VECTOR_WEIGHT = 1;
/** 이 코사인 미만인 벡터 결과는 버린다 */
export const VECTOR_MIN_COS = 0.9;
/** 질의 1건의 벡터 결과 상한 */
export const VECTOR_TOP_K = 10;
/** 선택 의존성 패키지 */
export const TRANSFORMERS_PKG = "@huggingface/transformers";
/** 선택 의존성 설치 명령 — BigBrainMemory 설치 디렉터리에서 실행한다 */
export const INSTALL_COMMAND = `npm i --no-save ${TRANSFORMERS_PKG}@^4.3.0`;
/** 모델 파일 캐시 디렉터리 — 저장소·볼트 밖 */
export const MODEL_CACHE_DIR = path.join(os.tmpdir(), "bigbrainmemory-models");
/** 임베딩 저장 파일 — Float32 행렬, 행 순서는 메타의 keys 순서 */
export const VECTOR_BIN = "vectors.v1.bin";
/** 임베딩 메타 파일 — 모델, 차원, 행렬 해시, 항목 키·임베딩 대상 텍스트 해시 */
export const VECTOR_META = "vectors.v1.meta.json";
/** 임베딩 대상에 넣는 본문 앞부분 길이(자) */
const BODY_CHARS = 1000;
/** 한 번에 임베딩하는 문서 수 */
const BATCH = 16;

/** 텍스트 목록을 정규화된 벡터로 바꾼다 — kind 는 e5 접두어("query: "/"passage: ")를 고른다 */
export type Embed = (texts: string[], kind: "query" | "passage") => Promise<Float32Array[]>;
/** 벡터 계층 상태 — 모델·임베딩 준비 중, 준비됨, 쓸 수 없음 */
export type VectorState = "warming" | "ready" | "unavailable";

/** 항목 1건의 임베딩 — 마지막으로 본 레코드(적재 직후엔 null), 임베딩 대상 텍스트 해시, 벡터 */
interface Row {
	record: MemoryRecord | null;
	hash: string;
	vec: Float32Array;
}

/** 임베딩 메타 파일 내용 */
interface Meta {
	version: 1;
	model: string;
	dim: number;
	bin: string;
	keys: [string, string][];
}

/** SHA-256 16진 문자열 */
function sha256(data: string | Uint8Array): string {
	return crypto.createHash("sha256").update(data).digest("hex");
}

/** 기억 1건의 임베딩 대상 텍스트 — 제목·설명·태그·링크 절을 뺀 본문 앞부분 */
export function passageText(m: MemoryRecord): string {
	return [m.title, m.description, m.tags.join(" "), stripLinkSection(m.body).slice(0, BODY_CHARS)].join("\n");
}

/** 메타 파일 내용이 이 형식인지 — 항목 키는 위치 접두만 보고 빈 slug 도 허용한다 */
function validMeta(v: unknown): v is Meta {
	if (!v || typeof v !== "object") return false;
	const d = v as Record<string, unknown>;
	if (d.version !== 1 || typeof d.model !== "string" || typeof d.bin !== "string") return false;
	if (!Number.isInteger(d.dim) || (d.dim as number) <= 0 || !Array.isArray(d.keys)) return false;
	const seen = new Set<string>();
	for (const k of d.keys as unknown[]) {
		if (!Array.isArray(k) || typeof k[0] !== "string" || typeof k[1] !== "string" || !/^[am]:/.test(k[0]) || seen.has(k[0])) return false;
		seen.add(k[0]);
	}
	return true;
}

/** 같은 디렉터리의 임시 파일에 쓴 뒤 rename 으로 교체한다 */
function writeAtomic(fp: string, data: string | Uint8Array): void {
	const tmp = `${fp}.tmp-${process.pid}-${Date.now().toString(36)}`;
	try {
		fs.writeFileSync(tmp, data);
		fs.renameSync(tmp, fp);
	} catch (err) {
		fs.rmSync(tmp, { force: true });
		throw err;
	}
}

/** transformers.js 로 모델을 올려 임베더를 만든다 — 패키지가 없으면 import 가 실패한다 */
export async function loadEmbedder(): Promise<Embed> {
	const spec = TRANSFORMERS_PKG;
	const t = await import(spec);
	t.env.cacheDir = MODEL_CACHE_DIR;
	const extractor = await t.pipeline("feature-extraction", MODEL_ID, { dtype: DTYPE });
	return async (texts, kind) => {
		const out = await extractor(
			texts.map((s) => `${kind}: ${s}`),
			{ pooling: "mean", normalize: true },
		);
		const dim = out.dims[out.dims.length - 1] as number;
		const data = out.data as Float32Array;
		return texts.map((_, i) => data.slice(i * dim, (i + 1) * dim));
	};
}

/**
 * 선택형 벡터 검색기 — 기억마다 임베딩을 두고 질의 임베딩과의 코사인 상위 결과를 낸다.
 * 임베딩은 indexDir 의 vectors.v1.* 에 영속하고, 임베딩 대상 텍스트 해시가 바뀐 기억만 다시 계산한다(모델이 다르면 전체).
 */
export class VectorRetriever {
	private readonly indexDir: string | null;
	private readonly storage: Storage | null;
	state: VectorState = "warming";
	/** unavailable 이 된 사유 */
	reason = "";
	/** 적재·임베딩한 항목 — 마지막 sync 의 항목 순서 */
	private rows = new Map<string, Row>();
	private dim = 0;
	/** 마지막 저장이 실패했으면 다음 sync 가 다시 저장한다 */
	private unsaved = false;
	/** sync 직렬화 — 동시에 불려도 앞 sync 가 끝난 뒤 시작한다 */
	private queue: Promise<unknown> = Promise.resolve();

	/** indexDir 이 null 이면 영속하지 않는다. embed 를 주면 모델을 올리지 않고 그것을 쓴다 */
	constructor(
		target: string | null | Storage,
		private embed: Embed | null = null,
		readonly model = `${MODEL_ID}@${DTYPE}`,
	) {
		if (typeof target === "string" || target === null) {
			this.indexDir = target;
			this.storage = null;
		} else {
			this.indexDir = null;
			this.storage = target;
		}
	}

	/** 모델을 올리고 저장된 임베딩을 적재해 항목과 맞춘 뒤 ready 가 된다 — 실패하면 unavailable */
	async warm(entries: () => { key: string; record: MemoryRecord }[]): Promise<void> {
		try {
			if (!this.embed) this.embed = await loadEmbedder();
		} catch (err) {
			this.state = "unavailable";
			const missing = (err as { code?: string }).code === "ERR_MODULE_NOT_FOUND" && String(err).includes(TRANSFORMERS_PKG);
			this.reason = missing
				? `${TRANSFORMERS_PKG} 가 설치돼 있지 않습니다 — BigBrainMemory 디렉터리에서 \`${INSTALL_COMMAND}\` 를 실행한 뒤 서버를 다시 시작하세요`
				:`모델 로드 실패: ${err instanceof Error ? err.message : String(err)}`;
			return;
		}
		try {
			this.load();
			await this.sync(entries());
			this.state = "ready";
		} catch (err) {
			this.state = "unavailable";
			this.reason = `임베딩 실패: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	/** 저장된 임베딩을 적재한다 — 없거나 형식·모델·크기·해시가 맞지 않으면 빈 상태로 둔다 */
	private load(): void {
		if (this.storage) {
			const rows = this.storage.loadEmbeddings(this.model);
			if (rows.length === 0) return;
			const dim = rows[0].vector.length;
			if (dim === 0 || rows.some((row) => row.vector.length !== dim)) return;
			this.dim = dim;
			this.rows = new Map(rows.map((row) => [row.key, { record: null, hash: row.hash, vec: row.vector }]));
			return;
		}
		if (!this.indexDir) return;
		let meta: unknown;
		let bin: Buffer;
		try {
			meta = JSON.parse(fs.readFileSync(path.join(this.indexDir, VECTOR_META), "utf-8"));
			bin = fs.readFileSync(path.join(this.indexDir, VECTOR_BIN));
		} catch {
			return;
		}
		if (!validMeta(meta) || meta.model !== this.model || bin.length !== meta.keys.length * meta.dim * 4 || sha256(bin) !== meta.bin) {
			logWarn(`벡터 임베딩 파일 불일치(전체 재계산): ${this.indexDir}`);
			return;
		}
		const dim = meta.dim;
		const all = new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length));
		this.dim = dim;
		this.rows = new Map(meta.keys.map(([key, hash], i) => [key, { record: null, hash, vec: all.subarray(i * dim, (i + 1) * dim) }]));
	}

	/** 항목과 맞춘다 — 레코드가 같거나 임베딩 대상 텍스트 해시가 같으면 벡터를 그대로 쓰고, 바뀐 것만 임베딩한 뒤 저장한다 */
	sync(entries: { key: string; record: MemoryRecord }[]): Promise<void> {
		const run = this.queue.then(() => this.syncNow(entries));
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async syncNow(entries: { key: string; record: MemoryRecord }[]): Promise<void> {
		const embed = this.embed;
		if (!embed) throw new Error("임베더가 없다");
		const next = new Map<string, Row>();
		const todo: { key: string; record: MemoryRecord; hash: string; text: string }[] = [];
		for (const { key, record } of entries) {
			const prev = this.rows.get(key);
			if (prev && prev.record === record) {
				next.set(key, prev);
				continue;
			}
			const text = passageText(record);
			const hash = sha256(text);
			if (prev && prev.hash === hash) next.set(key, { ...prev, record });
			else todo.push({ key, record, hash, text });
		}
		for (let i = 0; i < todo.length; i += BATCH) {
			const part = todo.slice(i, i + BATCH);
			const vecs = await embed(
				part.map((t) => t.text),
				"passage",
			);
			part.forEach((t, j) => {
				const vec = vecs[j];
				if (this.dim === 0) this.dim = vec.length;
				if (vec.length !== this.dim) throw new Error(`임베딩 차원 불일치: ${vec.length}/${this.dim}`);
				next.set(t.key, { record: t.record, hash: t.hash, vec });
			});
		}
		const ordered = new Map(entries.map((e) => [e.key, next.get(e.key) as Row]));
		const before = [...this.rows.keys()];
		const changed = todo.length > 0 || ordered.size !== before.length || [...ordered.keys()].some((k, i) => before[i] !== k);
		this.rows = ordered;
		if (changed || this.unsaved) this.persist();
	}

	/** 임베딩 행렬과 메타를 쓴다 — 아직 임베딩한 적이 없으면(차원 미정) 쓰지 않고, 실패는 경고만 남긴다(임베딩은 캐시다) */
	private persist(): void {
		if (this.dim === 0) return;
		if (this.storage) {
			try {
				this.storage.replaceEmbeddings(this.model, [...this.rows].map(([key, row]) => ({ key, hash: row.hash, vector: row.vec })));
				this.unsaved = false;
			} catch (err) {
				this.unsaved = true;
				logWarn(`벡터 임베딩 저장 실패(다음 sync 에 재시도): ${err instanceof Error ? err.message : String(err)}`);
			}
			return;
		}
		if (!this.indexDir) return;
		const dim = this.dim;
		const bin = new Uint8Array(this.rows.size * dim * 4);
		let at = 0;
		for (const r of this.rows.values()) {
			bin.set(new Uint8Array(r.vec.buffer, r.vec.byteOffset, dim * 4), at);
			at += dim * 4;
		}
		const meta: Meta = { version: 1, model: this.model, dim, bin: sha256(bin), keys: [...this.rows].map(([k, r]) => [k, r.hash]) };
		try {
			fs.mkdirSync(this.indexDir, { recursive: true });
			const ignore = path.join(this.indexDir, ".gitignore");
			if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n", "utf-8");
			writeAtomic(path.join(this.indexDir, VECTOR_BIN), bin);
			writeAtomic(path.join(this.indexDir, VECTOR_META), JSON.stringify(meta));
			this.unsaved = false;
		} catch (err) {
			this.unsaved = true;
			logWarn(`벡터 임베딩 저장 실패(다음 sync 에 재시도): ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** 질의 텍스트의 임베딩 */
	async embedQuery(text: string): Promise<Float32Array> {
		if (!this.embed) throw new Error("임베더가 없다");
		return (await this.embed([text], "query"))[0];
	}

	/** 범위 필터와 코사인 하한을 먼저 건 뒤 코사인 상위 k 건(동점은 키 순) — 벡터는 정규화돼 있어 내적이 코사인이다 */
	nearest(qv: Float32Array, filter: ScopeFilter, k: number, minCos = VECTOR_MIN_COS): { key: string; cos: number }[] {
		const out: { key: string; cos: number }[] = [];
		for (const [key, r] of this.rows) {
			const m = r.record;
			if (!m || (filter.type && m.type !== filter.type) || !inScope(m, filter.project)) continue;
			let cos = 0;
			for (let i = 0; i < qv.length; i++) cos += qv[i] * r.vec[i];
			if (cos >= minCos) out.push({ key, cos });
		}
		out.sort((a, b) => b.cos - a.cos || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
		return out.slice(0, Math.max(0, k));
	}
}
