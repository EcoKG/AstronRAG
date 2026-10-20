// AstronRAG 스모크 테스트 — 실제 MCP 클라이언트로 stdio 서버를 구동해 전체 기억 사이클을 검증
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 시험 기본값을 사용자 환경 설정과 격리한다.
for (const key of Object.keys(process.env)) {
  if (/^(?:ASTRONRAG_|BIGBRAIN_|BBM_)/.test(key) && !key.startsWith("ASTRONRAG_TEST_")) delete process.env[key];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const testTmp = path.resolve(process.env.ASTRONRAG_TEST_TMPDIR ?? os.tmpdir());
fs.mkdirSync(testTmp, { recursive: true });
const testVault = fs.mkdtempSync(path.join(testTmp, "astronrag-smoke-"));

// 기본 강화 시험은 고정 창과 확장 간격을 모두 끈다.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "index.js")],
  env: { ...process.env, ASTRONRAG_STORE: "file", ASTRONRAG_VAULT: testVault, ASTRONRAG_SPACING_MS: "0", ASTRONRAG_SPACING_ALPHA: "0" },
});
const client = new Client({ name: "smoke-test", version: "0.0.1" });

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name} ${detail}`);
  }
}

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  let json = /** @type {any} */ (JSON.parse("null"));
  try {
    json = JSON.parse(text);
  } catch {
    /* 텍스트 응답 */
  }
  return { res, text, json };
}

const toolText = (/** @type {any} */ result) => result.content[0].text;

{
  const previous = [process.env.ASTRONRAG_SPACING_MS, process.env.ASTRONRAG_SPACING_ALPHA];
  process.env.ASTRONRAG_SPACING_MS = "1000";
  process.env.ASTRONRAG_SPACING_ALPHA = "0.1";
  const { MemoryService } = await import("../dist/store.js");
  const { FileStore } = await import("../dist/stores/file-store.js");
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const directory = fs.mkdtempSync(path.join(testTmp, "astronrag-spacing-boundary-"));
  try {
    for (const offset of [-1, 0, 1]) {
      const backend = new FileStore(path.join(directory, String(offset)));
      const service = new MemoryService(backend, undefined, () => base + 200000 + offset);
      const { record } = service.remember({ title: "간격 경계", content: "결정적인 간격 회상", type: "semantic" });
      backend.updateRecord(record.slug, (current) => ({ ...current, created: new Date(base).toISOString(),
        lastReinforced: new Date(base + 190000).toISOString(), storageStrength: 2 }));
      service.search("결정적인 간격 회상", { active: true });
      const stored = backend.read(record.slug);
      check("test_recall_spacing_before_at_after_boundary", offset < 0 ? stored?.storageStrength === 2 : Number(stored?.storageStrength) > 2,
        `offset=${offset}ms strength=${stored?.storageStrength} clock=${base + 200000 + offset} alpha=0.1 window=1000`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    for (const [index, key] of ["ASTRONRAG_SPACING_MS", "ASTRONRAG_SPACING_ALPHA"].entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
  }
}

await client.connect(transport);
console.log("1) 서버 연결 및 도구 목록");
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
check(
  "8개 도구 등록",
  ["forget", "link", "list_memories", "read_memory", "recall", "reflect", "remember", "revise"].every((n) => names.includes(n)),
  `got: ${names.join(",")}`,
);

console.log("2) remember — 기억 저장 (출처 포함, 저장강도 1)");
const r1 = await call("remember", {
  title: "사용자는 TypeScript strict 모드를 선호한다",
  content: "코드 리뷰에서 사용자가 항상 strict: true 설정을 요구했다.",
  type: "preference",
  tags: ["typescript", "코딩스타일"],
  confidence: 0.9,
  source: "코드 리뷰 대화",
});
check("기억 저장됨", r1.json?.stored?.slug, r1.text.slice(0, 200));
check("초기 저장강도 = 1 (P1/Bjork)", r1.json?.stored?.storage_strength === 1, `ss=${r1.json?.stored?.storage_strength}`);
check("출처(source) 기록됨 (P8)", r1.json?.stored?.source === "코드 리뷰 대화");
const slug1 = r1.json.stored.slug;

const r2 = await call("remember", {
  title: "AstronRAG 프로젝트는 Obsidian 볼트를 저장소로 쓴다",
  content: "MCP 서버의 기억은 vault/ 아래 마크다운 파일로 저장되며 Obsidian에서 열 수 있다.",
  type: "semantic",
  tags: ["astronrag", "obsidian"],
});
const slug2 = r2.json.stored.slug;
check("두 번째 기억 저장됨", !!slug2);

console.log("3) 유사 기억 탐지");
const r3 = await call("remember", {
  title: "사용자는 TypeScript strict 모드 설정을 좋아한다",
  content: "중복 테스트용.",
  type: "preference",
});
check("유사 기억 감지됨", (r3.json?.similar_existing_memories ?? []).length >= 1, r3.text.slice(0, 300));
await call("forget", { id: r3.json.stored.slug, reason: "중복 테스트 정리" });

console.log("4) recall — 회상 및 강화");
const r4 = await call("recall", { query: "typescript strict 선호" });
check("회상 결과 존재", (r4.json?.results ?? []).length >= 1);
check("가장 관련된 기억이 1위", r4.json?.results?.[0]?.slug === slug1, `top=${r4.json?.results?.[0]?.slug}`);

console.log("5) link — 연상 연결");
const r5 = await call("link", { source: slug1, target: slug2, relation: "같은 프로젝트 맥락" });
check("양방향 링크 생성", r5.json?.linked?.source?.links?.includes(slug2) && r5.json?.linked?.target?.links?.includes(slug1));

const r5b = await call("recall", { query: "typescript strict" });
const assocFound = (r5b.json?.results ?? []).some((r) => r.slug === slug2);
check("연상(1-hop) 기억이 함께 회상됨", assocFound, r5b.text.slice(0, 400));

console.log("6) revise — 기억 교정");
const r6 = await call("revise", {
  id: slug1,
  reason: "사용자가 일부 프로젝트에서는 strict 해제를 허용한다고 정정",
  content: "사용자는 기본적으로 strict: true를 선호하지만, 레거시 프로젝트에서는 예외를 허용한다.",
  confidence: 0.75,
});
check("교정 반영 + 이력 기록", r6.json?.revised?.confidence === 0.75 && r6.json?.revised?.history?.some((h) => h.includes("revised")));

console.log("7) 회상 강화 확인 — 능동 recall이 저장강도를 올린다 (P4 검사효과, 간격게이트 0)");
const before = (await call("list_memories")).json?.memories?.find((memory) => memory.slug === slug1);
const ssBefore = before.storage_strength;
await call("recall", { query: "typescript strict 선호 모드" });
const after = (await call("list_memories")).json?.memories?.find((memory) => memory.slug === slug1);
check("test_smoke_active_recall_strength_uses_nonreinforcing_baseline", after.storage_strength > ssBefore, `${ssBefore} -> ${after.storage_strength}`);
check("access_count 누적", after.access_count >= 2, `count=${after.access_count}`);

console.log("8) 간격효과 — 게이트가 켜지면 벼락치기 반복이 저장강도를 부풀리지 않는다 (P3)");
{
  const gatedVault = fs.mkdtempSync(path.join(testTmp, "astronrag-smoke-gated-"));
  const t2 = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "index.js")],
    env: { ...process.env, ASTRONRAG_STORE: "file", ASTRONRAG_VAULT: gatedVault, ASTRONRAG_SPACING_MS: "600000" }, // 10분 게이트
  });
  const c2 = new Client({ name: "gated", version: "0.0.1" });
  await c2.connect(t2);
  const g = JSON.parse(toolText(await c2.callTool({ name: "remember", arguments: { title: "간격 테스트 기억", content: "벼락치기 반복 강화 방지 검증.", type: "semantic" } })));
  const gslug = g.stored.slug;
  for (let i = 0; i < 4; i++) await c2.callTool({ name: "recall", arguments: { query: "간격 테스트 기억" } });
  const gAfter = JSON.parse(toolText(await c2.callTool({ name: "read_memory", arguments: { id: gslug } })));
  check("게이트 내 반복 회상은 저장강도를 1회만 올림", gAfter.storage_strength <= 2, `ss=${gAfter.storage_strength}`);
  await c2.close();
  fs.rmSync(gatedVault, { recursive: true, force: true });
}

console.log("9) reflect — 메타인지 리포트 (망각 후보는 제안만)");
const r8 = await call("reflect", {});
check("리포트에 카운트 존재", r8.json?.counts?.total >= 2, r8.text.slice(0, 300));
check("weakened/forget_candidates 필드 존재", Array.isArray(r8.json?.weakened_hard_to_recall) && Array.isArray(r8.json?.forget_candidates));

console.log("10) forget — 망각(아카이브 이동)");
const r9 = await call("forget", { id: slug2, reason: "테스트 종료" });
check("아카이브 이동", r9.json?.forgotten?.status === "archived");
const archived = await call("list_memories", { status: "archived" });
check("보관 목록으로 이동", archived.json?.memories?.some((memory) => memory.slug === slug2));

console.log("11) 볼트 파일 구조 확인");
check("MEMORY.md 인덱스 생성", fs.existsSync(path.join(testVault, "MEMORY.md")));
const active = await call("list_memories");
check("망각된 기억이 활성 목록에 부활하지 않음", !active.json?.memories?.some((memory) => [r3.json.stored.slug, slug2].includes(memory.slug)));
const linked = (await call("read_memory", { id: slug1 })).json;
check("연결 정보 보존", linked.links.includes(slug2));

await client.close();
fs.rmSync(testVault, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\n모든 스모크 테스트 통과 ✔");
