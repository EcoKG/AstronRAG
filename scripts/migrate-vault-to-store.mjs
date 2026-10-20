import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "..");
const { Vault } = await import(pathToFileURL(path.join(repositoryRoot, "dist", "vault.js")).href);
const { SqliteStore } = await import(pathToFileURL(path.join(repositoryRoot, "dist", "stores", "sqlite-store.js")).href);
const { VAULT_IMPORT_COMPLETED_META_KEY } = await import(pathToFileURL(path.join(repositoryRoot, "dist", "stores", "index.js")).href);

/** @typedef {{ path: string; size: number; sha256: string }} Fingerprint */
/** @typedef {{ path: string; kind: string; blocking: boolean; line?: number }} ImportIssue */
/** @typedef {Error & { report?: unknown; changedPaths?: string[] }} MigrationError */
/** @typedef {{ afterBackupCopy?: (context: { backupPath: string; entries: Fingerprint[] }) => void; skipMarker?: boolean; beforeCommit?: () => void }} MigrationHooks */

export const SOURCE_SPECS = Object.freeze([
	{ name: "memories", root: "memories", recursive: false, accept: (name) => name.endsWith(".md") },
	{ name: "archive", root: "archive", recursive: false, accept: (name) => name.endsWith(".md") },
	{ name: "revisions", root: "archive/revisions", recursive: true, accept: (name) => name.endsWith(".md") },
	{ name: "usage", root: "", recursive: false, accept: (name) => name === ".bbm-usage.jsonl" },
	{ name: "vectors", root: ".bbm-index", recursive: false, accept: (name) => name.startsWith("vectors.v1.") },
]);

const slash = (value) => value.split(path.sep).join("/");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const exists = (value) => {
	try { fs.accessSync(value); return true; } catch { return false; }
};

/** @param {string} root @param {string} relativeRoot @param {boolean} recursive @param {(name: string) => boolean} accept @returns {string[]} */
function listFiles(root, relativeRoot, recursive, accept) {
	const base = path.join(root, relativeRoot);
	if (!exists(base)) return [];
	if (fs.lstatSync(base).isSymbolicLink()) throw new Error(`symlink는 허용되지 않습니다: ${slash(relativeRoot)}`);
	return fs.readdirSync(base, { withFileTypes: true }).flatMap((entry) => {
		const absolute = path.join(base, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`symlink는 허용되지 않습니다: ${slash(path.relative(root, absolute))}`);
		if (entry.isDirectory()) return recursive ? listFiles(root, path.relative(root, absolute), true, accept) : [];
		return entry.isFile() && accept(entry.name) ? [slash(path.relative(root, absolute))] : [];
	});
}

function sourceFiles(vault) {
	return SOURCE_SPECS.flatMap((spec) => listFiles(vault, spec.root, spec.recursive, spec.accept)).sort();
}

function quarantineFiles(vault) {
	return listFiles(vault, "quarantine", true, () => true).sort();
}

function fingerprint(vault, files) {
	return files.map((relative) => {
		const absolute = path.join(vault, relative);
		const bytes = fs.readFileSync(absolute);
		return { path: relative, size: bytes.byteLength, sha256: sha256(bytes) };
	});
}

function changedPaths(before, after) {
	const left = new Map(before.map((item) => [item.path, `${item.size}:${item.sha256}`]));
	const right = new Map(after.map((item) => [item.path, `${item.size}:${item.sha256}`]));
	return [...new Set([...left.keys(), ...right.keys()])].filter((key) => left.get(key) !== right.get(key)).sort();
}

export function isWithin(parent, child, pathApi = path) {
	const relative = pathApi.relative(parent, child);
	return relative === "" || (!relative.startsWith(`..${pathApi.sep}`) && relative !== ".." && !pathApi.isAbsolute(relative));
}

function nearestRealPath(value) {
	let current = path.resolve(value);
	let suffix = "";
	while (!exists(current)) {
		suffix = path.join(path.basename(current), suffix);
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	const real = fs.realpathSync(current);
	return path.join(real, suffix);
}

function assertSeparated(label, candidate, protectedPaths) {
	const resolved = nearestRealPath(candidate);
	for (const protectedPath of protectedPaths.map(nearestRealPath)) {
		if (isWithin(protectedPath, resolved) || isWithin(resolved, protectedPath)) throw new TypeError(`${label}는 저장소·vault 내부 또는 조상 경로일 수 없습니다: ${candidate}`);
	}
}

function createBackup(vault, backupPath, entries, afterCopy) {
	fs.mkdirSync(path.join(backupPath, "vault"), { recursive: true });
	for (const item of entries) {
		const target = path.join(backupPath, "vault", item.path);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.copyFileSync(path.join(vault, item.path), target, fs.constants.COPYFILE_EXCL);
	}
	const manifest = { algorithm: "sha256", files: entries };
	fs.writeFileSync(path.join(backupPath, "manifest.sha256.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	afterCopy?.({ backupPath, entries });
	for (const item of entries) {
		const bytes = fs.readFileSync(path.join(backupPath, "vault", item.path));
		if (bytes.byteLength !== item.size || sha256(bytes) !== item.sha256) throw new Error(`백업 manifest 대조 실패: ${item.path}`);
	}
	return manifest;
}

function parseUsage(vault, issues) {
	const fp = path.join(vault, ".bbm-usage.jsonl");
	if (!exists(fp)) return [];
	return fs.readFileSync(fp, "utf8").split(/\r?\n/).flatMap((line, index) => {
		if (!line) return [];
		try {
			const event = JSON.parse(line);
			if (!event || typeof event !== "object" || typeof event.ts !== "string") throw new Error("invalid event");
			return [event];
		} catch {
			issues.push({ path: ".bbm-usage.jsonl", kind: "invalid_usage", line: index + 1, blocking: true });
			return [];
		}
	});
}

function parseEmbeddings(vault, issues) {
	const metaPath = path.join(vault, ".bbm-index", "vectors.v1.meta.json");
	const binPath = path.join(vault, ".bbm-index", "vectors.v1.bin");
	if (!exists(metaPath) && !exists(binPath)) return [];
	try {
		if (!exists(metaPath) || !exists(binPath)) throw new Error("incomplete vectors");
		const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
		const bin = fs.readFileSync(binPath);
		if (meta.version !== 1 || typeof meta.model !== "string" || !Number.isInteger(meta.dim) || meta.dim <= 0 || !Array.isArray(meta.keys)) throw new Error("invalid vectors metadata");
		const seen = new Set();
		for (const key of meta.keys) {
			if (!Array.isArray(key) || key.length !== 2 || typeof key[0] !== "string" || typeof key[1] !== "string" || !/^[am]:/.test(key[0]) || seen.has(key[0])) {
				throw new Error("invalid vector key");
			}
			seen.add(key[0]);
		}
		if (meta.bin !== sha256(bin) || bin.byteLength !== meta.keys.length * meta.dim * 4) throw new Error("invalid vectors payload");
		const values = new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
		return [{ model: meta.model, rows: meta.keys.map(([key, hash], index) => ({ key, hash, vector: values.slice(index * meta.dim, (index + 1) * meta.dim) })) }];
	} catch {
		issues.push({ path: ".bbm-index/vectors.v1.*", kind: "invalid_vectors", blocking: true });
		return [];
	}
}

export function collectVaultSnapshot(vaultPath) {
	const vault = new Vault(vaultPath, { readOnly: true });
	const issues = /** @type {ImportIssue[]} */ (quarantineFiles(vaultPath).map((relative) => ({ path: relative, kind: "quarantined", blocking: false })));
	const records = sourceFiles(vaultPath).filter((name) => /^(memories|archive)\/.*\.md$/.test(name) && !name.startsWith("archive/revisions/")).flatMap((relative) => {
		const archived = relative.startsWith("archive/");
		const slug = path.basename(relative, ".md");
		try {
			return [{ ...vault.parseRawRecord(slug, fs.readFileSync(path.join(vaultPath, relative), "utf8")), archived }];
		} catch {
			issues.push({ path: relative, kind: "invalid_memory", blocking: true });
			return [];
		}
	});
	const revisions = sourceFiles(vaultPath).filter((name) => name.startsWith("archive/revisions/") && name.endsWith(".md")).flatMap((relative) => {
		const filename = path.basename(relative, ".md");
		const slug = filename.replace(/\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?$/, "");
		try {
			const parsed = vault.parseRawRecord(slug, fs.readFileSync(path.join(vaultPath, relative), "utf8"));
			return [{ slug, created: parsed.record.updated, record: parsed.record }];
		} catch {
			issues.push({ path: relative, kind: "invalid_revision", blocking: true });
			return [];
		}
	});
	const usageEvents = parseUsage(vaultPath, issues);
	const embeddings = parseEmbeddings(vaultPath, issues);
	return { snapshot: { records, revisions, usageEvents, embeddings }, issues };
}

function countsFor(snapshot) {
	return {
		memories: snapshot.records.length,
		statusActive: snapshot.records.filter((item) => !item.archived && item.record.status === "active").length,
		statusSuperseded: snapshot.records.filter((item) => !item.archived && item.record.status === "superseded").length,
		statusArchived: snapshot.records.filter((item) => item.archived || item.record.status === "archived").length,
		tags: snapshot.records.reduce((sum, item) => sum + item.record.tags.length, 0),
		links: snapshot.records.reduce((sum, item) => sum + item.record.links.length, 0),
		history: snapshot.records.reduce((sum, item) => sum + item.record.history.length, 0),
		derivedFrom: snapshot.records.reduce((sum, item) => sum + (item.record.derivedFrom?.length || 0), 0),
		revisions: snapshot.revisions.length,
		usageEvents: snapshot.usageEvents.length,
		embeddings: snapshot.embeddings.reduce((sum, item) => sum + item.rows.length, 0),
	};
}

function parseCli(argv, env) {
	let values;
	try {
		({ values } = parseArgs({
			args: argv,
			strict: true,
			options: {
				vault: { type: "string" },
				"store-path": { type: "string" },
				"backup-dir": { type: "string" },
				"dry-run": { type: "boolean", default: false },
				merge: { type: "boolean", default: false },
				verify: { type: "boolean", default: false },
			},
		}));
	} catch (error) {
		throw new TypeError(error instanceof Error ? error.message : String(error));
	}
	for (const key of ["vault", "store-path", "backup-dir"]) {
		if (values[key] !== undefined && values[key].trim() === "") throw new TypeError(`--${key} 값은 비울 수 없습니다`);
	}
	if (!values.vault || !values["store-path"]) {
		throw new Error("사용법: migrate-vault-to-store --vault <경로> --store-path <경로> [--backup-dir <경로>] [--dry-run|--merge|--verify]");
	}
	if (values.verify && (values.merge || values["dry-run"])) throw new TypeError("--verify는 --merge·--dry-run과 함께 쓸 수 없습니다");
	const vault = path.resolve(values.vault);
	const storePath = path.resolve(values["store-path"]);
	let backupPath = values["backup-dir"] ? path.resolve(values["backup-dir"]) : "";
	if (!values.verify && !backupPath) {
		if (!env.LOCALAPPDATA) throw new TypeError("LOCALAPPDATA가 없으면 --backup-dir가 필요합니다");
		backupPath = path.resolve(env.LOCALAPPDATA, "AstronRAG", "backups", new Date().toISOString().replace(/[:.]/g, "-"));
	}
	if (!exists(vault) || !fs.statSync(vault).isDirectory()) throw new TypeError(`vault 디렉터리가 없습니다: ${vault}`);
	if (!values.verify) assertSeparated("backup", backupPath, [repositoryRoot, vault]);
	for (const sourceRoot of ["memories", "archive", ".bbm-index"].map((name) => path.join(vault, name))) {
		if (isWithin(sourceRoot, storePath)) throw new TypeError(`store는 원본 감지 디렉터리 안에 둘 수 없습니다: ${storePath}`);
	}
	return { vault, storePath, backupPath, dryRun: values["dry-run"], merge: values.merge, verify: values.verify };
}

function markedResult(options) {
	if (!exists(options.storePath)) return null;
	let store;
	try {
		store = new SqliteStore(options.vault, options.storePath, { readOnly: true });
		const marker = store.getMeta(VAULT_IMPORT_COMPLETED_META_KEY);
		return marker ? { status: "already_migrated", completedAt: marker } : null;
	} catch {
		return null;
	} finally {
		store?.close();
	}
}

/** @param {MigrationHooks} [hooks] */
export function runMigration(options, hooks = {}) {
	const afterBackupCopy = Reflect.get(hooks, "afterBackupCopy");
	const skipMarker = Reflect.get(hooks, "skipMarker") === true;
	const beforeCommit = Reflect.get(hooks, "beforeCommit");
	if (!options.verify && !options.dryRun) {
		const marked = markedResult(options);
		if (marked) return { ...marked, vault: options.vault, storePath: options.storePath, backupPath: null, sourceFiles: [], counts: {}, hashes: { matched: 0, mismatches: [] }, importIssues: [] };
	}
	const files = sourceFiles(options.vault);
	const initial = fingerprint(options.vault, files);
	if (options.verify) {
		const { snapshot, issues } = collectVaultSnapshot(options.vault);
		if (issues.some((issue) => issue.blocking)) {
			const error = Object.assign(new Error("활성 또는 보조 원본에 파싱할 수 없는 항목이 있습니다"), { report: { importIssues: issues } });
			throw error;
		}
		if (!exists(options.storePath)) throw new Error("검증할 SQLite DB가 없습니다");
		const store = new SqliteStore(options.vault, options.storePath, { readOnly: true });
		try {
			const hashes = store.compareVaultSnapshot(snapshot);
			const report = { status: "verified", completedAt: store.getMeta(VAULT_IMPORT_COMPLETED_META_KEY), vault: options.vault, storePath: options.storePath, backupPath: null, sourceFiles: files, counts: countsFor(snapshot), hashes, importIssues: issues };
			if (hashes.mismatches.length > 0) throw Object.assign(new Error("이관 대조 불일치"), { report });
			return report;
		} finally { store.close(); }
	}
	const backupEntries = fingerprint(options.vault, [...new Set([...files, ...quarantineFiles(options.vault)])].sort());
	createBackup(options.vault, options.backupPath, backupEntries, afterBackupCopy);
	const { snapshot, issues } = collectVaultSnapshot(options.vault);
	if (issues.some((issue) => issue.blocking)) {
		const error = Object.assign(new Error("활성 또는 보조 원본에 파싱할 수 없는 항목이 있습니다"), { report: { importIssues: issues } });
		throw error;
	}
	if (options.dryRun) return { status: "dry_run", completedAt: null, vault: options.vault, storePath: options.storePath, backupPath: options.backupPath, sourceFiles: files, counts: countsFor(snapshot), hashes: { matched: 0, mismatches: [] }, importIssues: issues };

	const store = new SqliteStore(options.vault, options.storePath);
	try {
		const imported = store.importVaultSnapshot(snapshot, {
			merge: options.merge,
			markerKey: VAULT_IMPORT_COMPLETED_META_KEY,
			skipMarker,
			beforeCommit: () => {
				beforeCommit?.();
				const currentFiles = sourceFiles(options.vault);
				const changed = changedPaths(initial, fingerprint(options.vault, currentFiles));
				if (changed.length > 0) {
					const error = Object.assign(new Error(`이관 중 원본이 바뀌었습니다 — 운영 MCP 를 멈추고 다시 실행하십시오\n${changed.join("\n")}`), { changedPaths: changed });
					throw error;
				}
			},
		});
		return { ...imported, vault: options.vault, storePath: options.storePath, backupPath: options.backupPath, sourceFiles: files, importIssues: issues };
	} finally { store.close(); }
}

function emit(report) {
	process.stdout.write(`${JSON.stringify(report)}\n`);
	process.stderr.write(`vault 이관 ${report.status}: memories=${report.counts?.memories ?? 0}, mismatches=${report.hashes?.mismatches?.length ?? 0}, backup=${report.backupPath ?? "없음"}\n`);
}

export function main(argv = process.argv.slice(2), env = process.env) {
	try {
		const options = parseCli(argv, env);
		emit(runMigration(options));
		return 0;
	} catch (error) {
		if (error?.report) process.stdout.write(`${JSON.stringify(error.report)}\n`);
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return error instanceof TypeError ? 2 : 1;
	}
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) process.exitCode = main();
