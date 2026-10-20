// T39 회귀 테스트 — 버전 스탬프 단일화 + stderr 로그 위계.
//
// 고정하는 문제:
//   ① 서버 version 이 index.ts 에 하드코딩돼 package.json 과 이중 관리였다 —
//      한쪽만 올리면 클라이언트가 보는 버전과 배포 버전이 어긋난다.
//   ② 정보성 stderr(ready.)에 수준 표기가 없어 로그 수집기가 "stderr = 오류" 로
//      집계했다 — 실측에서 그렇게 잡힌 "오류" 22건이 전부 정상 기동 메시지였다.
//   ③ 실행 중인 서버가 어느 빌드인지 알 방법이 없어 "고쳤는데 왜 그대로지" 가
//      재시작 필요 여부를 확인하지 못한 채 반복됐다.
//
// 라이브 볼트는 건드리지 않는다 — 전부 os.tmpdir() 임시 볼트.

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
const entry = path.join(root, "dist", "index.js");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name} ${detail}`);
  }
}

const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-hyg-"));

let stderr = "";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  cwd: root,
  env: { ...process.env, ASTRONRAG_VAULT: vaultDir },
  stderr: "pipe",
});
const client = new Client({ name: "regress-hygiene", version: "0.0.1" });
await client.connect(transport);
transport.stderr?.on("data", (d) => {
  stderr += d.toString();
});
await client.listTools();
await new Promise((r) => setTimeout(r, 150)); // stderr 플러시 대기

const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")).version;

console.log("1) 버전 단일 출처 (package.json)");
{
  const sv = client.getServerVersion();
  check("서버가 버전을 보고함", typeof sv?.version === "string", JSON.stringify(sv));
  // ★ 패치 전: index.ts 하드코딩 — package.json 을 올려도 여기가 안 따라온다
  check("서버 버전 = package.json 버전", sv?.version === pkgVersion, `server=${sv?.version} pkg=${pkgVersion}`);
}

console.log("2) stderr 로그 위계");
{
  const lines = stderr.split("\n").filter((l) => l.includes("[AstronRAG]"));
  check("기동 로그가 있음", lines.length > 0, stderr.slice(0, 200));
  // ★ 패치 전: ready. 가 수준 표기 없이 stderr 로 나가 오류로 집계됐다
  const ready = lines.find((l) => l.includes("ready."));
  check("ready. 는 [info] 수준", ready !== undefined && ready.includes("[AstronRAG][info]"), ready);
  check("경고는 [warn] 수준", lines.filter((l) => l.includes("WARNING") || l.includes("훅이 설치돼")).every((l) => l.includes("[warn]")), lines.join(" | ").slice(0, 300));
  check("모든 자체 로그에 수준 표기", lines.every((l) => /\[AstronRAG\]\[(info|warn|error)\]/.test(l)), lines.find((l) => !/\[(info|warn|error)\]/.test(l)));
}

console.log("3) 빌드 스탬프");
{
  const ready = stderr.split("\n").find((l) => l.includes("ready.")) ?? "";
  // ★ 패치 전: 실행 중인 서버가 어느 빌드인지 알 수 없었다
  const m = /built=(\S+)/.exec(ready);
  check("ready 줄에 built= 스탬프", m !== null, ready);
  const stamp = m ? new Date(m[1]) : null;
  check("스탬프가 유효한 시각", stamp !== null && !Number.isNaN(stamp.getTime()), m?.[1]);
  const distMtime = fs.statSync(entry).mtime;
  check(
    "스탬프 = dist/index.js 의 mtime",
    stamp !== null && Math.abs(stamp.getTime() - distMtime.getTime()) < 1500,
    `stamp=${m?.[1]} mtime=${distMtime.toISOString()}`,
  );
  check("ready 줄에 버전 표기", ready.includes(`v${pkgVersion}`), ready);
}

await client.close();
fs.rmSync(vaultDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT39 위생 회귀 테스트 통과 ✔");
