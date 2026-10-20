// T41·T43 회귀 테스트 — Retriever/Ranker 분리와 RIF 조기 종료가 회상 결과를 바꾸지 않는지 고정한다.
//
// 고정하는 성질:
//   1 RIF 조기 종료 결과가 전 후보를 비교하는 참조 구현과 같다(동점·0점·NaN·파생물 쌍 포함 무작위 대조)
//   2 볼트 회상에서 limit L 결과가 전체 결과의 앞 L 건과 같고 totalMatched 도 같다(created 가 깨진 NaN 볼트 포함)
//   3 두 저장소가 같은 Retriever 를 공유해도 결과가 같고, 다른 볼트로 sync 하면 그 볼트 후보만 낸다
//   4 upsert·remove·k 컷오프가 search 에 반영되고 필드 기여 합이 점수와 같다
//   5 revise 로 제목이 바뀌면 캐시된 토큰이 아니라 새 제목으로 검색된다
//   6 bm25f 점수가 식(IDF·필드 길이 정규화·k1 포화·동의어 0.6배·조사 흡수)대로 나오고, 새로 만든 인덱스와 파일에서 적재한 인덱스의 점수가 같다
//   7 ASTRONRAG_SCORER 가 bm25f 가 아니면 legacy 이고, 그림자 모드는 수치만 남기며 회상 출력을 바꾸지 않는다
//
// 라이브 볼트는 건드리지 않는다 — 전부 os.tmpdir() 임시 볼트.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const distUrl = (f) => pathToFileURL(path.join(root, "dist", f)).href;
// 스코어러·그림자·변형 가중은 store 모듈 로드 시 읽는다 — 사용자 환경과 무관하게 기본값으로 시작한다
for (const k of ["ASTRONRAG_SCORER", "ASTRONRAG_SHADOW", "ASTRONRAG_ALT_WEIGHT"]) delete process.env[k];
const { Vault } = await import(distUrl("vault.js"));
const storeModule = await import(distUrl("store.js"));
const { MemoryStore, parseQuery } = storeModule;
const { LexicalRetriever, overlap, tokenize, BM25F_W, BM25F_B, BM25F_K1, SYNONYM_WEIGHT } = await import(distUrl("retriever.js"));
const { inhibit, RIF_THRESHOLD } = await import(distUrl("ranker.js"));

let failures = 0;
function check(name, cond, detail = "") {
	if (cond) console.log(`  ✔ ${name}`);
	else {
		failures++;
		console.error(`  ✘ ${name} ${detail}`);
	}
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-retriever-"));
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
		lastReinforced: o.lastReinforced ?? o.created ?? iso(NOW - 30 * DAY),
		accessCount: 0,
		project: o.project,
		links: o.links ?? [],
		derivedFrom: o.derivedFrom,
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

/** 전 후보를 끝까지 비교하는 RIF — 각 후보를 앞선 모든 후보와 비교하는 조기 종료 전 규칙 */
function referenceInhibit(scored, limit) {
	const suppresses = (winner, loser) =>
		!(winner.record.derivedFrom ?? []).includes(loser.record.slug) &&
		!(loser.record.derivedFrom ?? []).includes(winner.record.slug);
	scored.forEach((s, i) => {
		const rivalOf = scored
			.slice(0, i)
			.find((k) => suppresses(k.result, s.result) && overlap(k.tokens, s.tokens) >= RIF_THRESHOLD);
		if (rivalOf) {
			s.result.score *= 0.5;
			s.result.inhibited = true;
			s.result.inhibitedBy = rivalOf.result.record.slug;
		}
	});
	const results = scored.map((k) => k.result);
	results.sort((a, b) => b.score - a.score);
	return results.slice(0, limit);
}

const realNow = Date.now;
Date.now = () => NOW;
try {
	// ── 1. 조기 종료 = 전체 비교 (무작위 대조)
	console.log("1) RIF 조기 종료 결과가 전 후보 비교와 같다 (T43)");
	{
		const vocab = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india"];
		const scorePool = [0, 0.5, 1, 1, 2, 2, 2, 3.25, 4, 6.5, 8];
		const rnd = mulberry32(20260928);
		let trials = 0;
		let mismatch = 0;
		let earlyStops = 0;
		let firstBad = "";
		for (let trial = 0; trial < 400; trial++) {
			const n = 1 + Math.floor(rnd() * 30);
			const withNaN = trial % 10 === 9;
			const base = Array.from({ length: n }, (_, i) => {
				const tokens = vocab.filter(() => rnd() < 0.45);
				const derivedFrom = rnd() < 0.1 && i > 0 ? [`s${Math.floor(rnd() * i)}`] : undefined;
				const score = rnd() < 0.5 ? scorePool[Math.floor(rnd() * scorePool.length)] : rnd() * 8;
				return { slug: `s${i}`, derivedFrom, score, tokens };
			});
			if (withNaN) base[Math.floor(rnd() * n)].score = Number.NaN;
			const build = () => {
				const scored = base.map((b) => ({
					result: { record: { slug: b.slug, derivedFrom: b.derivedFrom }, score: b.score },
					tokens: b.tokens,
				}));
				scored.sort((a, b) => b.result.score - a.result.score);
				return scored;
			};
			for (const limit of [0, 1, 2, 3, 5, 8, n, n + 5]) {
				trials++;
				const refIn = build();
				const newIn = build();
				const want = JSON.stringify(referenceInhibit(refIn, limit));
				const got = JSON.stringify(inhibit(newIn, limit));
				if (want !== got) {
					mismatch++;
					if (!firstBad) firstBad = `trial=${trial} limit=${limit} want=${want} got=${got}`;
				}
				// 출력은 같은데 입력 쪽 억제 표시가 다르면 뒤쪽 후보를 건너뛴 것이다
				const touched = (xs) => JSON.stringify(xs.map((x) => x.result));
				if (want === got && touched(refIn) !== touched(newIn)) earlyStops++;
			}
		}
		check(`무작위 ${trials}건 전부 참조 구현과 같음`, mismatch === 0, `불일치 ${mismatch}건 ${firstBad.slice(0, 400)}`);
		check("조기 종료가 실제로 일어난 사례가 있음(검사 유효성)", earlyStops > 0, `earlyStops=${earlyStops}`);
	}

	// ── 2. 볼트 회상: limit L = 전체의 앞 L 건
	console.log("2) limit L 회상 결과가 전체 결과의 앞 L 건과 같다 (T43)");
	const prefixCheck = (label, s, query, opts = {}) => {
		const full = s.searchDetailed(query, { ...opts, limit: 1000, includeLinked: false });
		const bad = [1, 2, 3, 5, 8, 13].filter((L) => {
			const got = JSON.stringify(s.searchDetailed(query, { ...opts, limit: L, includeLinked: false }));
			const want = JSON.stringify({ results: full.results.slice(0, L), totalMatched: full.totalMatched });
			return got !== want;
		});
		check(`${label}: limit 1·2·3·5·8·13 이 전체의 앞부분과 같음 (후보 ${full.totalMatched}건)`, bad.length === 0, `불일치 limit=${bad.join(",")}`);
		return full;
	};
	{
		const dir = freshDir();
		const v = new Vault(dir);
		const rnd = mulberry32(7);
		let k = 0;
		for (let c = 0; c < 6; c++) {
			for (let i = 0; i < 5; i++) {
				const conf = [0.4, 0.6, 0.8, 1][Math.floor(rnd() * 4)];
				const created = iso(NOW - (1 + Math.floor(rnd() * 200)) * DAY);
				v.write(record(`cl${c}-m${i}`, {
					title: `cluster${c} alpha${c} beta${c} gamma${c} item${i}`,
					description: `zephyr grouping ${c} member ${i}`,
					body: `zephyr note ${c}-${i} shared body text`,
					confidence: conf,
					created,
					strength: 1 + Math.floor(rnd() * 3),
				}));
				k++;
			}
		}
		// 동점: 필드·수치가 같고 slug 만 다른 기억
		for (let i = 0; i < 4; i++) {
			v.write(record(`tie-${i}`, { title: `tied record zephyr number${i}`, body: "same body", confidence: 0.9, created: iso(NOW - 10 * DAY) }));
		}
		// 파생물 쌍: 제목이 겹쳐도 서로 누르지 않는다
		v.write(record("src-episode", { title: "deploy rollback zephyr incident", body: "episode body", created: iso(NOW - 5 * DAY) }));
		v.write(record("derived-rule", { title: "deploy rollback zephyr incident rule", body: "rule", derivedFrom: ["src-episode"], created: iso(NOW - 2 * DAY) }));
		// 희미한 기억(대체됨)
		v.write(record("old-zephyr", { title: "zephyr superseded note", status: "superseded", created: iso(NOW - 100 * DAY) }));
		const s = quietStore(dir);
		const full = prefixCheck("근접 중복 군집·동점·파생물", s, "zephyr");
		check("근접 중복이 실제로 억제됨(전제 확인)", full.results.some((r) => r.inhibited), "");
		const derived = full.results.find((r) => r.record.slug === "derived-rule");
		const src = full.results.find((r) => r.record.slug === "src-episode");
		check("파생물·근거 쌍은 서로 억제하지 않음", !!derived && !!src && derived.inhibitedBy !== "src-episode" && src.inhibitedBy !== "derived-rule");
		prefixCheck("유형 필터", s, "zephyr", { type: "semantic" });
	}
	{
		const dir = freshDir();
		const v = new Vault(dir);
		for (let i = 0; i < 8; i++) {
			v.write(record(`nan-${i}`, { title: `nanvault quartz item${i} common words`, body: "quartz body", confidence: 0.5 + i * 0.05, created: iso(NOW - (i + 1) * DAY) }));
		}
		v.write(record("nan-broken", { title: "nanvault quartz broken common words", body: "quartz", created: "not-a-date" }));
		const s = quietStore(dir);
		const full = prefixCheck("created 가 깨진 NaN 점수 포함", s, "quartz");
		check("NaN 점수 후보가 실제로 있음(전제 확인)", full.results.some((r) => Number.isNaN(r.score)));
	}

	// ── 3. Retriever 공유
	console.log("3) 두 저장소가 같은 Retriever 를 공유해도 결과가 같다 (T41)");
	{
		const dirA = freshDir();
		const dirB = freshDir();
		const va = new Vault(dirA);
		const vb = new Vault(dirB);
		va.write(record("a-one", { title: "shared retriever kiwi alpha", body: "kiwi" }));
		va.write(record("a-two", { title: "shared retriever kiwi beta", body: "kiwi" }));
		vb.write(record("b-one", { title: "other vault kiwi gamma", body: "kiwi" }));
		const shared = new LexicalRetriever();
		const s1 = quietStore(dirA, shared);
		const s2 = quietStore(dirA, shared);
		const own = quietStore(dirA);
		check("생성자 인자로 넘긴 Retriever 를 공개 속성으로 노출", s1.retriever === shared && s2.retriever === shared);
		const a = JSON.stringify(s1.searchDetailed("kiwi"));
		const b = JSON.stringify(s2.searchDetailed("kiwi"));
		const c = JSON.stringify(own.searchDetailed("kiwi"));
		check("공유 Retriever 두 저장소와 전용 Retriever 저장소의 출력이 같음", a === b && b === c);
		const sb = quietStore(dirB, shared);
		const slugsB = sb.search("kiwi", { includeLinked: false }).map((r) => r.record.slug);
		check("다른 볼트로 sync 하면 그 볼트 후보만 냄", slugsB.join(",") === "b-one", slugsB.join(","));
		const slugsA = s1.search("kiwi", { includeLinked: false }).map((r) => r.record.slug).sort();
		check("원래 볼트로 돌아오면 다시 그 볼트 후보", slugsA.join(",") === "a-one,a-two", slugsA.join(","));
	}

	// ── 4. upsert·remove·k·필드 기여
	console.log("4) upsert·remove·k 컷오프와 필드 기여 (T41)");
	{
		const dir = freshDir();
		const v = new Vault(dir);
		v.write(record("p-title", { title: "mango pipeline", tags: ["mango"], description: "mango desc", body: "mango mango mango mango" }));
		v.write(record("p-body", { title: "unrelated", body: "mango once" }));
		v.write(record("p-syn", { title: "배포 절차", body: "순서" }));
		const r = new LexicalRetriever();
		r.sync(v);
		const q = parseQuery("mango");
		const cands = r.search(q, Infinity, {});
		check("sync 후 후보 2건(순서는 볼트 나열 순서)", cands.map((x) => x.slug).join(",") === "p-body,p-title", cands.map((x) => x.slug).join(","));
		const top = cands.find((x) => x.slug === "p-title");
		const sum = top ? top.fields.reduce((acc, f) => acc + f.weight, 0) : -1;
		check("필드 기여 합 = 점수 (제목 5·태그 4·설명 3·본문 최대 3)", !!top && top.score === 15 && sum === top.score, `score=${top?.score} sum=${sum}`);
		const syn = r.search(parseQuery("deploy"), Infinity, {}).find((x) => x.slug === "p-syn");
		check("동의어 제목 적중은 0.6배 가중", !!syn && syn.fields.some((f) => f.field === "title" && f.weight === 5 * 0.6), JSON.stringify(syn?.fields));
		const k1 = r.search(q, 1, {});
		check("k=1 이면 점수 최고 후보만", k1.length === 1 && k1[0].slug === "p-title");
		r.remove("p-title");
		check("remove 후 후보에서 빠짐", r.search(q, Infinity, {}).map((x) => x.slug).join(",") === "p-body");
		r.upsert(record("p-new", { title: "mango upserted", body: "" }));
		check("upsert 한 레코드가 후보로 나옴", r.search(q, Infinity, {}).some((x) => x.slug === "p-new"));
		r.upsert(record("p-body", { title: "papaya only", body: "papaya" }));
		check("upsert 로 교체하면 옛 토큰이 남지 않음", !r.search(q, Infinity, {}).some((x) => x.slug === "p-body"));
		check("project 필터: 다른 프로젝트 기억 제외", (() => {
			r.upsert(record("p-proj", { title: "mango scoped", project: "other" }));
			const scoped = r.search(q, Infinity, { project: "mine" }).map((x) => x.slug);
			const all = r.search(q, Infinity, {}).map((x) => x.slug);
			return !scoped.includes("p-proj") && all.includes("p-proj");
		})());
	}

	// ── 5. 토큰 캐시 무효화
	console.log("5) revise 로 제목이 바뀌면 새 제목으로 검색된다 (T41 캐시)");
	{
		const dir = freshDir();
		const v = new Vault(dir);
		v.write(record("rename-me", { title: "lychee original heading", body: "plain body" }));
		const s = quietStore(dir);
		check("변경 전: 옛 제목 토큰으로 찾음", s.search("lychee", { includeLinked: false }).some((r) => r.record.slug === "rename-me"));
		s.revise("rename-me", { title: "durian renamed heading", reason: "제목 교체" });
		check("변경 후: 새 제목 토큰으로 찾음", s.search("durian", { includeLinked: false }).some((r) => r.record.slug === "rename-me"));
		check("변경 후: 옛 제목 토큰으로는 안 나옴", !s.search("lychee", { includeLinked: false }).some((r) => r.record.slug === "rename-me"));
	}

	// ── 6. BM25F
	console.log("6) bm25f 점수 — 식·동의어·조사 흡수·적재 인덱스 (T46)");
	{
		const dir = freshDir();
		const v = new Vault(dir);
		const docs = {
			"b-full": { title: "zebra alpha", tags: ["zebra"], description: "about zebra", body: "zebra zebra words here" },
			"b-body": { title: "unrelated thing", body: "zebra" },
			"b-kr": { title: "배포 절차", body: "순서 설명" },
		};
		for (const [slug, o] of Object.entries(docs)) v.write(record(slug, o));
		const fieldsOf = (o) => [tokenize(o.title), tokenize((o.tags ?? []).join(" ")), tokenize(o.description ?? ""), tokenize(o.body ?? "")];
		const lens = Object.fromEntries(Object.entries(docs).map(([slug, o]) => [slug, fieldsOf(o).map((t) => t.length)]));
		const n = Object.keys(docs).length;
		const avg = [0, 1, 2, 3].map((f) => Object.values(lens).reduce((a, l) => a + l[f], 0) / n);
		/** 한 토큰의 기대 점수 — tf 는 필드별 빈도, df 는 그 토큰이 있는 문서 수 */
		const expect = (slug, tf, df, w = 1) => {
			const t = tf.reduce((a, x, f) => a + (x > 0 ? (BM25F_W[f] * x) / (1 - BM25F_B[f] + (BM25F_B[f] * lens[slug][f]) / avg[f]) : 0), 0);
			return (w * Math.log(1 + (n - df + 0.5) / (df + 0.5)) * t) / (BM25F_K1 + t);
		};
		const r = new LexicalRetriever();
		r.sync(v);
		const zebra = r.search(parseQuery("zebra"), Infinity, {}, "bm25f");
		const full = zebra.find((c) => c.slug === "b-full");
		const body = zebra.find((c) => c.slug === "b-body");
		const near = (a, b) => Math.abs(a - b) <= 1e-9;
		check("네 필드 적중 문서 점수가 식과 같음", !!full && near(full.score, expect("b-full", [1, 1, 1, 2], 2)), `${full?.score} ≠ ${expect("b-full", [1, 1, 1, 2], 2)}`);
		check("본문만 적중한 문서 점수가 식과 같음", !!body && near(body.score, expect("b-body", [0, 0, 0, 1], 2)), `${body?.score}`);
		check("필드 기여 합 = 점수", !!full && near(full.fields.reduce((a, f) => a + f.weight, 0), full.score));
		check("scorer 인자를 빼면 legacy 점수(5+4+3+본문 2)", r.search(parseQuery("zebra"), Infinity, {}).find((c) => c.slug === "b-full")?.score === 14);
		const kr = r.search(parseQuery("배포를"), Infinity, {}, "bm25f").find((c) => c.slug === "b-kr");
		check("조사 흡수(배포를→배포) 적중 점수가 식과 같음", !!kr && near(kr.score, expect("b-kr", [1, 0, 0, 0], 1)), `${kr?.score}`);
		const syn = r.search(parseQuery("deploy"), Infinity, {}, "bm25f").find((c) => c.slug === "b-kr");
		const direct = r.search(parseQuery("배포"), Infinity, {}, "bm25f").find((c) => c.slug === "b-kr");
		check("동의어 적중은 원 토큰 적중의 0.6배", !!syn && !!direct && near(syn.score, SYNONYM_WEIGHT * direct.score), `${syn?.score} / ${direct?.score}`);
		const shape = (list) => JSON.stringify(list.map((c) => [c.slug, c.score, c.fields]));
		const fresh = shape(r.search(parseQuery("zebra 배포"), Infinity, {}, "bm25f"));
		const loaded = new LexicalRetriever();
		loaded.sync(new Vault(dir));
		const ro = LexicalRetriever.openReadOnly(dir);
		check("파일에서 적재한 인덱스의 bm25f 점수가 같음", shape(loaded.search(parseQuery("zebra 배포"), Infinity, {}, "bm25f")) === fresh);
		check("읽기 전용 인덱스의 bm25f 점수가 같음", !!ro && shape(ro.search(parseQuery("zebra 배포"), Infinity, {}, "bm25f")) === fresh);
		check("범위 필터는 통계(N·df)를 바꾸지 않음", (() => {
			r.upsert(record("b-other", { title: "zebra other", project: "other" }));
			const scoped = r.search(parseQuery("zebra"), Infinity, { project: "mine" }, "bm25f").find((c) => c.slug === "b-body");
			const all = r.search(parseQuery("zebra"), Infinity, {}, "bm25f").find((c) => c.slug === "b-body");
			return !!scoped && !!all && scoped.score === all.score;
		})());
	}

	// ── 7. 스코어러 선택·그림자
	console.log("7) ASTRONRAG_SCORER·그림자 모드 (T46·G5)");
	{
		const dir = freshDir();
		const v = new Vault(dir);
		v.write(record("s-a", { title: "kiwi rollout guide", tags: ["kiwi"], body: "kiwi steps kiwi" }));
		v.write(record("s-b", { title: "kiwi notes", body: "kiwi" }));
		v.write(record("s-c", { title: "mango only", body: "kiwi once in a long body with many other words to dilute" }));
		/** 환경변수를 잠깐 바꿔 store 모듈을 새로 불러온다 — retriever·vault 모듈은 공유한다 */
		const load = async (tag, env) => {
			const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
			Object.assign(process.env, env);
			try {
				return await import(`${distUrl("store.js")}?${tag}`);
			} finally {
				for (const [k, val] of Object.entries(saved)) {
					if (val === undefined) delete process.env[k];
					else process.env[k] = val;
				}
			}
		};
		const open = (mod) => {
			const s = new mod.MemoryStore(new Vault(dir));
			s.reinforce = () => {};
			return s;
		};
		const xyz = await load("xyz", { ASTRONRAG_SCORER: "xyz" });
		const bm = await load("bm", { ASTRONRAG_SCORER: "bm25f" });
		const off = await load("off", { ASTRONRAG_SHADOW: "0" });
		const badAlt = await load("badalt", { ASTRONRAG_ALT_WEIGHT: "2" });
		check("기본 스코어러는 legacy", storeModule.SCORER === "legacy");
		check("알 수 없는 값은 legacy", xyz.SCORER === "legacy");
		check("bm25f 는 bm25f", bm.SCORER === "bm25f");
		const base = open(storeModule);
		const q = "kiwi guide";
		const baseOut = JSON.stringify(base.searchDetailed(q, { limit: 5 }));
		check("ASTRONRAG_SCORER=xyz 출력이 기본과 같음", JSON.stringify(open(xyz).searchDetailed(q, { limit: 5 })) === baseOut);
		const bmStore = open(bm);
		const bmOut = bmStore.searchDetailed(q, { limit: 5 });
		check("bm25f 스코어러 출력은 legacy 점수와 다름", JSON.stringify(bmOut) !== baseOut && bmOut.results.length > 0);
		check("bm25f 스코어러에서는 그림자를 계산하지 않음", bmStore.shadowTop5 === undefined);
		check("legacy 기본에서 그림자 일치율은 0~1", typeof base.shadowTop5 === "number" && base.shadowTop5 >= 0 && base.shadowTop5 <= 1, `${base.shadowTop5}`);
		const offStore = open(off);
		check("ASTRONRAG_SHADOW=0 출력이 그림자 켠 출력과 같음", JSON.stringify(offStore.searchDetailed(q, { limit: 5 })) === baseOut);
		check("ASTRONRAG_SHADOW=0 이면 그림자 없음", offStore.shadowTop5 === undefined);
		const alts = { limit: 5, altQueries: ["kiwi notes", "rollout"] };
		check("변형 질의가 있어도 그림자 켬·끔 출력이 같음", JSON.stringify(base.searchDetailed(q, alts)) === JSON.stringify(offStore.searchDetailed(q, alts)));
		check("변형 질의가 있어도 그림자 일치율을 낸다", typeof base.shadowTop5 === "number");
		check("범위 밖 ASTRONRAG_ALT_WEIGHT 는 기본 가중(0.7)", JSON.stringify(open(badAlt).searchDetailed(q, alts)) === JSON.stringify(base.searchDetailed(q, alts)));
		base.searchDetailed("zzzqqq nothing", { limit: 5 });
		check("후보가 없으면 그림자 없음", base.shadowTop5 === undefined);
		base.searchDetailed(q, { limit: 5 });
		base.searchDetailed("!!", { limit: 5 });
		check("토큰이 없는 질의는 이전 값을 지운다", base.shadowTop5 === undefined);
	}
} finally {
	Date.now = realNow;
	fs.rmSync(tmpRoot, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\n실패: ${failures}건`);
	process.exit(1);
}
console.log("\nT41/T43/T46 Retriever·Ranker 회귀 테스트 통과 ✔");
