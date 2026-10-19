// N1/N2 회귀 테스트 — 네이티브 메모리 대체 전환 경로의 안전성.
//
// 고정하는 버그:
//   N1 `BIGBRAIN_VAULT` 를 Claude Code 네이티브 memory 디렉터리로 지정하면
//      ① 네이티브 MEMORY.md 가 BBM 형식으로 **덮어써진다** — 하필 그 파일이
//         네이티브가 매 세션 자동 주입하는 인덱스 본체다
//      ② 평면 구조라 기억은 0건으로 보인다
//      ③ 경고가 "경로 오타/드라이브 이동 의심" 이라 오진이다(경로는 정확하다)
//      ④ 1회차에 .bigbrain-vault 마커가 박혀 **2회차부터 경고가 사라진다**
//      이 저장소의 개발 머신에서 실제로 당했다(2026-07-20 자동 메모리 인덱스 소실).
//   N2 훅 주입 인덱스에 나이도 검증 지시도 없었다. recall 응답에는 age_days/
//      stale_hint 가 붙는데 **주 채널에만** 빠져 있어, 낡은 단정문이 확신도라는
//      권위만 달고 들어와 검증 없는 인용을 유발했다.
//
// 라이브 볼트·실제 네이티브 디렉터리는 건드리지 않는다 — 전부 os.tmpdir() 복제본.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const entry = path.join(root, "dist", "index.js");
const guard = path.join(here, "session-guard.mjs");
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
function freshDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bbm-nat-${tag}-`));
  cleanups.push(d);
  return d;
}

/** 실제 네이티브 memory 디렉터리 레이아웃을 복제한다 (실측 코퍼스 형식 그대로) */
function makeNativeDir() {
  const d = freshDir("dir");
  const note = (name, type) => `---
name: ${name}
description: ${name} 설명
metadata:
  node_type: memory
  type: ${type}
  originSessionId: 89358a04-3064-4b28
---

${name} 본문입니다.
`;
  fs.writeFileSync(path.join(d, "sqlite-nonascii-path-crash.md"), note("sqlite-nonascii-path-crash", "project"), "utf-8");
  fs.writeFileSync(path.join(d, "readme-always-in-sync.md"), note("readme-always-in-sync", "feedback"), "utf-8");
  const index = `# Memory Index

- [SQLite 비ASCII 경로 크래시](sqlite-nonascii-path-crash.md) — 한글 경로 DB는 abort
- [README 항상 동기화](readme-always-in-sync.md) — 변경 시 README 를 함께 갱신
`;
  fs.writeFileSync(path.join(d, "MEMORY.md"), index, "utf-8");
  return { dir: d, index };
}

async function boot(vaultDir, extraEnv = {}) {
  let stderr = "";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, BIGBRAIN_VAULT: vaultDir, ...extraEnv },
    stderr: "pipe",
  });
  const client = new Client({ name: "regress-native", version: "0.0.1" });
  await client.connect(transport);
  transport.stderr?.on("data", (d) => (stderr += d.toString()));
  await client.listTools();
  await new Promise((r) => setTimeout(r, 150));
  const instructions = client.getInstructions() ?? "";
  await client.close();
  return { instructions, stderr };
}

// ── 1. 네이티브 인덱스를 파괴하지 않는다 (N1)
console.log("1) 네이티브 MEMORY.md 무손상");
{
  const { dir, index } = makeNativeDir();
  await boot(dir);
  const after = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf-8");
  // ★ 패치 전 실패: BBM 형식으로 덮어써져 네이티브 인덱스가 통째로 사라졌다
  check("MEMORY.md 가 바이트 단위로 보존됨", after === index, after.slice(0, 120));
  check("사람이 읽는 제목이 살아있음", /SQLite 비ASCII 경로 크래시/.test(after));
  check("네이티브 노트 파일도 무손상", fs.existsSync(path.join(dir, "sqlite-nonascii-path-crash.md")));
  // 남의 디렉터리에 우리 마커를 심지 않는다 — 마커가 다음 기동의 경고를 삼킨다
  check("마커를 심지 않음", !fs.existsSync(path.join(dir, ".bigbrain-vault")));
}

// ── 2. 경고가 정확하고, 반복 기동에도 사라지지 않는다 (N1)
console.log("2) 경고의 정확성과 지속성");
{
  const { dir } = makeNativeDir();
  const runs = [await boot(dir), await boot(dir), await boot(dir)];
  // ★ 패치 전 실패: 1회차 마커 생성 → 2회차부터 경고 소멸(사고가 사고를 은폐)
  runs.forEach((r, i) => {
    check(`${i + 1}회차에도 경고 유지`, /NATIVE memory directory/.test(r.instructions), r.instructions.slice(0, 160));
  });
  const first = runs[0];
  check("오진 문구(경로 오타 의심)를 쓰지 않음", !/path may be wrong/.test(first.instructions), first.instructions.slice(0, 200));
  check("기억이 소실된 게 아님을 명시", /NOT lost, just invisible/.test(first.instructions));
  check("조치(import:native)를 지시", /import:native/.test(first.instructions));
  check("사람도 보게 stderr 에도 출력", /NATIVE memory directory/.test(first.stderr), first.stderr.slice(0, 200));
}

// ── 3. 정상 볼트는 종전과 완전히 동일하다 (N1 오탐 방지)
console.log("3) 정상 볼트 오탐 없음");
{
  const dir = freshDir("ok");
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "정상 기억", description: "설명", content: "본문", type: "semantic" });
  const r = await boot(dir);
  check("네이티브 경고 없음", !/NATIVE memory directory/.test(r.instructions), r.instructions.slice(0, 160));
  check("인덱스는 정상 생성됨", /BigBrainMemory 인덱스/.test(fs.readFileSync(path.join(dir, "MEMORY.md"), "utf-8")));
  check("마커도 정상 생성됨", fs.existsSync(path.join(dir, ".bigbrain-vault")));

  // Obsidian 사용자가 볼트 루트에 둔 평범한 노트는 네이티브가 아니다
  fs.writeFileSync(path.join(dir, "내-메모.md"), "# 그냥 노트\n\n본문", "utf-8");
  fs.writeFileSync(path.join(dir, "프론트매터-노트.md"), "---\ntitle: 무언가\ntags: [a]\n---\n\n본문", "utf-8");
  const r2 = await boot(dir);
  check("일반 마크다운 노트를 네이티브로 오인하지 않음", !/NATIVE memory directory/.test(r2.instructions), r2.instructions.slice(0, 160));
}

// ── 4. 주입 인덱스가 나이를 싣는다 (N2)
console.log("4) 주입 채널의 나이 표기");
{
  const dir = freshDir("age");
  const s = new MemoryStore(new Vault(dir));
  const fresh = s.remember({ title: "어제 갱신", description: "설명", content: "본문", type: "semantic" });
  const old = s.remember({ title: "오래된 결론", description: "설명", content: "본문", type: "semantic" });
  // 낡은 쪽의 updated 를 90일 전으로 되감는다
  const fp = path.join(dir, "memories", `${old.record.slug}.md`);
  const past = new Date(Date.now() - 90 * 86_400_000).toISOString();
  fs.writeFileSync(fp, fs.readFileSync(fp, "utf-8").replace(/^updated: .*$/m, `updated: "${past}"`), "utf-8");
  s.regenerateIndex();

  const md = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf-8");
  // 줄 단위로 본다 — "90일 전, 대조 필요" 가 "0일 전, 대조 필요" 를 부분문자열로
  // 포함하므로, 문서 전체에 정규식을 걸면 부정 단언이 항상 깨진다
  const lineOf = (title) => md.split("\n").find((l) => l.includes(`|${title}]]`)) ?? "";
  const freshLine = lineOf("어제 갱신");
  const oldLine = lineOf("오래된 결론");
  // ★ 패치 전 실패: 확신도만 있고 나이가 없었다
  check("갓 만든 기억에 나이 표기", /· 0일 전/.test(freshLine), freshLine);
  check("낡은 기억에 90일 전 표기", /· 90일 전/.test(oldLine), oldLine);
  check("낡은 기억에는 대조 지시", /90일 전, 대조 필요/.test(oldLine), oldLine);
  check("갓 만든 기억에는 대조 지시 없음", !/대조 필요/.test(freshLine), freshLine);
  check("확신도 표기는 유지", /확신도 0\.80/.test(freshLine), freshLine);
  void fresh;
}

// ── 5. 훅 주입 블록이 검증을 지시한다 (N2)
console.log("5) 훅 주입 블록의 검증 지시");
{
  const dir = freshDir("hook");
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "배포 절차", description: "blue-green", content: "본문", type: "procedural" });
  const out = execFileSync(process.execPath, [guard, "--start", "--vault-force", dir], {
    cwd: root,
    encoding: "utf-8",
    timeout: 15000,
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "N1", source: "startup" }),
    env: { ...process.env, BBM_STORE: "file" },
  });
  // ★ 패치 전 실패: 주입 블록에 검증 지시가 한 줄도 없었다
  check("시점 관측임을 명시", /point-in-time observations, not live state/.test(out), out.slice(-400));
  check("단정 전 소스 확인을 지시", /read the current source/.test(out), out.slice(-400));
  check("어긋나면 revise 하라고 지시", /`revise` the memory if reality moved on/.test(out), out.slice(-400));
  check("한 줄 요약이 기억 전문이 아님을 명시", /a one-line summary is not the memory/.test(out), out.slice(-400));
  check("나이가 주입 본문에 실림", /일 전/.test(out), out.slice(0, 400));
  check("종전 볼트 불일치 안내도 유지", /trust the server's tools/.test(out));

  // 임계는 BIGBRAIN_STALE_DAYS 를 따른다 — 상수가 모듈 로드 시점에 고정되므로
  // 같은 프로세스에서 env 만 바꿔선 검증되지 않는다. 별도 프로세스로 확인한다.
  const dir2 = freshDir("thr");
  const script =
    `const {Vault}=await import(${JSON.stringify(distUrl("vault.js"))});` +
    `const {MemoryStore}=await import(${JSON.stringify(distUrl("store.js"))});` +
    `const s=new MemoryStore(new Vault(${JSON.stringify(dir2)}));` +
    `s.remember({title:"임계 시험",description:"설명",content:"본문",type:"semantic"});`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf-8",
    timeout: 15000,
    env: { ...process.env, BIGBRAIN_STALE_DAYS: "0" },
  });
  const md2 = fs.readFileSync(path.join(dir2, "MEMORY.md"), "utf-8");
  check("BIGBRAIN_STALE_DAYS=0 이면 0일도 대조 필요", /0일 전, 대조 필요/.test(md2), md2);
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\n네이티브 전환 안전성 회귀 테스트 통과 ✔");
