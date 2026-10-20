// 웹 뷰어 회귀 테스트: export 스크립트 산출물을 viewer/parse.js 로 읽은 결과가 Vault.read() 와 같고 본문 렌더가 안전한지 확인한다.
// 라이브 볼트는 건드리지 않는다 — 전부 os.tmpdir() 임시 볼트.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const distUrl = (f) => `file://${path.join(root, "dist", f).replace(/\\/g, "/")}`;
const { Vault } = await import(distUrl("vault.js"));
const { MemoryStore, bodyWikilinks } = await import(distUrl("store.js"));

let failures = 0;
function check(name, cond, detail = "") {
	if (cond) console.log(`  ✔ ${name}`);
	else {
		failures++;
		console.error(`  ✘ ${name} ${detail}`);
	}
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-viewer-"));
try {
	const vault = new Vault(dir);
	const store = new MemoryStore(vault);
	const long = "긴 설명 문장이 여러 번 반복되어 js-yaml 이 접힌 블록 스칼라로 내보내게 만든다. ".repeat(6);
	store.remember({ slug: "viewer-base", title: "기준 기억", description: long, content: "기준 본문.", type: "episodic", tags: ["뷰어", "테스트"] });
	store.remember({
		slug: "viewer-xss",
		title: "렌더 안전성",
		description: "본문 HTML 이스케이프 확인",
		content: "[[viewer-base]] 와 [[없는-기억|별칭]] 링크.\n\n<script>alert(1)</script>\n<img src=x onerror=alert(2)>\n[나쁜 링크](javascript:alert(3))\n\n```\n[[코드-안-링크]]\n```",
		type: "semantic",
		links: ["viewer-base"],
		derivedFrom: ["viewer-base"],
		project: "viewer",
	});
	store.remember({ slug: "viewer-new", title: "새 판", description: "이전 판을 대체한다", content: "대체 본문", type: "semantic", supersedes: "viewer-xss" });
	store.remember({ slug: "viewer-gone", title: "잊힌 기억", description: "archive 로 옮겨진다", content: "잊힐 본문", type: "preference" });
	store.forget("viewer-gone", "테스트용 망각");
	for (let k = 0; k < 8; k++) store.revise("viewer-base", { content: `기준 본문 개정 ${k}. ${long}` });
	fs.writeFileSync(path.join(dir, "memories", "viewer-hand.md"), [
		"---",
		"id: mem-hand",
		"title: \"손편집 \\\"따옴표\\\" \\u00e9\"",
		"type: procedural",
		"tags: [손편집, 'a, b']",
		"confidence: 0.4",
		"created: 2025-01-02",
		"updated: 2025-01-03 04:05:06",
		"links:",
		"- viewer-base",
		"history:",
		"  - |-",
		"    첫 줄",
		"    둘째 줄",
		"---",
		"손편집 본문",
		"",
	].join("\n"));

	const out = path.join(dir, "data.js");
	const log = execFileSync(process.execPath, [path.join(here, "export-viewer-data.mjs"), out], { env: { ...process.env, ASTRONRAG_VAULT: dir }, encoding: "utf8" });
	check("export 는 건수만 출력한다", /memories 4, archive 1/.test(log) && !log.includes("기준 본문"), log.trim());

	const ctx = vm.createContext({ window: {} });
	vm.runInContext(fs.readFileSync(out, "utf8"), ctx);
	vm.runInContext(fs.readFileSync(path.join(root, "viewer", "parse.js"), "utf8"), ctx);
	const P = ctx.AstronRAGParse;
	const data = ctx.window.ASTRONRAG_DATA;
	check("data.js 가 window.ASTRONRAG_DATA 를 만든다", data && Array.isArray(data.files) && data.files.length === 5);

	console.log("1) 모든 필드가 Vault.read() 와 같다");
	const recs = new Map();
	for (const f of data.files) {
		const a = P.parseMemory(f.name, f.text, f.archived);
		const b = vault.read(f.name.replace(/\.md$/, ""), f.archived);
		recs.set(a.slug, a);
		const pairs = {
			id: [a.id, b.id], title: [a.title, b.title], description: [a.description, b.description], type: [a.type, b.type],
			tags: [a.tags, b.tags], confidence: [a.confidence, b.confidence], storage_strength: [a.storage_strength, b.storageStrength],
			created: [a.created, b.created], updated: [a.updated, b.updated], links: [a.links, b.links], history: [a.history, b.history],
			derived_from: [a.derived_from, b.derivedFrom || []], supersedes: [a.supersedes, b.supersedes], superseded_by: [a.superseded_by, b.supersededBy],
			archive_reason: [a.archive_reason, b.archiveReason], project: [a.project, b.project], body: [a.body, b.body],
		};
		const diff = Object.entries(pairs).filter(([, [x, y]]) => JSON.stringify(x) !== JSON.stringify(y)).map(([k]) => k);
		check(`${a.slug} 일치`, diff.length === 0, diff.join(","));
	}
	check("긴 description 이 접힌 블록으로 저장됐다", /description: >-?\n/.test(fs.readFileSync(path.join(dir, "memories", "viewer-base.md"), "utf8")));
	check("archive/ 파일은 archived 로 본다", recs.get("viewer-gone").status === "archived" && recs.get("viewer-gone").archived === true);
	check("supersede 관계가 양쪽에 남는다", recs.get("viewer-new").supersedes === "viewer-xss" && recs.get("viewer-xss").superseded_by === "viewer-new");
	check("derived_from 을 읽는다", JSON.stringify(recs.get("viewer-xss").derived_from) === '["viewer-base"]');
	check("손편집 따옴표·flow·타임스탬프·블록 시퀀스", recs.get("viewer-hand").title === '손편집 "따옴표" é' && recs.get("viewer-hand").tags[1] === "a, b" && recs.get("viewer-hand").history[0] === "첫 줄\n둘째 줄");

	console.log("2) 위키링크 추출이 store.ts 와 같다");
	for (const r of recs.values()) check(`${r.slug} 위키링크`, JSON.stringify(r.wikilinks) === JSON.stringify(bodyWikilinks(r.body)), JSON.stringify(r.wikilinks));

	console.log("3) 본문 렌더가 원문 HTML 을 실행하지 않는다");
	const html = P.renderMarkdown(recs.get("viewer-xss").body, (s) => recs.has(s));
	check("<script> 가 이스케이프된다", !/<script/i.test(html) && html.includes("&lt;script&gt;"));
	check("onerror 속성이 태그로 살아나지 않는다", !/<img/i.test(html));
	check("javascript: 링크를 만들지 않는다", !/href="javascript:/i.test(html));
	check("있는 위키링크는 data-slug 링크", html.includes('<a href="#" data-slug="viewer-base">viewer-base</a>'));
	check("없는 위키링크는 missing", html.includes('<span class="missing" title="볼트에 없음">[[별칭]]</span>'));
	check("코드 블록 안 위키링크는 링크가 아니다", html.includes("<pre><code>[[코드-안-링크]]</code></pre>"));
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}

if (failures) {
	console.error(`\n✘ regress-viewer: ${failures}건 실패`);
	process.exit(1);
}
console.log("\n✔ regress-viewer 통과");
