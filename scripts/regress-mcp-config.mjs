// T0 회귀 테스트 — .mcp.json 의 서버 스폰 계약이 실제로 동작하는지 검증한다.
//
// 고정하는 버그(감사 E3): .mcp.json 이 존재하지 않는 D:/AstronRAG 를 가리켜
// 이 저장소를 프로젝트로 열면 서버가 'Cannot find module' 로 즉사하는데,
// 클라이언트에는 에러가 노출되지 않아 "기억이 원래 없는" 것처럼 보였다.
//
// 라이브 볼트 보호(GOAL.md 공통규칙 1): 서버를 기본 설정 그대로 띄우면
// 기동 시 regenerateIndex() 가 <repo>/vault/MEMORY.md 를 재작성한다.
// 따라서 스폰 검증은 임시 볼트로 하고, "env 없으면 <repo>/vault 로 해석된다"는
// index.ts:11-14 의 계약은 같은 식을 재계산하는 정적 단언으로 확인한다.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import crypto from "node:crypto";
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
const testTmpDir = path.resolve(process.env.ASTRONRAG_TEST_TMPDIR ?? os.tmpdir());
fs.mkdirSync(testTmpDir, { recursive: true });

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name} ${detail}`);
  }
}

function removeTree(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) removeTree(target);
    else fs.unlinkSync(target);
  }
  fs.rmdirSync(directory);
}

async function mcp_config_astronrag_entrypoint() {
  console.log("mcp_config_astronrag_entrypoint");
  console.log("1) .mcp.json 파싱 및 스폰 계약");
  const cfgPath = path.join(root, ".mcp.json");
  check(".mcp.json 존재", fs.existsSync(cfgPath), cfgPath);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  const server = cfg.mcpServers?.astronrag;
  check("mcpServers.astronrag 정의됨", !!server, JSON.stringify(cfg));
  check("command 는 node", server?.command === "node", `command=${server?.command}`);
  check("args 1개", Array.isArray(server?.args) && server.args.length === 1, JSON.stringify(server?.args));

  // 핵심 단언: 진입 파일이 저장소 기준 상대경로이고 실제로 존재해야 한다.
  // 절대경로(D:/... 같은)를 다시 넣으면 저장소 이동 시 같은 버그가 재발하므로 함께 막는다.
  const entryArg = server?.args?.[0] ?? "";
  check("args[0] 이 상대경로 (절대경로 금지)", !path.isAbsolute(entryArg), `args[0]=${entryArg}`);
  const entryPath = path.resolve(root, entryArg);
  check(
    "진입 파일이 실제로 존재 (빌드 필요)",
    entryArg.length > 0 && fs.existsSync(entryPath),
    `${entryPath} — npm run build 를 먼저 실행했는지 확인`,
  );

  console.log("2) 기본 볼트 해석 — env 없이 <repo>/vault 로 떨어지는가 (정적 검증)");
  check(
    "env.ASTRONRAG_VAULT 미지정 (기본값에 위임)",
    server?.env?.ASTRONRAG_VAULT === undefined,
    `env=${JSON.stringify(server?.env)}`,
  );
  // index.ts:14 와 동일한 식: path.resolve(dirname(진입파일), "..", "vault")
  const derivedVault = path.resolve(path.dirname(entryPath), "..", "vault");
  check(
    "기본 볼트가 <repo>/vault 로 해석됨",
    derivedVault === path.join(root, "vault"),
    `derived=${derivedVault}`,
  );

  console.log("3) 실제 스폰 — 설정 그대로(cwd=저장소 루트) 서버가 뜨는가");
  if (!server) {
    check("서버 기동 성공", false, "mcpServers.astronrag 없음");
    return;
  }
  // 라이브 볼트를 건드리지 않도록 볼트만 임시 디렉터리로 우회한다.
  const tmpVault = fs.mkdtempSync(path.join(testTmpDir, "bbm-regress-"));
  check(
    "test_mcp_config_temp_directory_uses_selected_base",
    path.dirname(tmpVault) === testTmpDir,
    `temp=${tmpVault}`,
  );
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    cwd: root, // Claude Code 가 프로젝트 스코프 서버를 띄우는 방식과 동일
    env: { ...process.env, ASTRONRAG_VAULT: tmpVault },
  });
  const client = new Client({ name: "regress-mcp-config", version: "0.0.1" });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    const expected = ["forget", "link", "list_memories", "read_memory", "recall", "recommend", "reflect", "remember", "revise"];
    const existing = tools.filter((tool) => tool.name !== "recommend").sort((a, b) => a.name.localeCompare(b.name)).map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema }));
    const schemaHash = crypto.createHash("sha256").update(JSON.stringify(existing)).digest("hex");
    check("서버 기동 성공", true);
    check(
      "test_existing_tools_contract_snapshot_unchanged",
      JSON.stringify(names) === JSON.stringify(expected) && schemaHash === "39ad221b780b67dddd5a9008496f430b6267b008ddd345211c00629f7c092141",
      `got: ${names.join(",")} schema=${schemaHash}`,
    );
    const recommend = tools.find((tool) => tool.name === "recommend");
    check(
      "recommend 입력 스키마",
      JSON.stringify(Object.keys(recommend?.inputSchema?.properties ?? {}).sort()) === JSON.stringify(["description", "platform", "role"])
        && JSON.stringify(recommend?.inputSchema?.required) === JSON.stringify(["description", "role"])
        && JSON.stringify(Reflect.get(recommend?.inputSchema?.properties?.platform ?? {}, "enum")) === JSON.stringify(["claude", "codex"]),
      JSON.stringify(recommend?.inputSchema),
    );
  } catch (err) {
    check("서버 기동 성공", false, String(err?.message ?? err));
  } finally {
    try {
      await client.close();
    } finally {
      removeTree(tmpVault);
    }
  }

  console.log("4) 라이브 볼트 무변형 확인");
  check(
    "테스트가 <repo>/vault 를 생성하지 않음",
    !fs.existsSync(path.join(root, "vault")) || fs.existsSync(path.join(root, "vault", "memories")),
    "임시 볼트로 우회했으므로 라이브 볼트 상태는 그대로여야 한다",
  );
}
await mcp_config_astronrag_entrypoint();

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT0 회귀 테스트 통과 ✔");
