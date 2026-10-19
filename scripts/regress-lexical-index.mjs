// T42 회귀 테스트 — 영속 역색인(.bbm-index/lexical.v1.json)이 검색 결과를 바꾸지 않고 디스크 변화를 따라가는지 고정한다.
//
// 사용: node scripts/regress-lexical-index.mjs [--old-dist <구버전 dist 디렉터리>]
//
// 고정하는 성질:
//   1 인덱스 파일과 "*" .gitignore 가 생기고 문서·파일 신원이 실제 파일과 맞는다. 볼트 루트 .gitignore 는 건드리지 않고, 서버 기동이 인덱스를 만든다.
//     slug 가 빈 문자열인 기억(memories/.md)이 있어도 스스로 쓴 인덱스를 손상으로 보지 않는다
//   2 역색인 후보(slug·점수·필드·레코드)가 종전 선형 tokenMatch 비교와 같다 — 새로 만든 인덱스·파일에서 적재한 인덱스 모두 (무작위 대조)
//   3 파일에서 적재한 저장소가 골든 전 질의 × 설정 4종에서 새로 만든 저장소와 같은 출력을 내고, 기억 파일을 다시 읽지 않는다
//   4 손편집(제자리 수정·같은 길이 수정·추가·삭제)이 켜져 있는 저장소와 새 저장소의 다음 질의에 반영되고 인덱스도 갱신된다.
//     켜져 있는 저장소는 인덱스 파일이 지워지거나 낡은 내용으로 덮어써지면 다음 질의에서 다시 쓴다
//   5 다른 프로세스의 remember·revise·forget 이 다음 질의에 반영되고, 동시 쓰기 뒤 새 sync 가 인덱스를 파일과 맞춘다
//   6 손상(잘린 JSON·버전 불일치·형태 불량): 훅 경로는 빈 결과로 건너뛰고 파일을 건드리지 않으며, 서버 경로는 v1 로 재생성한다
//   7 훅 읽기 전용 경로: 인덱스가 최신이면 searchDetailed 와 같고, 인덱스 파일만 읽고 반환 결과만 stat 하며, gray-matter 를 불러오지 않는다.
//     바뀌거나 지워진 파일은 후보에서 빼고 다시 순위화해 limit 을 현재 후보로 채우며, 버린 기억은 남은 결과를 억제하지 않는다.
//     대부분이 낡아도(볼트 사본·일괄 편집) 순위화 횟수는 상수로 묶이고, 사본 볼트에서는 빈 결과다.
//     볼트를 한 바이트도 바꾸지 않는다
//   8 네이티브 메모리 디렉터리에는 .bbm-index 를 만들지 않는다
//   9 (--old-dist 를 줄 때) 구버전 저장소·서버가 .bbm-index 가 있는 볼트에서 정상 동작하고 그 파일을 건드리지 않는다
//
// 라이브 볼트는 건드리지 않는다 — 전부 os.tmpdir() 임시 볼트.

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const { values: args } = parseArgs({ options: { "old-dist": { type: "string" } } });
const oldDist = args["old-dist"] ? path.resolve(args["old-dist"]) : null;
if (oldDist && !fs.existsSync(path.join(oldDist, "store.js"))) {
	console.error(`--old-dist 에 store.js 가 없다: ${oldDist}`);
	process.exit(2);
}

// 사용자 동의어 사전은 모듈 로드 시 병합되므로 import 전에 지운다
delete process.env.BIGBRAIN_SYNONYMS;
const distUrl = (f, dist = path.join(root, "dist")) => pathToFileURL(path.join(dist, f)).href;
const { Vault } = await import(distUrl("vault.js"));
const { MemoryStore, parseQuery, searchPersistedIndex } = await import(distUrl("store.js"));
const { LexicalRetriever, tokenize, tokenMatch, stripLinkSection, inScope, SYNONYM_WEIGHT, INDEX_DIR, INDEX_FILE, INDEX_VERSION } =
	await import(distUrl("retriever.js"));

let failures = 0;
function check(name, cond, detail = "") {
	if (cond) console.log(`  ✔ ${name}`);
	else {
		failures++;
		console.error(`  ✘ ${name} ${detail}`);
	}
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-lexindex-"));
const freshDir = () => fs.mkdtempSync(path.join(tmpRoot, "v-"));

/** 시드 고정 32비트 난수 생성기 (mulberry32) */
function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const NOW = Date.parse("2026-07-01T00:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

/** 볼트에 쓸 완전한 레코드를 만든다 */
function record(slug, o) {
	return {
		id: `mem-${slug}`,
		slug,
		title: o.title,
		description: o.description ?? "",
		type: o.type ?? "semantic",
		tags: o.tags ?? [],
		confidence: o.confidence ?? 0.8,
		storageStrength: o.strength ?? 1,
		status: o.status ?? "active",
		created: o.created ?? iso(NOW - 30 * DAY),
		updated: iso(NOW - DAY),
		lastAccessed: iso(NOW - DAY),
		lastReinforced: o.created ?? iso(NOW - 30 * DAY),
		accessCount: 0,
		project: o.project,
		links: o.links ?? [],
		history: ["2026-06-01: created"],
		body: o.body ?? "",
	};
}

/** 강화를 끈 저장소 — 같은 시각에 같은 질의를 반복해도 결과가 변하지 않게 한다 */
function quietStore(dir, retriever = new LexicalRetriever()) {
	const s = new MemoryStore(new Vault(dir), retriever);
	s.reinforce = () => {};
	return s;
}

const indexPath = (dir) => path.join(dir, INDEX_DIR, INDEX_FILE);
const readIndex = (dir) => JSON.parse(fs.readFileSync(indexPath(dir), "utf8"));
const keyFile = (dir, key) => path.join(dir, key.startsWith("a:") ? "archive" : "memories", `${key.slice(2)}.md`);

/** 파일의 (ino, mtimeNs, size) 문자열 — 인덱스의 stat 과 같은 형식 */
function statOf(fp) {
	const st = fs.statSync(fp, { bigint: true });
	return [String(st.ino), String(st.mtimeNs), String(st.size)];
}

/** 볼트의 기억 파일 키 집합 (m:slug / a:slug) */
function fileKeys(dir) {
	return [["memories", "m"], ["archive", "a"]]
		.flatMap(([d, p]) => fs.readdirSync(path.join(dir, d)).filter((f) => f.endsWith(".md")).map((f) => `${p}:${f.slice(0, -3)}`))
		.sort();
}

/** 디렉터리 전체의 상대 경로 → (sha256, mtimeNs) — 한 바이트·한 번의 쓰기도 드러나게 한다 */
function snapshot(dir) {
	const out = {};
	const walk = (d, rel) => {
		if (!fs.existsSync(d)) return;
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) walk(p, r);
			else out[r] = `${crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")}@${fs.statSync(p, { bigint: true }).mtimeNs}`;
		}
	};
	walk(dir, "");
	return JSON.stringify(Object.keys(out).sort().map((k) => [k, out[k]]));
}

/** 인덱스 문서가 볼트 파일과 키·파일 신원까지 전부 맞는지 */
function indexMatchesFiles(dir) {
	const idx = readIndex(dir);
	const keys = idx.docs.map((d) => d.key).sort();
	return (
		idx.version === INDEX_VERSION &&
		JSON.stringify(keys) === JSON.stringify(fileKeys(dir)) &&
		idx.docs.every((d) => JSON.stringify(d.stat) === JSON.stringify(statOf(keyFile(dir, d.key))))
	);
}

/** 자식 프로세스 모듈 코드 — dir 과 dist 의 Vault·MemoryStore 를 준비한 뒤 body 를 실행한다 */
function childCode(dir, body) {
	return `import { Vault } from ${JSON.stringify(distUrl("vault.js"))};
import { MemoryStore } from ${JSON.stringify(distUrl("store.js"))};
const dir = ${JSON.stringify(dir)};
${body}`;
}

/** 자식 프로세스를 띄워 끝날 때까지 기다린다 — 종료 코드와 stderr 를 돌려준다 */
async function runChild(code) {
	const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (b) => (stderr += b));
	const status = await new Promise((resolve) => child.on("close", resolve));
	return { status, stderr };
}

const slugsOf = (store, q, opts = {}) => store.search(q, { limit: 100, includeLinked: false, ...opts }).map((r) => r.record.slug);

const realNow = Date.now;
Date.now = () => NOW;
try {
	// ── 1. 파일 형식
	console.log("1) 인덱스 파일·.gitignore·서버 기동 (T42)");
	{
		const dir = freshDir();
		const rootIgnore = Buffer.from("local-only\n");
		fs.writeFileSync(path.join(dir, ".gitignore"), rootIgnore);
		const v = new Vault(dir);
		v.write(record("f-one", { title: "apple pie", tags: ["dessert"], description: "sweet apple", body: "apple apple apple apple" }));
		v.write(record("f-two", { title: "banana bread", body: "apple once" }));
		v.write(record("f-arch", { title: "apple archived", status: "archived" }), true);
		const s = quietStore(dir);
		check("질의가 결과를 냄(전제 확인)", slugsOf(s, "apple").length === 3);
		const idx = readIndex(dir);
		check("인덱스 파일 lexical.v1.json 의 version 1", INDEX_FILE === "lexical.v1.json" && idx.version === 1);
		check("문서·파일 신원이 볼트 파일(archive 포함)과 일치", indexMatchesFiles(dir), JSON.stringify(idx.docs.map((d) => d.key)));
		check(
			"문서별 필드 길이·토큰, posting, 어간 사전, 제목+설명 토큰 기록",
			idx.docs.every((d) => d.len.length === 4 && d.len[0] === d.title.length && d.len[3] === d.body.length && Array.isArray(d.titleDesc)) &&
				idx.postings.some(([t, list]) => t === "apple" && list.length >= 9) &&
				idx.stems.length > 0,
		);
		check(".bbm-index/.gitignore 는 \"*\" 한 줄", fs.readFileSync(path.join(dir, INDEX_DIR, ".gitignore"), "utf8") === "*\n");
		check("볼트 루트 .gitignore 바이트 불변", Buffer.compare(rootIgnore, fs.readFileSync(path.join(dir, ".gitignore"))) === 0);
		const before = statOf(indexPath(dir));
		s.search("banana");
		check("볼트가 그대로면 질의가 인덱스를 다시 쓰지 않음", JSON.stringify(before) === JSON.stringify(statOf(indexPath(dir))));

		const bare = freshDir();
		new Vault(bare).write(record("g-one", { title: "grape" }));
		quietStore(bare).search("grape");
		check("볼트 루트 .gitignore 를 새로 만들지 않음", !fs.existsSync(path.join(bare, ".gitignore")) && fs.existsSync(indexPath(bare)));

		const boot = freshDir();
		new Vault(boot).write(record("b-one", { title: "boot fig" }));
		const r = spawnSync(process.execPath, [path.join(root, "dist", "index.js")], {
			env: { ...process.env, BIGBRAIN_VAULT: boot, BBM_STORE: "file", BIGBRAIN_HOOK_CHECK: "0" },
			input: "",
			encoding: "utf8",
			timeout: 30_000,
		});
		check("서버 기동 sync 가 인덱스를 만든다", fs.existsSync(indexPath(boot)) && indexMatchesFiles(boot), (r.stderr ?? "").slice(-300));

		// 파일명이 정확히 ".md" 인 기억은 slug 가 빈 문자열이다 — 서버가 쓴 인덱스를 스스로 손상으로 보면 안 된다
		const dot = freshDir();
		new Vault(dot).write(record("d-one", { title: "dot fig" }));
		fs.writeFileSync(
			path.join(dot, "memories", ".md"),
			"---\nid: mem-dot\ntitle: dotfile damson\ntype: semantic\ncreated: '2026-06-01T00:00:00.000Z'\n---\n\ndamson body\n",
		);
		const dotFound = slugsOf(quietStore(dot), "damson");
		check(
			"slug 가 빈 문자열인 기억(memories/.md)도 검색·색인됨(전제 확인)",
			dotFound.length === 1 && dotFound[0] === "" && readIndex(dot).docs.some((d) => d.key === "m:"),
		);
		const dotStat = JSON.stringify(statOf(indexPath(dot)));
		check(
			"slug 가 빈 문자열인 문서가 있어도 새 저장소가 인덱스를 재생성하지 않음",
			slugsOf(quietStore(dot), "damson").length === 1 && JSON.stringify(statOf(indexPath(dot))) === dotStat,
		);
		check(
			"slug 가 빈 문자열인 문서가 있어도 훅 경로가 인덱스를 읽음",
			searchPersistedIndex(dot, "fig").results.map((x) => x.record.slug).join(",") === "d-one",
		);
	}

	// ── 2. 퍼지 매칭 보존
	console.log("2) 역색인 후보가 종전 선형 tokenMatch 비교와 같다 (T42 퍼지 보존)");
	{
		const STEMS = [
			"모드", "릴리스", "릴리스노트", "서버", "서버리스", "인증", "인증서", "배포", "배포판", "설정", "설정값",
			"캐시", "캐시미스", "부산", "부산물", "검색", "검색어", "검색엔진", "마크", "마크다운",
			"가나", "가나다", "가나다라", "가나다라마", "가나다라마바",
			"cat", "concat", "category", "deploy", "deployment", "deployer", "index", "indexer", "indexes",
			"ab", "abc", "abcd", "abcde", "abcdef", "abcdefg",
		];
		const PARTS = ["", "", "", "", "를", "을", "이", "가", "은", "는", "에서", "으로", "의", "도", "만", "까지", "부터", "이라도"];
		const TYPES = ["semantic", "episodic", "procedural", "preference"];
		const rnd = mulberry32(20260928);
		const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
		const word = () => pick(STEMS) + pick(PARTS);
		const words = (lo, hi) => Array.from({ length: lo + Math.floor(rnd() * (hi - lo + 1)) }, word);
		const dir = freshDir();
		const v = new Vault(dir);
		for (let i = 0; i < 80; i++) {
			const links = rnd() < 0.2 ? `\n\n## 연관 기억\n- [[${word()}]]` : "";
			v.write(
				record(`z-${String(i).padStart(2, "0")}`, {
					title: words(1, 4).join(" "),
					description: words(0, 3).join(" "),
					tags: words(0, 2),
					body: words(0, 14).join(" ") + links,
					type: pick(TYPES),
					project: rnd() < 0.3 ? pick(["p1", "p2"]) : undefined,
					status: rnd() < 0.1 ? "archived" : "active",
				}),
				rnd() < 0.1,
			);
		}
		// 종전 선형 검색 — 항목마다 필드 토큰 전부와 tokenMatch 로 비교한다
		const reference = v.listSlugs(true).map(({ slug, archived }) => {
			const m = v.read(slug, archived);
			return {
				m,
				titleT: tokenize(m.title),
				tagT: tokenize(m.tags.join(" ")),
				descT: tokenize(m.description),
				bodyT: tokenize(stripLinkSection(m.body)),
				titleDescT: tokenize(m.title + " " + m.description),
			};
		});
		let fuzzyHits = 0;
		// 점수는 필드 기여를 제목 → 태그 → 설명 → 본문, 질의 토큰 순으로 더한다 (종전 합산 순서)
		const referenceSearch = (q, filter) =>
			reference.flatMap((e) => {
				const m = e.m;
				if ((filter.type && m.type !== filter.type) || !inScope(m, filter.project)) return [];
				const fields = q.expanded.flatMap((t) => {
					const w = q.exact.has(t) ? 1 : SYNONYM_WEIGHT;
					const fuzzy = (u) => {
						const hit = tokenMatch(t, u);
						if (hit && u !== t) fuzzyHits++;
						return hit;
					};
					let hits = 0;
					for (const u of e.bodyT) {
						if (hits >= 3) break;
						if (fuzzy(u)) hits++;
					}
					return [
						...(e.titleT.some(fuzzy) ? [{ field: "title", token: t, weight: 5 * w }] : []),
						...(e.tagT.some(fuzzy) ? [{ field: "tags", token: t, weight: 4 * w }] : []),
						...(e.descT.some(fuzzy) ? [{ field: "description", token: t, weight: 3 * w }] : []),
						...(hits > 0 ? [{ field: "body", token: t, weight: hits * w }] : []),
					];
				});
				let keyword = 0;
				for (const f of fields) keyword += f.weight;
				return keyword === 0 ? [] : [{ slug: m.slug, score: keyword, fields, record: m, titleDescTokens: e.titleDescT }];
			});
		const built = new LexicalRetriever();
		built.sync(v);
		const loadedVault = new Vault(dir);
		let reads = 0;
		const origRead = loadedVault.read.bind(loadedVault);
		loadedVault.read = (...a) => {
			reads++;
			return origRead(...a);
		};
		const loaded = new LexicalRetriever();
		loaded.sync(loadedVault);
		check("파일에서 적재한 인덱스는 기억 파일을 다시 읽지 않음", reads === 0, `reads=${reads}`);
		let trials = 0;
		let badBuilt = 0;
		let badLoaded = 0;
		let firstBad = "";
		let nonEmpty = 0;
		for (let trial = 0; trial < 500; trial++) {
			const n = 1 + Math.floor(rnd() * 3);
			const toks = Array.from({ length: n }, () => {
				const r = rnd();
				if (r < 0.2) {
					const s = pick(STEMS);
					return s.slice(0, 2 + Math.floor(rnd() * (s.length - 1)));
				}
				return word();
			});
			const q = parseQuery(toks.join(" "));
			for (const filter of [{}, { type: pick(TYPES) }, { project: "p1" }]) {
				trials++;
				const want = JSON.stringify(referenceSearch(q, filter));
				const a = JSON.stringify(built.search(q, Infinity, filter));
				const b = JSON.stringify(loaded.search(q, Infinity, filter));
				if (want !== "[]") nonEmpty++;
				if (a !== want) badBuilt++;
				if (b !== want) badLoaded++;
				if ((a !== want || b !== want) && !firstBad) firstBad = `q=${toks.join(" ")} filter=${JSON.stringify(filter)}`;
			}
		}
		check(`무작위 ${trials}건: 새로 만든 인덱스 = 선형 비교`, badBuilt === 0, `불일치 ${badBuilt}건 ${firstBad}`);
		check(`무작위 ${trials}건: 파일에서 적재한 인덱스 = 선형 비교`, badLoaded === 0, `불일치 ${badLoaded}건 ${firstBad}`);
		check("퍼지 적중(표층이 다른 토큰 일치)과 후보가 있는 질의가 실제로 있음(검사 유효성)", fuzzyHits > 0 && nonEmpty > trials / 3, `fuzzy=${fuzzyHits} nonEmpty=${nonEmpty}`);

		const e = freshDir();
		const ve = new Vault(e);
		ve.write(record("e-mode", { title: "모드 전환" }));
		ve.write(record("e-release", { title: "릴리스 절차" }));
		ve.write(record("e-note", { title: "릴리스노트 작성" }));
		ve.write(record("e-serverless", { title: "서버리스 함수" }));
		const r = new LexicalRetriever();
		r.sync(ve);
		const found = (q) => r.search(parseQuery(q), Infinity, {}).map((c) => c.slug);
		check("\"모드를\" 질의가 \"모드\" 기억을 찾음(조사 흡수)", found("모드를").includes("e-mode"));
		check("\"릴리스노트\" 질의가 \"릴리스\" 기억을 찾음(복합어 접두)", found("릴리스노트").includes("e-release"));
		check("\"릴리스\" 질의가 \"릴리스노트\" 기억을 찾음(복합어 접두)", found("릴리스").includes("e-note"));
		check("\"서버\" 질의가 \"서버리스\" 기억을 끌어오지 않음(단어 경계)", !found("서버").includes("e-serverless"));
	}

	// ── 3. 적재 경로 = 새로 만든 경로 (골든 전 질의)
	console.log("3) 파일에서 적재한 저장소가 골든 전 질의에서 새로 만든 저장소와 같다 (T42)");
	{
		const dir = freshDir();
		fs.cpSync(path.join(root, "eval", "fixture-vault"), dir, { recursive: true });
		const golden = fs
			.readFileSync(path.join(root, "eval", "golden.jsonl"), "utf8")
			.split(/\r?\n/)
			.filter((l) => l.trim() !== "")
			.map((l) => JSON.parse(l).query);
		const configs = [
			{ limit: 1000, includeLinked: false },
			{ limit: 5 },
			{ limit: 1 },
			{ limit: 5, type: "procedural", project: "eval-other" },
		];
		const built = quietStore(dir);
		const want = golden.flatMap((q) => configs.map((o) => JSON.stringify(built.searchDetailed(q, o))));
		check("픽스처 사본에 인덱스 생성", fs.existsSync(indexPath(dir)) && indexMatchesFiles(dir));
		const v = new Vault(dir);
		let reads = 0;
		const origRead = v.read.bind(v);
		v.read = (...a) => {
			reads++;
			return origRead(...a);
		};
		const loaded = new MemoryStore(v, new LexicalRetriever());
		loaded.reinforce = () => {};
		const first = JSON.stringify(loaded.searchDetailed(golden[0], configs[0]));
		check("적재 경로의 첫 질의는 기억 파일을 다시 읽지 않음", reads === 0, `reads=${reads}`);
		const got = golden.flatMap((q, i) => configs.map((o, j) => (i === 0 && j === 0 ? first : JSON.stringify(loaded.searchDetailed(q, o)))));
		const bad = want.filter((w, i) => w !== got[i]).length;
		check(`골든 ${golden.length}질의 × 설정 ${configs.length}종 = ${want.length}건 바이트 동일`, bad === 0 && got.length === want.length, `불일치 ${bad}건`);
	}

	// ── 4. 손편집
	console.log("4) Obsidian 식 손편집이 다음 질의에 반영된다 (T42)");
	{
		const dir = freshDir();
		const v = new Vault(dir);
		v.write(record("h-edit", { title: "apple orchard", body: "fruit" }));
		v.write(record("h-same", { title: "lemon grove", body: "citrus" }));
		v.write(record("h-del", { title: "cherry blossom", body: "tree" }));
		const live = quietStore(dir);
		check("손편집 전: apple → h-edit (전제 확인)", slugsOf(live, "apple").join(",") === "h-edit");
		const fpEdit = keyFile(dir, "m:h-edit");
		const ino = statOf(fpEdit)[0];
		fs.writeFileSync(fpEdit, fs.readFileSync(fpEdit, "utf8").replace("apple orchard", "grapefruit orchard"));
		check("제자리 수정이 실제로 같은 파일(inode)을 고침(전제 확인)", statOf(fpEdit)[0] === ino);
		check("제자리 수정: 새 제목으로 찾음", slugsOf(live, "grapefruit").join(",") === "h-edit");
		check("제자리 수정: 옛 제목으로 안 나옴", slugsOf(live, "apple").length === 0);
		const fpSame = keyFile(dir, "m:h-same");
		const sizeBefore = statOf(fpSame)[2];
		fs.writeFileSync(fpSame, fs.readFileSync(fpSame, "utf8").replace("lemon grove", "melon grove"));
		check("같은 길이 제자리 수정(크기 불변, 전제 확인)", statOf(fpSame)[2] === sizeBefore);
		check("같은 길이 제자리 수정: 새 제목으로 찾음", slugsOf(live, "melon").join(",") === "h-same" && slugsOf(live, "lemon").length === 0);
		fs.writeFileSync(
			keyFile(dir, "m:h-new"),
			"---\nid: mem-h-new\ntitle: kumquat added by hand\ntype: semantic\ncreated: '2026-06-01T00:00:00.000Z'\nupdated: '2026-06-01T00:00:00.000Z'\nlast_accessed: '2026-06-01T00:00:00.000Z'\n---\n\nhand written body\n",
		);
		check("손으로 추가한 파일을 찾음", slugsOf(live, "kumquat").join(",") === "h-new");
		fs.rmSync(keyFile(dir, "m:h-del"));
		check("손으로 삭제한 파일은 안 나옴", slugsOf(live, "cherry").length === 0);
		check("인덱스가 손편집을 반영(키·파일 신원)", indexMatchesFiles(dir));
		const idx = readIndex(dir);
		const titleOf = (key) => idx.docs.find((d) => d.key === key)?.title.join(" ");
		check("인덱스 토큰이 새 제목", titleOf("m:h-edit") === "grapefruit orchard" && titleOf("m:h-same") === "melon grove");
		// 켜져 있던 저장소가 마지막으로 저장한 뒤의 손편집을 새 프로세스가 매니페스트 대조로 잡는다
		const fpNew = keyFile(dir, "m:h-new");
		fs.writeFileSync(fpNew, fs.readFileSync(fpNew, "utf8").replace("kumquat", "tangerine"));
		const fresh = quietStore(dir);
		check("새 저장소: 저장 뒤 손편집도 반영", slugsOf(fresh, "tangerine").join(",") === "h-new" && slugsOf(fresh, "kumquat").length === 0);
		check("새 저장소: 나머지 결과가 켜져 있던 저장소와 같음", ["grapefruit", "melon", "cherry", "orchard"].every((q) => slugsOf(fresh, q).join() === slugsOf(live, q).join()));
		// 켜져 있는 저장소는 기억 파일이 그대로여도, 인덱스 파일이 지워지거나 다른 프로세스가 낡은 내용으로 덮어쓰면 다음 질의에서 되살린다
		const older = fs.readFileSync(indexPath(dir));
		fs.rmSync(path.join(dir, INDEX_DIR), { recursive: true });
		slugsOf(live, "orchard");
		check("켜진 저장소에서 인덱스를 지우면 다음 질의가 다시 만든다", fs.existsSync(indexPath(dir)) && indexMatchesFiles(dir));
		fs.writeFileSync(fpNew, fs.readFileSync(fpNew, "utf8").replace("tangerine", "mandarin"));
		slugsOf(live, "mandarin");
		fs.writeFileSync(indexPath(dir), older);
		slugsOf(live, "orchard");
		check(
			"다른 프로세스가 낡은 인덱스로 덮어써도 켜진 저장소의 다음 질의가 다시 쓴다",
			indexMatchesFiles(dir) && searchPersistedIndex(dir, "mandarin").results.map((x) => x.record.slug).join(",") === "h-new",
		);
	}

	// ── 5. 다른 프로세스의 쓰기
	console.log("5) 다른 프로세스의 쓰기가 다음 질의·sync 에 반영된다 (T42)");
	{
		const dir = freshDir();
		const v = new Vault(dir);
		v.write(record("o-rev", { title: "revise target walnut", body: "old body" }));
		v.write(record("o-forget", { title: "forget target hazelnut", body: "old" }));
		const parent = quietStore(dir);
		check("자식 쓰기 전: 인덱스 생성(전제 확인)", slugsOf(parent, "walnut").join(",") === "o-rev" && fs.existsSync(indexPath(dir)));
		const one = await runChild(
			childCode(
				dir,
				`const s = new MemoryStore(new Vault(dir));
s.remember({ title: "pistachio from child", content: "child body", type: "semantic" });
s.revise("o-rev", { content: "new body almond", reason: "child revise" });
s.forget("o-forget", "child forget");`,
			),
		);
		check("자식 프로세스 성공", one.status === 0, one.stderr.slice(-300));
		check("자식의 remember 가 부모 다음 질의에 보임", slugsOf(parent, "pistachio").length === 1);
		check("자식의 revise 가 부모 다음 질의에 보임", slugsOf(parent, "almond").join(",") === "o-rev");
		const forgotten = parent.search("hazelnut", { includeLinked: false });
		check("자식의 forget 이 부모 다음 질의에 보임(archive)", forgotten.length === 1 && forgotten[0].record.status === "archived");
		check("부모 sync 뒤 인덱스 = 파일", indexMatchesFiles(dir));

		const N = 12;
		// Windows 에서 두 프로세스가 MEMORY.md 를 동시에 rename 하면 EPERM 이 난다(기준점에도 있는 기존 동작, 기억 파일은 이미 만들어진 뒤).
		// 이 절은 역색인을 보므로 그 오류만 건너뛰고 나머지 오류는 그대로 던진다
		const body = (tag) => `const s = new MemoryStore(new Vault(dir));
for (let i = 0; i < ${N}; i++) {
	try {
		s.remember({ title: "concurrent ${tag} " + i + " walnut", content: "race body " + i, type: "semantic" });
	} catch (e) {
		if (!(e.code === "EPERM" && String(e.dest).endsWith("MEMORY.md"))) throw e;
	}
	s.search("walnut concurrent");
}`;
		const [a, b] = await Promise.all([runChild(childCode(dir, body("aa"))), runChild(childCode(dir, body("bb")))]);
		check("동시 자식 둘 성공", a.status === 0 && b.status === 0, (a.stderr + b.stderr).slice(-300));
		const r = new LexicalRetriever();
		r.sync(new Vault(dir));
		check("동시 쓰기 뒤 새 sync 가 인덱스를 파일과 맞춤", indexMatchesFiles(dir));
		check("인덱스 디렉터리에 .tmp- 잔재 없음", !fs.readdirSync(path.join(dir, INDEX_DIR)).some((f) => f.includes(".tmp-")));
		check(`동시 remember ${2 * N}건 전부 검색됨`, slugsOf(parent, "concurrent").length === 2 * N, `got=${slugsOf(parent, "concurrent").length}`);
	}

	// ── 6. 손상
	console.log("6) 인덱스 손상: 훅은 건너뛰고 서버는 재생성한다 (T42)");
	{
		const dir = freshDir();
		const v = new Vault(dir);
		for (let i = 0; i < 6; i++) v.write(record(`c-${i}`, { title: `corrupt check olive ${i}`, body: i % 2 ? "olive oil" : "plain" }));
		const q = "olive";
		const want = JSON.stringify(quietStore(dir).searchDetailed(q, { limit: 10, includeLinked: false }));
		const good = fs.readFileSync(indexPath(dir), "utf8");
		const parsed = JSON.parse(good);
		const variants = [
			["잘린 JSON", good.slice(0, Math.floor(good.length / 2))],
			["버전 불일치(999)", JSON.stringify({ ...parsed, version: 999 })],
			["형태 불량(docs 가 객체)", JSON.stringify({ ...parsed, docs: {} })],
			["posting 이 없는 문서 위치", JSON.stringify({ ...parsed, postings: [["olive", [999, 0, 1]]] })],
		];
		for (const [label, text] of variants) {
			fs.writeFileSync(indexPath(dir), text);
			const bytes = fs.readFileSync(indexPath(dir));
			const st = JSON.stringify(statOf(indexPath(dir)));
			const hook = searchPersistedIndex(dir, q, { limit: 10 });
			check(`${label}: 훅 경로는 빈 결과`, hook.results.length === 0 && hook.totalMatched === 0);
			check(
				`${label}: 훅 경로는 인덱스 파일을 건드리지 않음`,
				Buffer.compare(bytes, fs.readFileSync(indexPath(dir))) === 0 && st === JSON.stringify(statOf(indexPath(dir))),
			);
			const got = JSON.stringify(quietStore(dir).searchDetailed(q, { limit: 10, includeLinked: false }));
			check(`${label}: 서버 경로 결과가 정상 인덱스와 같음`, got === want);
			check(`${label}: 서버 경로가 인덱스를 v1 로 재생성`, indexMatchesFiles(dir));
			check(`${label}: 격리(quarantine) 없음`, !fs.existsSync(path.join(dir, "quarantine")));
		}
	}

	// ── 7. 훅 읽기 전용 경로
	console.log("7) 훅 읽기 전용 경로 (T42, 문서 10절)");
	{
		const dir = freshDir();
		const v = new Vault(dir);
		v.write(record("k-a", { title: "hook alpha quince", links: ["k-b"], body: "alpha body" }));
		v.write(record("k-b", { title: "hook beta", body: "quince mention", project: "p1" }));
		v.write(record("k-c", { title: "quince procedure", type: "procedural", body: "steps" }));
		v.write(record("k-d", { title: "quince old", status: "archived" }), true);
		v.write(record("k-e", { title: "hook epsilon quince", description: "quince twice", body: "quince quince quince quince" }));
		const s = quietStore(dir);
		s.search("quince");
		const cases = [
			{ q: "quince", o: {} },
			{ q: "quince", o: { limit: 2 } },
			{ q: "quince hook", o: { type: "procedural" } },
			{ q: "quince", o: { project: "p1" } },
			{ q: "hook", o: { project: "p2" } },
			{ q: "nomatchword", o: {} },
		];
		const same = cases.every(
			({ q, o }) => JSON.stringify(searchPersistedIndex(dir, q, o)) === JSON.stringify(s.searchDetailed(q, { ...o, includeLinked: false })),
		);
		check("인덱스가 최신이면 searchDetailed(includeLinked:false) 와 같음", same);
		const snap = snapshot(dir);
		for (const { q, o } of cases) searchPersistedIndex(dir, q, o);
		check("훅 질의가 볼트를 한 바이트도 바꾸지 않음(인덱스·기억 파일)", snapshot(dir) === snap);
		// 훅은 인덱스 파일만 읽고, 볼트 전체가 아니라 반환할 결과만 stat 한다 (R5 설계)
		const calls = { read: new Array(), stat: new Array() };
		const orig = { readFileSync: fs.readFileSync, statSync: fs.statSync };
		Object.assign(fs, {
			readFileSync: (...a) => (calls.read.push(String(a[0])), Reflect.apply(orig.readFileSync, fs, a)),
			statSync: (...a) => (calls.stat.push(String(a[0])), Reflect.apply(orig.statSync, fs, a)),
		});
		let top3;
		try {
			top3 = searchPersistedIndex(dir, "quince", { limit: 3 });
		} finally {
			Object.assign(fs, orig);
		}
		const quinceAll = s.searchDetailed("quince", { limit: 20, includeLinked: false }).results.length;
		check("훅은 인덱스 파일만 읽음", calls.read.length === 1 && calls.read[0] === indexPath(dir), JSON.stringify(calls.read));
		check(
			`훅은 반환 결과만 stat (후보 ${quinceAll}건, limit 3 → stat ${calls.stat.length}회)`,
			quinceAll > 3 &&
				top3.results.length === 3 &&
				calls.stat.length === 3 &&
				calls.stat.every((p, i) => p === keyFile(dir, `m:${top3.results[i].record.slug}`) || p === keyFile(dir, `a:${top3.results[i].record.slug}`)),
			JSON.stringify(calls.stat),
		);
		// 훅 함수의 모듈 그래프는 gray-matter·js-yaml 을 불러오지 않는다 — 파일을 파싱하면 불러오는 것으로 탐지 방법을 확인한다
		const light = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import { createRequire } from "node:module";
const { searchPersistedIndex } = await import(${JSON.stringify(distUrl("store.js"))});
const heavy = () => Object.keys(createRequire(import.meta.url).cache).filter((k) => /[\\\\/](gray-matter|js-yaml)[\\\\/]/.test(k)).length;
const n = searchPersistedIndex(${JSON.stringify(dir)}, "quince", { limit: 3 }).results.length;
const before = heavy();
const { Vault } = await import(${JSON.stringify(distUrl("vault.js"))});
new Vault(${JSON.stringify(dir)}).read("k-c");
process.stdout.write(JSON.stringify({ n, before, after: heavy() }));`,
			],
			{ encoding: "utf8" },
		);
		const lightOut = light.status === 0 ? JSON.parse(light.stdout) : null;
		check(
			"훅 경로는 gray-matter·js-yaml 을 불러오지 않음(파일 파싱 시에는 불러옴 — 탐지 확인)",
			!!lightOut && lightOut.n === 3 && lightOut.before === 0 && lightOut.after > 0,
			`${light.stdout} ${light.stderr.slice(-300)}`,
		);
		const fpA = keyFile(dir, "m:k-a");
		fs.writeFileSync(fpA, fs.readFileSync(fpA, "utf8").replace("hook alpha quince", "hook alpha quince edited"));
		fs.rmSync(keyFile(dir, "m:k-e"));
		fs.writeFileSync(
			keyFile(dir, "m:k-f"),
			"---\nid: mem-k-f\ntitle: quince newcomer\ntype: semantic\ncreated: '2026-06-01T00:00:00.000Z'\n---\n\nnew\n",
		);
		const snap2 = snapshot(dir);
		const hookSlugs = () => searchPersistedIndex(dir, "quince", { limit: 20 }).results.map((r) => r.record.slug);
		const got = hookSlugs();
		check("색인 뒤 수정된 파일의 slug 는 버림", !got.includes("k-a"), got.join(","));
		check("색인 뒤 삭제된 파일의 slug 는 버림", !got.includes("k-e"), got.join(","));
		check("색인 뒤 새로 생긴 파일은 훅에 보이지 않음", !got.includes("k-f"), got.join(","));
		check("나머지 후보는 남음", got.includes("k-c") && got.includes("k-b"), got.join(","));
		check("버린 뒤에도 볼트 불변", snapshot(dir) === snap2);
		s.search("quince");
		const after = hookSlugs();
		check("서버 sync 뒤 훅이 수정·추가를 봄", after.includes("k-a") && after.includes("k-f") && !after.includes("k-e"), after.join(","));
		const bare = freshDir();
		new Vault(bare).write(record("n-one", { title: "quince without index" }));
		const none = searchPersistedIndex(bare, "quince");
		check("인덱스가 없으면 빈 결과", none.results.length === 0 && none.totalMatched === 0);
		check("인덱스가 없어도 .bbm-index 를 만들지 않음", !fs.existsSync(path.join(bare, INDEX_DIR)));
		const missing = path.join(tmpRoot, "no-such-vault");
		check("없는 볼트 경로도 빈 결과·디렉터리 미생성", searchPersistedIndex(missing, "quince").results.length === 0 && !fs.existsSync(missing));

		// 낡은 결과는 후보에서 빼고 다시 순위화한다 — limit 을 지금 파일과 맞는 후보로 채운다
		const rdir = freshDir();
		const rv = new Vault(rdir);
		rv.write(record("r-top", { title: "rollback runbook", description: "rollback steps", body: "rollback rollback rollback" }));
		rv.write(record("r-next", { title: "canary release", body: "rollback rollback" }));
		rv.write(record("r-last", { title: "feature flags", body: "rollback" }));
		quietStore(rdir).search("rollback");
		const slugList = (o) => o.results.map((x) => x.record.slug).join(",");
		const full = searchPersistedIndex(rdir, "rollback", { limit: 5 });
		check("낡음 전: rollback 순위 r-top, r-next, r-last(전제 확인)", slugList(full) === "r-top,r-next,r-last" && full.totalMatched === 3, slugList(full));
		const fpTop = keyFile(rdir, "m:r-top");
		fs.writeFileSync(fpTop, fs.readFileSync(fpTop, "utf8").replace("rollback steps", "rollback steps edited"));
		const one = searchPersistedIndex(rdir, "rollback", { limit: 1 });
		check("상위 1건이 낡으면 limit 1 결과는 다음 현재 후보", slugList(one) === "r-next" && one.totalMatched === 2, `${slugList(one)} total=${one.totalMatched}`);
		const two = searchPersistedIndex(rdir, "rollback", { limit: 2 });
		check("상위가 낡아도 limit 2 를 현재 후보로 채움", slugList(two) === "r-next,r-last", slugList(two));

		// 버린 기억(다른 프로세스의 forget → archive 이동)은 남은 결과를 억제하지 않는다
		const idir = freshDir();
		const iv = new Vault(idir);
		iv.write(record("i-win", { title: "rollback deploy procedure", description: "rollback deploy", body: "rollback rollback rollback" }));
		iv.write(record("i-lose", { title: "rollback deploy procedure copy", description: "rollback deploy", body: "rollback" }));
		quietStore(idir).search("rollback");
		const lose = (o) => o.results.find((x) => x.record.slug === "i-lose");
		const pre = searchPersistedIndex(idir, "rollback", { limit: 5 });
		check("억제 전제: i-lose 가 i-win 에 억제됨", lose(pre)?.inhibited === true && lose(pre)?.inhibitedBy === "i-win", slugList(pre));
		fs.renameSync(keyFile(idir, "m:i-win"), keyFile(idir, "a:i-win"));
		const post = searchPersistedIndex(idir, "rollback", { limit: 5 });
		check(
			"버린 기억이 남은 결과를 억제하지 않음(점수 반감·inhibitedBy 없음, totalMatched 에서도 빠짐)",
			slugList(post) === "i-lose" &&
				!lose(post).inhibited &&
				lose(post).inhibitedBy === undefined &&
				lose(post).score === lose(pre).score * 2 &&
				post.totalMatched === 1,
			JSON.stringify(post.results.map((x) => [x.record.slug, x.score, x.inhibitedBy])),
		);
	}

	// 대부분이 낡아도 순위화 횟수는 상수로 묶인다 — 반환 결과 대조를 몇 바퀴 한 뒤에는 남은 후보를 모두 대조한다
	{
		const pad = (i) => String(i).padStart(2, "0");
		const minerals = ["amber", "basalt", "cobalt", "dolomite", "emerald", "feldspar", "garnet", "hematite", "iolite", "jasper", "kyanite", "lapis"];
		const zdir = freshDir();
		const zv = new Vault(zdir);
		minerals.forEach((w, i) => zv.write(record(`z-${pad(i)}`, { title: `zircon ${w}`, confidence: 0.99 - i * 0.05 })));
		quietStore(zdir).search("zircon");
		const pre = searchPersistedIndex(zdir, "zircon", { limit: minerals.length });
		const order = pre.results.map((x) => x.record.slug).join(",");
		check(
			"대량 낡음 전제: zircon 순위가 confidence 순이고 억제 없음",
			order === minerals.map((_, i) => `z-${pad(i)}`).join(",") && pre.results.every((x) => !x.inhibited),
			order,
		);
		for (let i = 0; i < 8; i++) {
			const fp = keyFile(zdir, `m:z-${pad(i)}`);
			fs.writeFileSync(fp, fs.readFileSync(fp, "utf8") + "\nedited\n");
		}
		const one = searchPersistedIndex(zdir, "zircon", { limit: 1 });
		check(
			"상위 8건이 낡으면(반환 결과 대조 상한 초과) limit 1 은 첫 현재 후보이고 totalMatched 는 현재 후보 수",
			one.results.length === 1 && one.results[0].record.slug === "z-08" && one.results[0].score === pre.results[8].score && one.totalMatched === 4,
			`${one.results.map((x) => x.record.slug).join(",")} total=${one.totalMatched}`,
		);

		const ydir = freshDir();
		const yv = new Vault(ydir);
		for (let i = 0; i < 40; i++) yv.write(record(`y-${pad(i)}`, { title: "yarrow field note", confidence: 0.99 - i * 0.01 }));
		quietStore(ydir).search("yarrow");
		const copy = path.join(tmpRoot, "copied-vault");
		fs.cpSync(ydir, copy, { recursive: true });
		// 순위화 횟수는 후보마다 activationOf 가 부르는 Date.parse 호출 수로 센다
		const countParse = (fn) => {
			const orig = Date.parse;
			let n = 0;
			Date.parse = (s) => (n++, orig(s));
			try {
				return { out: fn(), n };
			} finally {
				Date.parse = orig;
			}
		};
		const fresh = countParse(() => searchPersistedIndex(ydir, "yarrow", { limit: 1 }));
		check("복사 전제: 원본 볼트에서는 결과 1건·후보 40건", fresh.out.results.length === 1 && fresh.out.totalMatched === 40, `total=${fresh.out.totalMatched}`);
		const snapCopy = snapshot(copy);
		const stale = countParse(() => searchPersistedIndex(copy, "yarrow", { limit: 1 }));
		check(
			"fs.cpSync 사본 볼트(모든 ino 변경)에서 훅은 빈 결과",
			stale.out.results.length === 0 && stale.out.totalMatched === 0,
			`${stale.out.results.length}건 total=${stale.out.totalMatched}`,
		);
		check(`전부 낡아도 순위화는 상수 회 (Date.parse ${stale.n}회, 1회 순위화 ${fresh.n}회, 상한 4배)`, fresh.n > 0 && stale.n <= 4 * fresh.n);
		check("사본 볼트도 한 바이트도 바꾸지 않음", snapshot(copy) === snapCopy);
	}

	// ── 8. 네이티브 메모리 디렉터리
	console.log("8) 네이티브 메모리 디렉터리에는 인덱스를 만들지 않는다 (T26·T42)");
	{
		const dir = freshDir();
		fs.writeFileSync(
			path.join(dir, "note.md"),
			"---\nname: native note\ndescription: native\nmetadata:\n  node_type: memory\n  type: user\n  originSessionId: 89358a04-3064-4b28\n---\n\nnative body\n",
		);
		const v = new Vault(dir);
		check("네이티브 판정(전제 확인)", v.nativeMemoryFiles.length > 0);
		v.write(record("nv-one", { title: "native vault plum" }));
		const s = new MemoryStore(v);
		s.reinforce = () => {};
		const found = s.search("plum", { includeLinked: false }).length;
		check("검색은 동작하고 .bbm-index 는 없음", found === 1 && !fs.existsSync(path.join(dir, INDEX_DIR)));
	}

	// ── 9. 구버전 호환 (F1)
	if (!oldDist) {
		console.log("9) 구버전 호환(F1) 건너뜀 — --old-dist 없음");
	} else {
		console.log(`9) 구버전 저장소·서버가 .bbm-index 가 있는 볼트에서 정상 동작한다 (F1, ${oldDist})`);
		const { Vault: OldVault } = await import(distUrl("vault.js", oldDist));
		const { MemoryStore: OldStore } = await import(distUrl("store.js", oldDist));
		const dirA = freshDir();
		const v = new Vault(dirA);
		v.write(record("f1-a", { title: "fig tree note", links: ["f1-b"], body: "fig body\n\n## 연관 기억\n- [[f1-b]]" }));
		v.write(record("f1-b", { title: "fig jam recipe", links: ["f1-a"], body: "jam" }));
		v.write(record("f1-c", { title: "date palm", body: "fig mention" }));
		quietStore(dirA).search("fig");
		check("신버전이 인덱스를 만듦(전제 확인)", fs.existsSync(indexPath(dirA)));
		const dirB = freshDir();
		fs.cpSync(dirA, dirB, { recursive: true });
		fs.rmSync(path.join(dirB, INDEX_DIR), { recursive: true });
		const oldStore = (dir) => {
			const s = new OldStore(new OldVault(dir));
			s.reinforce = () => {};
			return s;
		};
		const oldA = oldStore(dirA);
		const oldB = oldStore(dirB);
		check("구 loadAll 이 .bbm-index 유무와 무관하게 같음", JSON.stringify(oldA.loadAll(true)) === JSON.stringify(oldB.loadAll(true)));
		check(
			"구 search 가 .bbm-index 유무와 무관하게 같음",
			["fig", "jam", "palm date"].every((q) => JSON.stringify(oldA.searchDetailed(q)) === JSON.stringify(oldB.searchDetailed(q))),
		);
		oldA.regenerateIndex();
		oldB.regenerateIndex();
		check("구 regenerateIndex 의 MEMORY.md 가 같음", fs.readFileSync(path.join(dirA, "MEMORY.md"), "utf8") === fs.readFileSync(path.join(dirB, "MEMORY.md"), "utf8"));
		const idxSnap = snapshot(path.join(dirA, INDEX_DIR));
		const rem = oldA.remember({ title: "old server loquat", content: "written by old store", type: "semantic" });
		const fg = oldA.forget("f1-c", "old forget");
		check("구 remember·forget 성공", !!rem?.record?.slug && !!fg);
		check("구 저장소가 .bbm-index 를 건드리지 않음", snapshot(path.join(dirA, INDEX_DIR)) === idxSnap);
		const boot = spawnSync(process.execPath, [path.join(oldDist, "index.js")], {
			env: { ...process.env, BIGBRAIN_VAULT: dirA, BIGBRAIN_HOOK_CHECK: "0" },
			input: "",
			encoding: "utf8",
			timeout: 30_000,
		});
		check("구 서버가 .bbm-index 가 있는 볼트에서 기동(ready)", /ready\./.test(boot.stderr ?? ""), (boot.stderr ?? "").slice(-300));
		check("구 서버 기동이 .bbm-index 를 건드리지 않음", snapshot(path.join(dirA, INDEX_DIR)) === idxSnap);
		const newer = quietStore(dirA);
		check("신 저장소가 구 저장소의 remember 를 반영", slugsOf(newer, "loquat").join(",") === rem.record.slug);
		const palm = newer.search("palm", { includeLinked: false });
		check("신 저장소가 구 저장소의 forget 을 반영(archive)", palm.length === 1 && palm[0].record.status === "archived");
		check("신 sync 뒤 인덱스 = 파일", indexMatchesFiles(dirA));
	}
} finally {
	Date.now = realNow;
	fs.rmSync(tmpRoot, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\n실패: ${failures}건`);
	process.exit(1);
}
console.log("\nT42 영속 역색인 회귀 테스트 통과 ✔");
