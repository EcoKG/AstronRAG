// T10 회귀 테스트 — 기억의 나이(staleness) 노출.
//
// 고정하는 버그(감사 E4):
//   recall 결과(brief)에 created/updated 가 아예 없고 read_memory(full)도 raw ISO 만
//   반환해서, 120일 방치된 기억이 아무 표시 없이 등장했다. confidence 는 진실성 축이라
//   시간 경과를 표현하지 못하고, 감쇠는 순위만 낮출 뿐 나이를 전달하지 않는다.
//   → 모델이 반년 전 코드 구조 기억을 최신 사실로 인용할 위험.
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-stale-"));
cleanups.push(dir);

// 오래된 기억 / 최근 기억을 만든다 (frontmatter 의 updated 를 되감아 모사)
{
  const s = new MemoryStore(new Vault(dir));
  const old = s.remember({ title: "낡은 지식", description: "예전 코드 구조", content: "율리시스 빅터 낡음.", type: "semantic" }).record;
  s.remember({ title: "최근 지식", description: "방금 확인함", content: "율리시스 위스키 최신.", type: "semantic" });

  const fp = path.join(dir, "memories", `${old.slug}.md`);
  const past = new Date(Date.now() - 120 * 86_400_000).toISOString();
  fs.writeFileSync(fp, fs.readFileSync(fp, "utf-8").replace(/updated: .*/, `updated: '${past}'`), "utf-8");
}

async function withClient(fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, BIGBRAIN_VAULT: dir, BBM_STORE: "file" },
  });
  const client = new Client({ name: "regress-staleness", version: "0.0.1" });
  await client.connect(transport);
  const out = await fn(client);
  await client.close();
  return out;
}
const callJson = async (client, name, args) =>
  JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

// ── 1. recall 결과에 나이가 실린다
console.log("1) recall 나이 노출 (E4)");
{
  const { hits, recallDesc } = await withClient(async (c) => ({
    hits: (await callJson(c, "recall", { query: "율리시스" })).results,
    // 나이 해석 지침은 instructions 2048자 예산 밖으로 밀려나 전달되지 않았으므로
    // recall 도구의 description 으로 옮겼다(도구 스키마는 그 예산과 별개로 전달된다).
    recallDesc: (await c.listTools()).tools.find((t) => t.name === "recall")?.description ?? "",
  }));
  const oldHit = hits.find((h) => h.slug === "낡은-지식");
  const newHit = hits.find((h) => h.slug === "최근-지식");
  check("두 기억 모두 회상됨(전제 확인)", !!oldHit && !!newHit, hits.map((h) => h.slug).join(","));
  check("age_days 필드 존재", typeof oldHit?.age_days === "number", JSON.stringify(oldHit)?.slice(0, 200));
  check("낡은 기억의 나이가 약 120일", oldHit?.age_days >= 119 && oldHit?.age_days <= 121, `age=${oldHit?.age_days}`);
  check("낡은 기억에 stale_hint 부착", typeof oldHit?.stale_hint === "string", `hint=${oldHit?.stale_hint}`);
  check("stale_hint 에 일수와 대조 지시 포함", /120일 전/.test(oldHit?.stale_hint ?? "") && /대조/.test(oldHit?.stale_hint ?? ""));
  check("최근 기억은 age_days 0", newHit?.age_days === 0, `age=${newHit?.age_days}`);
  check("최근 기억에는 stale_hint 없음", newHit?.stale_hint === undefined, `hint=${newHit?.stale_hint}`);
  check("updated 원본도 함께 노출", typeof oldHit?.updated === "string");
  check(
    "recall 도구 설명에 나이 해석 지침",
    /age_days/.test(recallDesc) && /point-in-time/.test(recallDesc),
    recallDesc.slice(-200),
  );
}

// ── 2. read_memory / list_memories 에도 일괄 반영 (brief 공유)
console.log("2) read_memory·list_memories 반영");
{
  const { one, all } = await withClient(async (c) => ({
    one: await callJson(c, "read_memory", { id: "낡은-지식" }),
    all: await callJson(c, "list_memories", {}),
  }));
  check("read_memory 에 age_days", one.age_days >= 119, `age=${one.age_days}`);
  check("read_memory 에 stale_hint", typeof one.stale_hint === "string");
  check("read_memory 의 created/body 는 그대로", typeof one.created === "string" && one.body.includes("율리시스"));
  const oldItem = all.memories.find((m) => m.slug === "낡은-지식");
  check("list_memories 에도 age_days", oldItem?.age_days >= 119, `age=${oldItem?.age_days}`);
  check("list_memories 신선한 항목엔 hint 없음", all.memories.find((m) => m.slug === "최근-지식")?.stale_hint === undefined);
}

// ── 3. 임계값 환경변수
console.log("3) BIGBRAIN_STALE_DAYS 임계 조정");
{
  async function hintAt(days) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      cwd: root,
      env: { ...process.env, BIGBRAIN_VAULT: dir, BBM_STORE: "file", BIGBRAIN_STALE_DAYS: String(days) },
    });
    const client = new Client({ name: "regress-staleness", version: "0.0.1" });
    await client.connect(transport);
    const r = await callJson(client, "recall", { query: "율리시스" });
    await client.close();
    return r.results.find((h) => h.slug === "최근-지식")?.stale_hint;
  }
  check("임계 0 이면 신선한 기억에도 hint", typeof (await hintAt(0)) === "string");
  check("임계 365 면 120일 기억도 hint 없음", (await hintAt(365)) === undefined);
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT10 staleness 회귀 테스트 통과 ✔");
