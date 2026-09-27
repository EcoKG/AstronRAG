#!/usr/bin/env node
// 볼트의 memories/·archive/ 마크다운 원문을 웹 뷰어가 읽는 viewer/data.js 로 내보낸다.
// 사용: node scripts/export-viewer-data.mjs [출력 경로]  (볼트 경로는 BIGBRAIN_VAULT, 없으면 <저장소>/vault)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const vaultDir = process.env.BIGBRAIN_VAULT
	? path.resolve(process.env.BIGBRAIN_VAULT)
	: path.resolve(here, "..", "vault");
const outFile = path.resolve(process.argv[2] || path.join(here, "..", "viewer", "data.js"));

const memoriesDir = path.join(vaultDir, "memories");
if (!fs.existsSync(memoriesDir)) {
	console.error(`볼트를 찾지 못했습니다: ${memoriesDir}`);
	process.exit(1);
}

/** 폴더 바로 아래 *.md 파일을 이름순으로 읽는다(하위 폴더는 제외). */
function readDir(dir, archived) {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isFile() && e.name.endsWith(".md"))
		.map((e) => e.name)
		.sort()
		.map((name) => ({ name, archived, text: fs.readFileSync(path.join(dir, name), "utf8") }));
}

const memories = readDir(memoriesDir, false);
const archive = readDir(path.join(vaultDir, "archive"), true);
const data = {
	source: path.basename(vaultDir),
	generatedAt: new Date().toISOString(),
	files: [...memories, ...archive],
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `window.BIGBRAIN_DATA = ${JSON.stringify(data)};\n`, "utf8");
console.log(`viewer data: memories ${memories.length}, archive ${archive.length} → ${outFile}`);
