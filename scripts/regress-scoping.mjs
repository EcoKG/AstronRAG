// T8 회귀 테스트 — 프로젝트 스코핑.
//
// 고정하는 버그(감사 E2):
//   전역 단일 볼트에 recall/list 하드 필터가 없어 타 프로젝트 기억이 동점 1위로
//   끼어들었다. tags 는 키워드 가산점(+4)일 뿐 배제 수단이 아니고,
//   opts 에 tags/project 를 넣어도 런타임에서 조용히 무시됐다.
//
// 설계 요점: project 가 **없는** 기억은 전역이라 어느 스코프에서도 통과한다.
// 네이티브의 프로젝트별 분리 저장소와 달리 격리와 공유를 한 볼트에서 양립시킨다.
//
// 라이브 볼트는 건드리지 않는다 — 전부 os.tmpdir() 임시 볼트.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const entry = path.join(root, "dist", "index.js");
const distUrl = (f) => `file://${path.join(root, "dist", f).replace(/\\/g, "/")}`;
const { Vault } = await import(distUrl("vault.js"));
const { MemoryStore } = await import(distUrl("store.js"));

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name} ${detail}`);
  }
}

const cleanups = /** @type {string[]} */ (Array());
function seeded() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-scope-"));
  cleanups.push(dir);
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "알파 빌드 방법", content: "알파 프로젝트 빌드 절차.", type: "procedural", project: "alpha" });
  s.remember({ title: "베타 빌드 방법", content: "베타 프로젝트 빌드 절차.", type: "procedural", project: "beta" });
  s.remember({ title: "공통 빌드 취향", content: "빌드 로그는 항상 파일로.", type: "preference" }); // 전역
  return { dir, store: s };
}
const slugs = (rs) => rs.map((r) => r.record.slug).sort();

// ── 1. search 스코프 필터
console.log("1) recall 프로젝트 필터");
{
  const { dir, store } = seeded();
  const inAlpha = store.search("빌드", { project: "alpha" });
  check("alpha 스코프에 베타 기억이 없음", !inAlpha.some((r) => r.record.slug === "베타-빌드-방법"), slugs(inAlpha).join(","));
  check("alpha 기억은 포함", inAlpha.some((r) => r.record.slug === "알파-빌드-방법"));
  check("전역 기억은 통과", inAlpha.some((r) => r.record.slug === "공통-빌드-취향"));

  const inBeta = store.search("빌드", { project: "beta" });
  check("beta 스코프에 알파 기억이 없음", !inBeta.some((r) => r.record.slug === "알파-빌드-방법"));
  check("beta 기억 + 전역 기억", inBeta.some((r) => r.record.slug === "베타-빌드-방법") && inBeta.some((r) => r.record.slug === "공통-빌드-취향"));

  const all = new MemoryStore(new Vault(dir)).search("빌드");
  check("스코프 미지정이면 전부 조회 (종전 동작)", all.length === 3, `len=${all.length}`);
}

// ── 2. list 스코프 필터
console.log("2) list_memories 프로젝트 필터");
{
  const { store } = seeded();
  check("alpha: 2건 (자기 것 + 전역)", store.list({ project: "alpha" }).length === 2);
  check("beta: 2건", store.list({ project: "beta" }).length === 2);
  check("미지정: 3건", store.list().length === 3);
  check("존재하지 않는 프로젝트: 전역 1건만", store.list({ project: "없는프로젝트" }).length === 1);
}

// ── 3. 연상(1-hop)으로도 스코프가 새지 않는다
console.log("3) 연상 확산의 스코프 누수 차단");
{
  const { dir, store } = seeded();
  store.link("알파-빌드-방법", "베타-빌드-방법", "교차 링크");
  const s = new MemoryStore(new Vault(dir));
  const inAlpha = s.search("알파", { project: "alpha" });
  check("링크된 타 프로젝트 기억이 연상으로 안 새어나옴", !inAlpha.some((r) => r.record.slug === "베타-빌드-방법"), slugs(inAlpha).join(","));
  const unscoped = new MemoryStore(new Vault(dir)).search("알파");
  check("스코프 없으면 연상이 정상 동작(대조군)", unscoped.some((r) => r.record.slug === "베타-빌드-방법"));
}

// ── 4. 하위 호환 — project 없는 구버전 노트
console.log("4) 구버전 노트 하위 호환");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-scope-old-"));
  cleanups.push(dir);
  fs.mkdirSync(path.join(dir, "memories"), { recursive: true });
  // project 키가 아예 없는 노트 (T8 이전 형식)
  fs.writeFileSync(
    path.join(dir, "memories", "구형-노트.md"),
    `---\nid: mem-old\ntitle: 구형 노트\ndescription: 예전 형식\ntype: semantic\ntags: []\nconfidence: 0.8\nstorage_strength: 3\nstatus: active\ncreated: '2026-01-01T00:00:00.000Z'\nupdated: '2026-01-01T00:00:00.000Z'\nlast_accessed: '2026-01-01T00:00:00.000Z'\nlast_reinforced: '2026-01-01T00:00:00.000Z'\naccess_count: 2\nlinks: []\nhistory: []\n---\n\n감마 델타 구형 본문.\n`,
    "utf-8",
  );
  const s = new MemoryStore(new Vault(dir));
  const rec = s.list()[0];
  check("구버전 노트가 정상 파싱됨", !!rec, "파싱 실패");
  check("project 가 undefined (전역 취급)", rec?.project === undefined, `project=${rec?.project}`);
  check("어느 스코프에서도 회상됨", s.search("감마", { project: "무엇이든" }).length === 1);
  check("기존 메타데이터 보존", rec?.storageStrength === 3 && rec?.accessCount === 2);
}

// ── 5. MCP 계층 — ASTRONRAG_PROJECT 기본 스코프
console.log("5) ASTRONRAG_PROJECT 서버 기본 스코프");
{
  const { dir } = seeded();
  async function callRecall(env, args) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      cwd: root,
      env: { ...process.env, ASTRONRAG_VAULT: dir, ASTRONRAG_STORE: "file", ...env },
    });
    const client = new Client({ name: "regress-scoping", version: "0.0.1" });
    await client.connect(transport);
    const instructions = client.getInstructions() ?? "";
    const res = await client.callTool({ name: "recall", arguments: { query: "빌드", ...args } });
    await client.close();
    return { json: JSON.parse(Object(res.content)[0].text), instructions };
  }

  const scoped = await callRecall({ ASTRONRAG_PROJECT: "alpha" }, {});
  const got = scoped.json.results.map((r) => r.slug);
  check("서버 스코프가 recall 기본값으로 적용됨", !got.includes("베타-빌드-방법"), got.join(","));
  check("자기 프로젝트 + 전역은 반환", got.includes("알파-빌드-방법") && got.includes("공통-빌드-취향"));
  // 문구는 instructions 2048자 예산에 맞춰 압축됐다 — 의미는 동일하다
  check("instructions 에 현재 스코프 안내", /Project scope "alpha"/.test(scoped.instructions));
  check("전역 저장 지침도 안내", /omit it for knowledge that should follow the user everywhere/.test(scoped.instructions));

  const escaped = await callRecall({ ASTRONRAG_PROJECT: "alpha" }, { project: "" });
  check("빈 문자열로 전체 검색 가능", escaped.json.results.map((r) => r.slug).includes("베타-빌드-방법"));

  const noScope = await callRecall({}, {});
  check("ASTRONRAG_PROJECT 없으면 전체 조회", noScope.json.results.length === 3, `len=${noScope.json.results.length}`);
  check("스코프 없으면 안내문도 없음", !/Current project scope/.test(noScope.instructions));
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT8 프로젝트 스코핑 회귀 테스트 통과 ✔");
