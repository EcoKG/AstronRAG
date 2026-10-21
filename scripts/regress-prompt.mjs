// T19 회귀 테스트 — consolidate 프롬프트 등록.
//
// 고정하는 격차(감사 E6):
//   reflect 는 후보만 내놓고 실제 정리는 모델의 즉흥 판단에 맡겨져 있었다.
//   네이티브 메모리의 consolidate-memory 스킬(슬래시 호출 한 번으로 정리 절차 로드)에
//   대응하는 것이 없었다. MCP 프롬프트로 등록해 사용자가 정리를 주도할 수 있게 한다.
//
// 라이브 볼트는 건드리지 않는다 — 임시 볼트로 서버를 띄운다.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const entry = path.join(root, "dist", "index.js");

let failures = 0;
function check(name = "", cond = false, detail = "") {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name} ${detail}`);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-prompt-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  cwd: root,
  env: { ...process.env, ASTRONRAG_VAULT: dir },
});
const client = new Client({ name: "regress-prompt", version: "0.0.1" });
await client.connect(transport);

console.log("1) 프롬프트 등록");
{
  const { prompts } = await client.listPrompts();
  const names = prompts.map((p) => p.name);
  check("consolidate 프롬프트가 목록에 있음", names.includes("consolidate"), names.join(","));
  const p = prompts.find((x) => x.name === "consolidate");
  check("제목 노출", typeof p?.title === "string" && p.title.length > 0, JSON.stringify(p));
  check("설명 노출", typeof p?.description === "string" && p.description.length > 0);
  check("필수 인자 없음 (인자 없이 호출 가능)", !p?.arguments || p.arguments.every((a) => !a.required), JSON.stringify(p?.arguments));
}

console.log("2) 프롬프트 내용");
{
  const res = await client.getPrompt({ name: "consolidate", arguments: {} });
  check("메시지 1건 반환", res.messages.length === 1, `len=${res.messages.length}`);
  const content = res.messages[0]?.content;
  const text = content?.type === "text" ? content.text : "";
  check("role 이 user", res.messages[0]?.role === "user");
  check("본문이 비어있지 않음", text.length > 200, `len=${text.length}`);

  // reflect 의 모든 출력 항목에 대한 처리 지침이 있어야 실행 가능한 절차다
  for (const key of [
    "reflect",
    "possible_duplicates",
    "forget_candidates",
    "trusted_but_faded",
    "low_confidence",
    "orphans_without_links",
  ]) {
    check(`${key} 처리 지침 포함`, text.includes(key), text.slice(0, 120));
  }
  // 실제로 호출해야 할 도구들
  for (const tool of ["read_memory", "revise", "forget", "link", "list_memories", "recall"]) {
    check(`${tool} 도구 언급`, text.includes(tool));
  }
  check("파괴적 조치에 대한 안전 지침 포함", /되돌리기 어렵|삭제는/.test(text));
  check("staleness 대조 지침 포함", /age_days|stale_hint/.test(text));
  check("마지막에 재확인 단계", /다시 호출|재확인/.test(text));
}

console.log("3) 기존 기능 무회귀");
{
  const { tools } = await client.listTools();
  check("도구 11개 계약", tools.length === 11, `len=${tools.length}`);
  const res = await client.callTool({ name: "reflect", arguments: {} });
  const content = res.content;
  if (!Array.isArray(content)) throw new TypeError();
  const json = JSON.parse(content[0].text);
  check("reflect 정상 동작", typeof json.counts?.total === "number");
  check("프롬프트가 참조하는 trusted_but_faded 필드 실재", "trusted_but_faded" in json, Object.keys(json).join(","));
}

await client.close();
fs.rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT19 consolidate 프롬프트 회귀 테스트 통과 ✔");
