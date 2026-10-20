import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import matter from "gray-matter";
import { SqliteStore } from "../dist/stores/sqlite-store.js";
import { Vault } from "../dist/vault.js";
import { readEnv } from "./lib/env.mjs";

/** @typedef {{ storePath: string; out?: string; dryRun?: boolean; cwd?: string; env?: NodeJS.ProcessEnv }} ExportOptions */

const within = (parent, child) => {
	const relative = path.relative(parent, child);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const overlaps = (left, right) => within(left, right) || within(right, left);
const defaultOut = (cwd) => path.join(cwd, `vault-export-${crypto.randomUUID()}`);

/** CLI 인수를 엄격히 검증하고 고유한 기본 출력 경로를 정한다. */
export function parseCli(argv, env = process.env, cwd = process.cwd()) {
	const { values, tokens } = parseArgs({ args: argv, strict: true, tokens: true, options: {
		"store-path": { type: "string" }, out: { type: "string" }, "dry-run": { type: "boolean", default: false },
	} });
	const seen = new Set();
	for (const token of tokens) {
		if (token.kind !== "option" || seen.has(token.name)) throw new TypeError("중복 또는 잘못된 인수");
		seen.add(token.name);
	}
	if (!values["store-path"]?.trim() || (values.out !== undefined && !values.out.trim())) throw new TypeError("--store-path <DB> [--out <새 폴더>] [--dry-run] 값은 비울 수 없습니다");
	return { storePath: path.resolve(cwd, values["store-path"]), out: values.out === undefined ? defaultOut(cwd) : path.resolve(cwd, values.out), dryRun: values["dry-run"], cwd, env };
}

/** 출력의 작업 폴더 경계·링크·보호 경로와 빈 디렉터리 조건을 검증한다. */
function validatePaths(storePath, out, cwd, env) {
	const boundary = fs.realpathSync(cwd);
	if (!within(cwd, out) || out === cwd) throw new Error("출력 경로는 작업 폴더 내부의 새 하위 폴더여야 합니다");
	let cursor = cwd;
	for (const component of path.relative(cwd, out).split(path.sep)) {
		cursor = path.join(cursor, component);
		if (!fs.existsSync(cursor)) {
			try { fs.lstatSync(cursor); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
		}
		if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("출력 경로의 링크는 허용하지 않습니다");
		if (!within(boundary, fs.realpathSync(cursor))) throw new Error("출력 실경로가 작업 폴더 경계를 벗어납니다");
	}
	const source = fs.realpathSync(storePath);
	const protectedPaths = [path.dirname(source), path.resolve("D:/BigBrainMemory"), path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "vault")];
	if (path.basename(path.dirname(source)).toLowerCase() === ".bbm") protectedPaths.push(path.dirname(path.dirname(source)));
	const vault = readEnv("ASTRONRAG_VAULT", "BIGBRAIN_VAULT", env);
	if (vault?.trim()) {
		const candidate = path.resolve(cwd, vault);
		protectedPaths.push(candidate);
		if (fs.existsSync(candidate)) protectedPaths.push(fs.realpathSync(candidate));
	}
	const realOut = path.join(boundary, path.relative(cwd, out));
	if (protectedPaths.some((protectedPath) => overlaps(out, protectedPath) || overlaps(realOut, protectedPath))) throw new Error("출력이 원본 DB 또는 운영 vault 보호 경로와 겹칩니다");
	if (fs.existsSync(out) && (!fs.statSync(out).isDirectory() || fs.readdirSync(out).length > 0)) throw new Error("출력 폴더가 비어 있지 않습니다");
	if (!fs.existsSync(path.dirname(out))) throw new Error("출력의 부모 경로가 없습니다");
	if (!fs.statSync(source).isFile()) throw new Error("원본 DB 경로는 파일이어야 합니다");
}

/** Windows와 POSIX에서 안전하고 원래 값과 같은 slug만 허용한다. */
function validateSlug(slug) {
	if (typeof slug !== "string" || !slug || slug === "." || slug === ".." || /[\\/:*?"<>|\x00-\x1f]/.test(slug) || /[. ]$/.test(slug) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(slug) || Buffer.byteLength(`${slug}.md`) > 255) throw new Error("손상되었거나 파일로 표현할 수 없는 slug");
}

/** 기억 필드의 타입과 값 범위를 확인한다. */
function validateRecord(record) {
	if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("손상된 기억 record");
	validateSlug(record.slug);
	for (const field of ["id", "title", "description", "body"]) if (typeof record[field] !== "string") throw new Error("손상된 기억 문자열");
	if (!record.id || !["episodic", "semantic", "procedural", "preference"].includes(record.type) || !["active", "superseded", "archived"].includes(record.status)) throw new Error("손상된 기억 유형·상태");
	for (const field of ["tags", "links", "history"]) if (!Array.isArray(record[field]) || !record[field].every((value) => typeof value === "string")) throw new Error("손상된 기억 배열");
	if (record.derivedFrom !== undefined && (!Array.isArray(record.derivedFrom) || !record.derivedFrom.every((value) => typeof value === "string"))) throw new Error("손상된 기억 출처 배열");
	for (const field of ["source", "project", "reviewAfter", "supersedes", "supersededBy", "archiveReason"]) if (record[field] !== undefined && typeof record[field] !== "string") throw new Error("손상된 기억 선택 필드");
	for (const field of ["created", "updated", "lastAccessed", "lastReinforced"]) if (typeof record[field] !== "string" || !Number.isFinite(Date.parse(record[field]))) throw new Error("손상된 기억 시각");
	if (!Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1 || !Number.isFinite(record.storageStrength) || record.storageStrength < 1 || !Number.isSafeInteger(record.accessCount) || record.accessCount < 0) throw new Error("손상된 기억 수치");
}

/** frontmatter를 강도 반올림 없이 직렬화하고 기존 vault 파서와 동등성을 검사한다. */
function serializeRecord(record, vault) {
	validateRecord(record);
	const fm = {
		id: record.id, title: record.title, description: record.description, type: record.type, tags: record.tags,
		confidence: record.confidence, storage_strength: record.storageStrength, status: record.status,
		created: record.created, updated: record.updated, last_accessed: record.lastAccessed,
		last_reinforced: record.lastReinforced, access_count: record.accessCount, links: record.links, history: record.history,
	};
	for (const [from, to] of Object.entries({ source: "source", project: "project", derivedFrom: "derived_from", reviewAfter: "review_after", supersedes: "supersedes", supersededBy: "superseded_by", archiveReason: "archive_reason" })) {
		if (record[from] !== undefined) fm[to] = record[from];
	}
	const raw = matter.stringify(`\n${record.body}\n`, fm);
	try { assert.deepEqual(JSON.parse(JSON.stringify(vault.parseRawRecord(record.slug, raw).record)), JSON.parse(JSON.stringify(record))); }
	catch { throw new Error("기억을 기존 vault 형식으로 손실 없이 표현할 수 없습니다"); }
	return raw;
}

/** 전체 snapshot을 검증하고 출력 파일 내용을 메모리 안에 준비한다. */
function prepareFiles(snapshot, out) {
	const files = new Map();
	const names = new Set();
	const slugs = new Set();
	const vault = new Vault(out, { readOnly: true });
	const add = (name, bytes) => {
		const folded = name.normalize("NFC").toLowerCase();
		if (names.has(folded)) throw new Error("출력 파일명 충돌");
		names.add(folded);
		files.set(name, bytes);
	};
	for (const item of snapshot.records) {
		const slug = item.record.slug;
		validateSlug(slug);
		const folded = slug.normalize("NFC").toLowerCase();
		if (slugs.has(folded)) throw new Error("기억 slug 충돌");
		slugs.add(folded);
		add(`${item.archived ? "archive" : "memories"}/${slug}.md`, serializeRecord(item.record, vault));
	}
	const revisionNames = new Map();
	for (const item of snapshot.revisions) {
		validateSlug(item.slug);
		if (item.record?.slug !== item.slug || typeof item.created !== "string" || !Number.isFinite(Date.parse(item.created))) throw new Error("손상된 revision record·시각");
		const base = `${item.slug}.${new Date(item.created).toISOString().replace(/[:.]/g, "-")}`;
		const occurrence = (revisionNames.get(base) ?? 0) + 1;
		revisionNames.set(base, occurrence);
		const suffix = String(occurrence).padStart(12, "0");
		const name = `archive/revisions/${base}-${suffix}.md`;
		if (Buffer.byteLength(path.basename(name)) > 255) throw new Error("revision slug 파일명 길이 초과");
		add(name, serializeRecord(item.record, vault));
	}
	for (const event of snapshot.usageEvents) {
		if (typeof event.ts !== "string" || !Number.isFinite(Date.parse(event.ts))) throw new Error("손상된 usage event 시각");
	}
	if (snapshot.usageEvents.length) add(".bbm-usage.jsonl", snapshot.usageEvents.map((event) => JSON.stringify(event)).join("\n") + "\n");
	if (snapshot.embeddings.length > 1) throw new Error("기존 vault 형식은 벡터 모델 하나만 표현할 수 있습니다");
	for (const group of snapshot.embeddings) {
		if (typeof group.model !== "string" || !group.model || group.rows.length === 0) throw new Error("손상된 벡터 모델");
		const dim = group.rows[0].vector.length;
		if (group.rows.some((row) => row.vector.length !== dim)) throw new Error("기존 vault 형식은 같은 모델의 혼합 차원을 표현할 수 없습니다");
		const keys = new Set();
		for (const row of group.rows) {
			if (typeof row.key !== "string" || !/^[am]:.+/.test(row.key) || typeof row.hash !== "string" || keys.has(row.key)) throw new Error("손상된 벡터 키");
			keys.add(row.key);
		}
		const bytes = Buffer.concat(group.rows.map((row) => Buffer.from(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength)));
		add(".bbm-index/vectors.v1.bin", bytes);
		add(".bbm-index/vectors.v1.meta.json", JSON.stringify({ version: 1, model: group.model, dim, keys: group.rows.map((row) => [row.key, row.hash]), bin: crypto.createHash("sha256").update(bytes).digest("hex") }) + "\n");
	}
	return files;
}

/** 읽기 전용 snapshot을 검증한 뒤 배타적으로 새 vault를 내보낸다.
	* @param {ExportOptions} options
	*/
export function exportStoreToVault(options) {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const env = options.env ?? process.env;
	if (typeof options.storePath !== "string" || !options.storePath.trim() || (options.out !== undefined && (typeof options.out !== "string" || !options.out.trim()))) throw new TypeError("DB·출력 경로가 잘못되었습니다");
	const storePath = path.resolve(cwd, options.storePath);
	const out = options.out === undefined ? defaultOut(cwd) : path.resolve(cwd, options.out);
	validatePaths(storePath, out, cwd, env);
	const store = new SqliteStore(cwd, storePath, { readOnly: true });
	let snapshot;
	try { snapshot = store.exportVaultSnapshot(); } finally { store.close(); }
	const files = prepareFiles(snapshot, out);
	const counts = {
		memories: snapshot.records.filter((item) => !item.archived).length,
		archive: snapshot.records.filter((item) => item.archived).length,
		revisions: snapshot.revisions.length, usageEvents: snapshot.usageEvents.length,
		embeddings: snapshot.embeddings.reduce((total, group) => total + group.rows.length, 0),
	};
	if (options.dryRun) return { status: "dry_run", storePath, out, counts };
	const lock = `${out}.export.lock`;
	const parent = path.dirname(out);
	if (!fs.existsSync(parent)) throw new Error("출력의 부모 경로가 없습니다");
	fs.mkdirSync(lock);
	let stage;
	const owned = new Map();
	const directories = new Map();
	const identity = (fp) => { const stat = fs.lstatSync(fp); return { dev: stat.dev, ino: stat.ino }; };
	const same = (fp, expected) => {
		try { const stat = fs.lstatSync(fp); return !stat.isSymbolicLink() && stat.dev === expected.dev && stat.ino === expected.ino; } catch { return false; }
	};
	try {
		validatePaths(storePath, out, cwd, env);
		stage = fs.mkdtempSync(path.join(parent, ".vault-export-"));
		for (const [relative, bytes] of files) {
			const fp = path.join(stage, relative);
			fs.mkdirSync(path.dirname(fp), { recursive: true });
			fs.writeFileSync(fp, bytes, { flag: "wx" });
		}
		validatePaths(storePath, out, cwd, env);
		if (!fs.existsSync(out)) { fs.mkdirSync(out); directories.set(out, identity(out)); }
		const outputIdentity = identity(out);
		for (const [relative] of files) {
			if (!same(out, outputIdentity)) throw new Error("출력 경로가 교체되었습니다");
			const fp = path.join(out, relative);
			let dir = out;
			for (const component of path.dirname(relative).split(/[\\/]/)) {
				if (component === ".") continue;
				dir = path.join(dir, component);
				const own = directories.get(dir);
				if (own) { if (!same(dir, own)) throw new Error("출력 하위 경로가 교체되었습니다"); }
				else { fs.mkdirSync(dir); directories.set(dir, identity(dir)); }
			}
			fs.linkSync(path.join(stage, relative), fp);
			owned.set(fp, identity(fp));
		}
		return { status: "exported", storePath, out, counts };
	} catch (error) {
		for (const [fp, stat] of [...owned].reverse()) if (same(fp, stat)) fs.unlinkSync(fp);
		for (const [dir, stat] of [...directories].reverse()) {
			if (same(dir, stat)) { try { fs.rmdirSync(dir); } catch { /* 다른 파일이 들어온 폴더는 보존한다. */ } }
		}
		throw error;
	} finally {
		try {
			if (stage && within(fs.realpathSync(cwd), path.resolve(stage))) fs.rmSync(stage, { recursive: true, force: true });
		} finally { fs.rmdirSync(lock); }
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { console.log(JSON.stringify(exportStoreToVault(parseCli(process.argv.slice(2))))); }
	catch (error) {
		let reason = "export_failed";
		if (error instanceof SyntaxError || (error instanceof Error && /손상|기억|JSON|vector|revision|vault 형식/.test(error.message))) reason = "invalid_store_data";
		else if (error instanceof Error && /비어 있지/.test(error.message)) reason = "target_not_empty";
		else if (error instanceof Error && /경로|링크|보호/.test(error.message)) reason = "protected_or_invalid_path";
		else if (error instanceof TypeError) reason = "invalid_arguments";
		console.error(JSON.stringify({ status: "failed", reason, message: "내보내기 실패: 인수·보호 경로·빈 대상·DB 무결성·vault 표현 가능 여부를 확인하십시오" }));
		process.exitCode = 2;
	}
}
