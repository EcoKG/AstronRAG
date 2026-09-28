// T33 회귀 테스트 — 사용 계측.
//
// 왜 이게 필요한가: 실사용 기저선을 재려고 트랜스크립트 1,492개를 전수 grep 해야 했다.
// 저장소 안에 저장률도 회상률도 재는 수단이 없었기 때문이다. 계측이 없으면
// 이후의 부호화·공고화 작업이 효과를 냈는지 판정할 수 없다(A/B 의 선행 조건).
//
// 고정하는 계약:
//   · 계측은 절대 도구 동작을 방해하지 않는다 (실패해도 조용히)
//   · **내용을 기록하지 않는다** — 질의문·본문·제목은 남기지 않는다
//   · 세션 결과는 세션당 1회만 기록된다 (Stop 은 매 턴 발화한다)
//   · 끌 수 있다
//
// 라이브 볼트는 건드리지 않는다 — 전부 os.tmpdir().

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

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name} ${detail}`);
  }
}

/** 시험이 끝나면 지울 임시 볼트 경로 목록 */
const cleanups = new Array();
const freshDir = (tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bbm-use-${tag}-`));
  cleanups.push(d);
  return d;
};
const readLog = (v) => {
  try {
    return fs
      .readFileSync(path.join(v, ".bbm-usage.jsonl"), "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

/** 서버를 띄워 도구를 호출한다 */
async function withServer(vaultDir, fn, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, BIGBRAIN_VAULT: vaultDir, ...extraEnv },
    stderr: "pipe",
  });
  const client = new Client({ name: "regress-usage", version: "0.0.1" });
  await client.connect(transport);
  const call = (name, args) => client.callTool({ name, arguments: args });
  await fn(call);
  await client.close();
}

const startEvent = (o = {}) => JSON.stringify({ hook_event_name: "SessionStart", ...o });
const stopEvent = (o = {}) => JSON.stringify({ hook_event_name: "Stop", ...o });
const runGuard = (args, cwd, input) => {
  try {
    return execFileSync(process.execPath, [guard, ...args], { cwd, encoding: "utf-8", timeout: 15000, input });
  } catch (err) {
    return err.stdout ?? "";
  }
};

// ── 1. 도구 호출이 기록된다
console.log("1) 도구 호출 기록");
{
  const v = freshDir("tools");
  await withServer(v, async (call) => {
    await call("remember", { title: "배포 절차", description: "blue-green 으로 한다", content: "본문", type: "procedural" });
    await call("recall", { query: "배포" });
    await call("recall", { query: "절대로없는키워드zzz" });
    await call("list_memories", {});
    await call("reflect", {});
  });
  const log = readLog(v);
  const tools = log.filter((e) => e.tool).map((e) => e.tool);
  check("remember 기록", tools.includes("remember"), tools.join(","));
  check("recall 기록", tools.filter((t) => t === "recall").length === 2, tools.join(","));
  check("list_memories 기록", tools.includes("list_memories"), tools.join(","));
  check("reflect 기록", tools.includes("reflect"), tools.join(","));

  const recallEvents = log.filter((e) => e.tool === "recall");
  check("0건 회상을 zeroHit 으로 표시", recallEvents.some((e) => e.zeroHit === true), JSON.stringify(recallEvents));
  check("성공 회상은 zeroHit 아님", recallEvents.some((e) => e.zeroHit === false), JSON.stringify(recallEvents));
  check("모든 이벤트에 시각", log.every((e) => typeof e.ts === "string"), JSON.stringify(log[0]));
  check("프로세스 식별자로 묶을 수 있음", log.filter((e) => e.tool).every((e) => typeof e.pid === "string"));
}

// ── 2. 내용을 기록하지 않는다 (프라이버시 계약)
//
// 로그는 사용자의 기억 그 자체가 아니라 "무엇이 몇 번 일어났는가" 만 담아야 한다.
console.log("2) 내용 비기록");
{
  const v = freshDir("priv");
  const SECRET_TITLE = "절대로그에남으면안되는제목";
  const SECRET_BODY = "절대로그에남으면안되는본문내용";
  const SECRET_QUERY = "절대로그에남으면안되는질의";
  await withServer(v, async (call) => {
    await call("remember", { title: SECRET_TITLE, description: "설명", content: SECRET_BODY, type: "semantic" });
    await call("recall", { query: SECRET_QUERY });
  });
  const raw = fs.readFileSync(path.join(v, ".bbm-usage.jsonl"), "utf-8");
  check("제목이 로그에 없음", !raw.includes(SECRET_TITLE), raw.slice(0, 300));
  check("본문이 로그에 없음", !raw.includes(SECRET_BODY), raw.slice(0, 300));
  check("질의문이 로그에 없음", !raw.includes(SECRET_QUERY), raw.slice(0, 300));
  const rec = readLog(v).find((e) => e.tool === "recall");
  check("질의는 길이만 남음", rec?.queryLen === SECRET_QUERY.length, JSON.stringify(rec));

  // 골든 질의셋을 만들 때는 명시적으로 켤 수 있어야 한다
  const v2 = freshDir("priv2");
  await withServer(v2, async (call) => await call("recall", { query: SECRET_QUERY }), { BIGBRAIN_LOG_QUERIES: "1" });
  const rec2 = readLog(v2).find((e) => e.tool === "recall");
  check("BIGBRAIN_LOG_QUERIES=1 이면 질의문 기록", rec2?.query === SECRET_QUERY, JSON.stringify(rec2));
}

// ── 2-1. 그림자 로그 — legacy·bm25f 상위 5건 일치율 수치만 남긴다 (G5)
console.log("2-1) 그림자 로그");
{
  const v = freshDir("shadow");
  const SECRET_TITLE = "그림자로그에없어야할제목";
  const SECRET_QUERY = "그림자로그에없어야할질의";
  const shadowEnv = { BIGBRAIN_SHADOW: "", BIGBRAIN_SCORER: "", BIGBRAIN_LOG_QUERIES: "" };
  await withServer(v, async (call) => {
    await call("remember", { title: `${SECRET_TITLE} 배포`, description: "설명", content: "본문", type: "semantic" });
    await call("recall", { query: `${SECRET_QUERY} 배포` });
    await call("recall", { query: "절대로없는키워드zzz" });
  }, shadowEnv);
  const raw = fs.readFileSync(path.join(v, ".bbm-usage.jsonl"), "utf-8");
  const [hit, miss] = readLog(v).filter((e) => e.tool === "recall");
  check("적중 회상에 shadowTop5 수치(0~1)", typeof hit?.shadowTop5 === "number" && hit.shadowTop5 >= 0 && hit.shadowTop5 <= 1, JSON.stringify(hit));
  check("0건 회상에는 shadowTop5 없음", miss !== undefined && !("shadowTop5" in miss), JSON.stringify(miss));
  check("그림자 로그에 질의·제목(slug) 없음", !raw.includes(SECRET_QUERY) && !raw.includes(SECRET_TITLE), raw.slice(0, 300));
  const v2 = freshDir("shadow-off");
  await withServer(v2, async (call) => {
    await call("remember", { title: "배포 절차", description: "설명", content: "본문", type: "procedural" });
    await call("recall", { query: "배포" });
  }, { ...shadowEnv, BIGBRAIN_SHADOW: "0" });
  const off = readLog(v2).find((e) => e.tool === "recall");
  check("BIGBRAIN_SHADOW=0 이면 shadowTop5 없음", off !== undefined && !("shadowTop5" in off), JSON.stringify(off));
}

// ── 3. 끌 수 있고, 꺼도 도구는 정상이다
console.log("3) 비활성화");
{
  const v = freshDir("off");
  await withServer(v, async (call) => {
    const r = await call("remember", { title: "끈-상태-저장", description: "설명", content: "본문", type: "semantic" });
    check("계측을 꺼도 저장은 정상", !r.isError, JSON.stringify(r).slice(0, 200));
  }, { BIGBRAIN_USAGE_LOG: "0" });
  check("로그 파일이 생기지 않음", !fs.existsSync(path.join(v, ".bbm-usage.jsonl")));
  check("기억은 실제로 저장됨", fs.readdirSync(path.join(v, "memories")).length === 1);
}

// ── 4. 세션 결과는 세션당 1회만 (Stop 은 매 턴 발화한다)
console.log("4) 세션 결과 1회 기록");
{
  const v = freshDir("sess");
  fs.mkdirSync(path.join(v, "memories"), { recursive: true });
  fs.writeFileSync(path.join(v, "MEMORY.md"), "# idx\n", "utf-8");
  const tp = path.join(v, "t.jsonl");
  fs.writeFileSync(tp, '{"type":"tool_use"}\n'.repeat(5), "utf-8");

  runGuard(["--start", "--vault-force", v], v, startEvent({ session_id: "U1", source: "startup" }));
  check("세션 시작이 기록됨", readLog(v).some((e) => e.event === "session_start" && e.sessionId === "U1"), JSON.stringify(readLog(v)));

  // 무저장으로 5턴 — session_end 는 1회여야 한다
  for (let i = 0; i < 5; i++) runGuard(["--stop", "--vault-force", v], v, stopEvent({ session_id: "U1", transcript_path: tp }));
  const ends = readLog(v).filter((e) => e.event === "session_end");
  check("5턴이어도 session_end 는 1회", ends.length === 1, JSON.stringify(ends));
  check("무저장으로 기록", ends[0]?.stored === 0 && ends[0]?.warned === true, JSON.stringify(ends[0]));
  check("도구 호출 수도 함께 기록", ends[0]?.toolUses === 5, JSON.stringify(ends[0]));

  // 저장이 있는 세션도 1회만 기록된다
  const v2 = freshDir("sess2");
  fs.mkdirSync(path.join(v2, "memories"), { recursive: true });
  fs.writeFileSync(path.join(v2, "MEMORY.md"), "# idx\n", "utf-8");
  runGuard(["--start", "--vault-force", v2], v2, startEvent({ session_id: "U2", source: "startup" }));
  fs.writeFileSync(path.join(v2, "memories", "새기억.md"), "x", "utf-8");
  for (let i = 0; i < 3; i++) runGuard(["--stop", "--vault-force", v2], v2, stopEvent({ session_id: "U2", transcript_path: tp }));
  const ends2 = readLog(v2).filter((e) => e.event === "session_end");
  check("저장 세션도 session_end 1회", ends2.length === 1, JSON.stringify(ends2));
  check("저장 건수가 기록됨", ends2[0]?.stored === 1, JSON.stringify(ends2[0]));
  check("저장됐으면 경고 안 함", ends2[0]?.warned === false, JSON.stringify(ends2[0]));

  // ★ 경고를 받고 **나서** 저장한 세션 — 우리가 유도하려는 바로 그 행동이다.
  // 첫 기록만 남기면 이 세션이 영원히 "저장 0" 으로 남아 지표가 개선을 못 잡는다.
  const v4 = freshDir("late");
  fs.mkdirSync(path.join(v4, "memories"), { recursive: true });
  fs.writeFileSync(path.join(v4, "MEMORY.md"), "# idx\n", "utf-8");
  runGuard(["--start", "--vault-force", v4], v4, startEvent({ session_id: "U4", source: "startup" }));
  const warn = runGuard(["--stop", "--vault-force", v4], v4, stopEvent({ session_id: "U4", transcript_path: tp }));
  check("먼저 무저장 경고", /stored 0 new memories/.test(warn), warn.slice(0, 200));
  fs.writeFileSync(path.join(v4, "memories", "뒤늦은기억.md"), "x", "utf-8"); // 경고를 보고 저장
  runGuard(["--stop", "--vault-force", v4], v4, stopEvent({ session_id: "U4", transcript_path: tp }));
  runGuard(["--stop", "--vault-force", v4], v4, stopEvent({ session_id: "U4", transcript_path: tp })); // 반복해도 1회
  const lateEnds = readLog(v4).filter((e) => e.event === "session_end");
  check("경고 뒤 저장이 별도 기록됨", lateEnds.length === 2, JSON.stringify(lateEnds));
  check("저장 기록에 경고 이력이 남음", lateEnds.some((e) => e.stored === 1 && e.warned === true), JSON.stringify(lateEnds));
  check("저장 기록도 1회로 제한", lateEnds.filter((e) => (e.stored ?? 0) > 0).length === 1, JSON.stringify(lateEnds));
  const lateOut = execFileSync(process.execPath, [path.join(here, "usage-report.mjs"), "--vault", v4, "--json"], {
    cwd: root,
    encoding: "utf-8",
    timeout: 15000,
  });
  const lateRep = JSON.parse(lateOut);
  check("리포트는 최종 결과(저장)를 취함", lateRep.sessions.storedAtLeastOne === 1, lateOut.slice(0, 400));
  check("세션이 중복 집계되지 않음", lateRep.sessions.workSessions === 1, lateOut.slice(0, 400));
  check("경고 뒤 저장을 별도 지표로 노출", lateRep.sessions.storedAfterWarning === 1, lateOut.slice(0, 400));

  // 잡담 세션은 게이트 미만으로 표시돼 분모에서 뺄 수 있어야 한다
  const v3 = freshDir("sess3");
  fs.mkdirSync(path.join(v3, "memories"), { recursive: true });
  fs.writeFileSync(path.join(v3, "MEMORY.md"), "# idx\n", "utf-8");
  const tpChat = path.join(v3, "chat.jsonl");
  fs.writeFileSync(tpChat, "{}\n".repeat(50), "utf-8");
  runGuard(["--start", "--vault-force", v3], v3, startEvent({ session_id: "U3", source: "startup" }));
  runGuard(["--stop", "--vault-force", v3], v3, stopEvent({ session_id: "U3", transcript_path: tpChat }));
  const ends3 = readLog(v3).filter((e) => e.event === "session_end");
  check("잡담 세션도 기록은 남김", ends3.length === 1, JSON.stringify(ends3));
  check("게이트 미만으로 표시", ends3[0]?.belowGate === true, JSON.stringify(ends3[0]));
}

// ── 5. 리포트가 지표를 계산한다
console.log("5) 리포트 집계");
{
  const v = freshDir("rep");
  fs.mkdirSync(path.join(v, "memories"), { recursive: true });
  fs.writeFileSync(path.join(v, "MEMORY.md"), "# idx\n", "utf-8");
  const tp = path.join(v, "t.jsonl");
  fs.writeFileSync(tp, '{"type":"tool_use"}\n'.repeat(5), "utf-8");
  // 저장한 세션 1개 + 저장 안 한 세션 1개
  runGuard(["--start", "--vault-force", v], v, startEvent({ session_id: "R1", source: "startup" }));
  fs.writeFileSync(path.join(v, "memories", "a.md"), "x", "utf-8");
  runGuard(["--stop", "--vault-force", v], v, stopEvent({ session_id: "R1", transcript_path: tp }));
  runGuard(["--start", "--vault-force", v], v, startEvent({ session_id: "R2", source: "startup" }));
  runGuard(["--stop", "--vault-force", v], v, stopEvent({ session_id: "R2", transcript_path: tp }));

  const out = execFileSync(process.execPath, [path.join(here, "usage-report.mjs"), "--vault", v, "--json"], {
    cwd: root,
    encoding: "utf-8",
    timeout: 15000,
  });
  const rep = JSON.parse(out);
  check("작업 세션 2개로 집계", rep.sessions.workSessions === 2, out.slice(0, 400));
  check("저장 세션 1개로 집계", rep.sessions.storedAtLeastOne === 1, out.slice(0, 400));
  check("저장률 50.0%", rep.sessions.storeRate === "50.0%", rep.sessions.storeRate);

  // 손상된 줄은 조용히 삼키지 않고 수를 보고한다
  fs.appendFileSync(path.join(v, ".bbm-usage.jsonl"), "{찢어진 줄\n", "utf-8");
  const out2 = execFileSync(process.execPath, [path.join(here, "usage-report.mjs"), "--vault", v, "--json"], {
    cwd: root,
    encoding: "utf-8",
    timeout: 15000,
  });
  check("손상 줄을 보고", JSON.parse(out2).window.malformedLines === 1, out2.slice(0, 300));
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT33 사용 계측 회귀 테스트 통과 ✔");
