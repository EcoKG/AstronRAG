// 세션 훅 회귀 테스트 — session-guard.mjs 의 볼트 해석과 무저장 감지.
//
// 고정하는 문제:
//   H1 훅이 설치 시점 경로를 박아두면, 프로젝트마다 BIGBRAIN_VAULT 로 볼트를 나누는
//      순간 훅만 옛 볼트를 계속 본다. 그러면 한 세션에서
//        훅  : "볼트에 이런 기억들이 있다"(볼트 B)
//        서버: "COLD START — this vault is EMPTY"(볼트 A)
//      라는 모순된 두 신호가 동시에 주입되고, 모델은 인덱스만 보고 저장을 건너뛴다.
//      실제로 그 분열이 관측돼(훅 3건 / 서버 빈 볼트) 실험이 통째로 무효화됐다.
//   H2 주입 블록이 출처를 안 밝히면 위 모순이 조용히 지나간다.
//   H3 Stop 훅이 세션 종료를 막으면 안 된다(종료 코드는 항상 0).
//
// 라이브 볼트는 건드리지 않는다 — 전부 os.tmpdir() 임시 볼트.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const guard = path.join(here, "session-guard.mjs");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name} ${detail}`);
  }
}

const cleanups = /** @type {string[]} */ (Array());
const testTmp = path.resolve(process.env.BBM_TEST_TMPDIR ?? os.tmpdir());
fs.mkdirSync(testTmp, { recursive: true });
function freshDir(name) {
  const d = fs.mkdtempSync(path.join(testTmp, `bbm-hook-${name}-`));
  cleanups.push(d);
  return d;
}

/** 볼트 하나를 만들고 기억 n건을 채운다 */
function makeVault(root, label, n) {
  const v = path.join(root, label);
  fs.mkdirSync(path.join(v, "memories"), { recursive: true });
  fs.writeFileSync(path.join(v, "MEMORY.md"), `# 인덱스 ${label}\n`, "utf-8");
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(v, "memories", `${label}-${i}.md`), "본문", "utf-8");
  }
  return v;
}

/** guard 실행 — { out, code }. input 은 훅이 stdin 으로 받는 이벤트 JSON. */
function run(args, cwd, input = "", extraEnv = {}) {
  try {
    const out = execFileSync(process.execPath, [guard, ...args], {
      cwd,
      encoding: "utf-8",
      timeout: 15000,
      input,
      env: { ...process.env, BBM_STORE: "file", ...extraEnv },
    });
    return { out, code: 0 };
  } catch (err) {
    return { out: err.stdout ?? "", code: err.status ?? -1 };
  }
}
const startEvent = (o = {}) => JSON.stringify({ hook_event_name: "SessionStart", ...o });
const stopEvent = (o = {}) => JSON.stringify({ hook_event_name: "Stop", ...o });
const readMarkerRaw = (v) => fs.readFileSync(path.join(v, ".bbm-session-start"), "utf-8").trim();
const addMemory = (v, n) => fs.writeFileSync(path.join(v, "memories", `${n}.md`), "x", "utf-8");
/**
 * Stop 훅 출력에서 **모델에 실제로 전달되는 본문**을 꺼낸다 (도달하지 않으면 "").
 * 평문 문자열을 검사하면 안 된다 — Stop 의 평문 stdout 은 디버그 로그로만 가므로,
 * 문자열 단언은 "아무에게도 도달하지 않는 경고" 도 통과시킨다(실제 6일간 그랬다).
 */
const stopContext = (out) => {
  try {
    return JSON.parse(out)?.hookSpecificOutput?.additionalContext ?? "";
  } catch {
    return "";
  }
};

// ── 1. 실행 시점 볼트 해석 (H1)
console.log("1) 실행 시점 볼트 해석 — 프로젝트 설정을 따라간다");
{
  const root = freshDir("resolve");
  const vaultA = makeVault(root, "A", 0); // 설치 시점 값
  const vaultB = makeVault(root, "B", 2); // 프로젝트가 실제로 쓰는 볼트
  const proj = path.join(root, "proj");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, ".mcp.json"),
    JSON.stringify({ mcpServers: { bigbrainmemory: { env: { BIGBRAIN_VAULT: vaultB } } } }),
    "utf-8",
  );

  const auto = run(["--start", "--vault", vaultA], proj);
  check("프로젝트 .mcp.json 의 볼트를 따라감", auto.out.includes(vaultB.replace(/\\/g, "/")), auto.out.slice(0, 200));
  check("설치 시점 볼트를 쓰지 않음", !auto.out.includes(`vault="${vaultA.replace(/\\/g, "/")}"`));

  // 사용자가 명시한 경우엔 그 의도가 이긴다
  const forced = run(["--start", "--vault-force", vaultA], proj);
  check("--vault-force 는 자동탐지를 이김", forced.out.includes(`vault="${vaultA.replace(/\\/g, "/")}"`), forced.out.slice(0, 200));
}

// ── 2. 주입 블록이 출처를 밝힌다 (H2)
console.log("2) 주입 블록의 출처 표기");
{
  const root = freshDir("attr");
  const v = makeVault(root, "V", 3);
  const { out } = run(["--start", "--vault-force", v], root);
  check("볼트 경로 표기", out.includes(`vault="${v.replace(/\\/g, "/")}"`), out.slice(0, 200));
  check("기억 건수 표기", out.includes('memories="3"'), out.slice(0, 200));
  check("불일치 시 서버를 신뢰하라는 안내", /different vault|EMPTY/.test(out));
  check("인덱스 본문 포함", out.includes("# 인덱스 V"));
}

// ── 2-b. 콜드 스타트에도 주입한다 (H4)
//
// 고정하는 버그: 예전에는 MEMORY.md 본문이 비면 침묵했다. 그 침묵이 자기강화 루프를
// 만들었다 — 볼트가 빔 → 주입 없음 → 모델이 메모리 존재를 인지 못 함 → 저장 0건 →
// 다음 세션도 빔. 대조 실험에서 서버 instructions 의 COLD START 문구는 양쪽 세션 모두
// 온전히 도착했는데도, 훅 주입이 있던 쪽만 도구를 호출했다.
console.log("2-b) 콜드 스타트 주입");
{
  const root = freshDir("cold");
  const v = makeVault(root, "C", 0); // 기억 0건 — MEMORY.md 는 헤더만 있다
  const { out, code } = run(["--start", "--vault-force", v], root);
  check("빈 볼트에서도 침묵하지 않음", out.trim() !== "", `out=${JSON.stringify(out)}`);
  check("콜드 스타트임을 명시", /COLD START/.test(out), out.slice(0, 200));
  check("건수 0 을 표기", out.includes('memories="0"'), out.slice(0, 200));
  check("'비었으니 메모리가 불필요' 라는 오독을 차단", /NOT\s+evidence that memory is unneeded/.test(out));
  // 지연 로드(deferred)된 도구는 정확한 이름을 알아야 불러올 수 있다
  check("remember 도구 이름을 그대로 노출", /mcp__[A-Za-z0-9_-]*bigbrain[A-Za-z0-9_-]*__remember/i.test(out), out.slice(0, 400));
  check("recall 도구 이름도 노출", /mcp__[A-Za-z0-9_-]*bigbrain[A-Za-z0-9_-]*__recall/i.test(out));
  check("저장 시점(세션 끝이 아님)을 지시", /not at the end of the session/.test(out));
  check("종료코드 0", code === 0);

  // 설정에 등록된 실제 서버 키를 따라간다 — 키 이름은 사용자마다 다르다
  const proj = path.join(root, "proj");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, ".mcp.json"),
    JSON.stringify({ mcpServers: { "my-bigbrain": { env: { BIGBRAIN_VAULT: v } } } }),
    "utf-8",
  );
  const named = run(["--start"], proj);
  check("등록 키가 다르면 그 키로 도구 이름을 만든다", named.out.includes("mcp__my-bigbrain__remember"), named.out.slice(0, 400));

  // **이름에 bigbrain 이 없는 키도 찾아야 한다.** 종전엔 /bigbrain/i 로 키를 걸러서
  // `bbm`·`memory` 같은 이름으로 등록하면 항목을 통째로 놓쳤다. 그 결과가 특히 나쁘다 —
  // 볼트는 전역으로 새고, 도구 이름은 존재하지 않는 mcp__bigbrainmemory__* 로 나간다.
  // 지연 로드 도구는 정확한 이름으로만 부를 수 있으므로, 틀린 이름 광고는 무주입보다 나쁘다.
  const vOther = makeVault(root, "OTHER", 3);
  const proj2 = path.join(root, "proj2");
  fs.mkdirSync(proj2, { recursive: true });
  fs.writeFileSync(
    path.join(proj2, ".mcp.json"),
    JSON.stringify({ mcpServers: { bbm: { env: { BIGBRAIN_VAULT: vOther } } } }),
    "utf-8",
  );
  const odd = run(["--start"], proj2);
  check("키 이름에 bigbrain 이 없어도 볼트를 찾음", odd.out.includes(vOther.replace(/\\/g, "/")), odd.out.slice(0, 300));
  check("키 이름에 bigbrain 이 없어도 그 키로 도구 이름 생성", odd.out.includes("mcp__bbm__remember"), odd.out.slice(0, 400));

  // 실행 명령으로도 판별한다(env 를 안 쓰고 인자로 넘기는 등록 방식)
  const proj3 = path.join(root, "proj3");
  fs.mkdirSync(proj3, { recursive: true });
  fs.writeFileSync(
    path.join(proj3, ".mcp.json"),
    JSON.stringify({ mcpServers: { memory: { command: "node", args: ["/opt/bigbrainmemory/dist/index.js"] } } }),
    "utf-8",
  );
  const byCmd = run(["--start", "--vault", v], proj3);
  check("실행 명령으로도 서버를 식별", byCmd.out.includes("mcp__memory__remember"), byCmd.out.slice(0, 400));
}

// ── 2-c. 기억은 있는데 인덱스를 못 읽는 경우
console.log("2-c) MEMORY.md 손실 — 건수라도 알린다");
{
  const root = freshDir("noindex");
  const v = makeVault(root, "N", 2);
  fs.unlinkSync(path.join(v, "MEMORY.md")); // 인덱스만 유실
  const { out } = run(["--start", "--vault-force", v], root);
  check("침묵하지 않음(빈 볼트와 혼동 금지)", out.trim() !== "", `out=${JSON.stringify(out)}`);
  check("건수 2 를 알림", out.includes('memories="2"') && /2 memories are stored/.test(out), out.slice(0, 300));
  check("콜드 스타트로 오인하지 않음", !/COLD START/.test(out));
}

// ── 3. 무저장 감지 (Stop)
console.log("3) 무저장 감지");
{
  const root = freshDir("stop");
  const v = makeVault(root, "S", 1);

  const start = run(["--start", "--vault-force", v], root);
  check("start 종료코드 0", start.code === 0);
  // 마커는 JSON 이다 — session_id 를 함께 담아야 재개·압축과 새 세션을 구분할 수 있다
  check("마커에 기준 건수 기록됨", JSON.parse(readMarkerRaw(v)).count === 1, readMarkerRaw(v));

  const noSave = run(["--stop", "--vault-force", v], root);
  // ★ **전달 계약을 검사한다.** 종전에는 문구 문자열만 단언했고, 그래서 경고가 평문 stdout 으로
  // 나가 **아무에게도 도달하지 않는 6일 동안 회귀 스위트가 초록이었다.**
  // 공식 문서: exit 0 stdout 이 컨텍스트가 되는 이벤트는 UserPromptSubmit/UserPromptExpansion/
  // SessionStart 뿐이고 Stop 은 아니다. Stop 의 비차단 전달 경로는 JSON 의
  // hookSpecificOutput.additionalContext 하나뿐이다.
  let parsed = /** @type {any} */ (JSON.parse("null"));
  try {
    parsed = JSON.parse(noSave.out);
  } catch {
    /* 아래 단언이 잡는다 */
  }
  check("저장 0건이면 경고", parsed !== null, `JSON 파싱 실패: ${noSave.out.slice(0, 200)}`);
  check("Stop 이벤트로 표기", parsed?.hookSpecificOutput?.hookEventName === "Stop", JSON.stringify(parsed)?.slice(0, 200));
  check(
    "모델에 도달하는 필드로 전달(additionalContext)",
    typeof parsed?.hookSpecificOutput?.additionalContext === "string" && parsed.hookSpecificOutput.additionalContext.length > 0,
    JSON.stringify(parsed)?.slice(0, 300),
  );
  const ctx = parsed?.hookSpecificOutput?.additionalContext ?? "";
  check("무저장 사실과 현재 건수를 알림", /stored 0 new memories/.test(ctx) && /vault still holds 1/.test(ctx), ctx.slice(0, 200));
  check("호출할 도구 이름을 정확히 지목", /mcp__[\w-]+__remember/.test(ctx), ctx.slice(0, 300));
  // 종료 시점 저장은 원칙(트리거 순간 저장)의 대체가 아니라 안전망임을 스스로 밝혀야 한다
  check("자신이 폴백임을 명시", /fallback/.test(ctx), ctx.slice(-300));
  // 압축된 세션에서의 회고 저장은 요지 기반 재구성의 뒷문이다 (P8)
  check("압축 세션에서는 저장하지 말라고 지시", /compacted/.test(ctx) && /store nothing/.test(ctx), ctx.slice(-300));
  // 세션을 막는 경로(decision:block)는 쓰지 않는다 — 이 파일의 최상위 원칙
  check("세션을 막지 않음(decision 미사용)", parsed?.decision === undefined && parsed?.continue === undefined, JSON.stringify(parsed)?.slice(0, 200));
  check("경고해도 종료코드 0 (세션을 막지 않음)", noSave.code === 0);

  fs.writeFileSync(path.join(v, "memories", "새기억.md"), "z", "utf-8");
  const saved = run(["--stop", "--vault-force", v], root);
  check("저장이 있으면 침묵", saved.out.trim() === "", saved.out.slice(0, 200));
  check("침묵해도 종료코드 0", saved.code === 0);
}

// ── 4. 설정이 어긋나도 세션을 방해하지 않는다 (H3)
console.log("4) 실패 시 침묵 + 종료코드 0");
{
  const root = freshDir("silent");
  const missing = path.join(root, "없는볼트");

  const start = run(["--start", "--vault-force", missing], root);
  check("없는 볼트 — start 침묵", start.out.trim() === "", start.out.slice(0, 200));
  check("없는 볼트 — 종료코드 0", start.code === 0);

  const stop = run(["--stop", "--vault-force", missing], root);
  check("마커 없으면 stop 침묵(근거 없는 경고 금지)", stop.out.trim() === "", stop.out.slice(0, 200));
  check("종료코드 0", stop.code === 0);

  const noArgs = run(["--start"], root);
  check("볼트 인자 자체가 없어도 종료코드 0", noArgs.code === 0);
}

console.log("4-b) SQLite 훅 실패 시 stdout 침묵");
{
  const root = freshDir("sqlite-silent");
  const parentFile = path.join(root, "not-a-directory");
  fs.writeFileSync(parentFile, "x");
  const result = run(
    ["--start", "--vault-force", root],
    root,
    startEvent(),
    { BBM_STORE: "sqlite", BBM_SQLITE_PATH: path.join(parentFile, "store.sqlite") },
  );
  check("test_hook_failure_keeps_stdout_empty_with_sqlite_store", result.out === "" && result.code === 0, result.out.slice(0, 200));
}

// ── 5. 마커 생명주기 (H5)
//
// 고정하는 버그: SessionStart 는 세션당 한 번이 아니라 startup/resume/clear/compact
// 각각에 발화한다. 종전처럼 매번 현재 건수를 덮어쓰면 세션 중간의 컨텍스트 압축이
// 기준선을 리셋해, 그 전에 저장한 기억이 없던 일이 되고 종료 시 오탐 경고가 난다.
// 재현: startup(0) → 2건 저장 → compact(기준선 2로 리셋) → 종료 시 "0건" 경고.
console.log("5) 마커 생명주기 — 재개·압축이 기준선을 지운다");
{
  const root = freshDir("marker");

  // 5-1. 같은 session_id 면 기준선을 보존한다
  const v1 = makeVault(root, "M1", 0);
  run(["--start", "--vault-force", v1], root, startEvent({ session_id: "S1", source: "startup" }));
  addMemory(v1, "a");
  addMemory(v1, "b");
  run(["--start", "--vault-force", v1], root, startEvent({ session_id: "S1", source: "compact" }));
  check("compact 후에도 기준선이 0 으로 보존됨", JSON.parse(readMarkerRaw(v1)).count === 0, readMarkerRaw(v1));
  const afterCompact = run(["--stop", "--vault-force", v1], root, stopEvent({ session_id: "S1" }));
  check("압축 전 저장분이 인정돼 침묵함(오탐 없음)", afterCompact.out.trim() === "", afterCompact.out.slice(0, 200));

  // 5-2. session_id 를 못 받아도 source 로 이어지는 세션을 알아본다
  const v2 = makeVault(root, "M2", 0);
  run(["--start", "--vault-force", v2], root, startEvent({ source: "startup" }));
  addMemory(v2, "a");
  run(["--start", "--vault-force", v2], root, startEvent({ source: "resume" }));
  check("session_id 없어도 resume 이면 기준선 보존", JSON.parse(readMarkerRaw(v2)).count === 0, readMarkerRaw(v2));

  // 5-3. 진짜 새 세션이면 기준선을 갱신해야 한다(안 하면 영원히 침묵)
  const v3 = makeVault(root, "M3", 0);
  run(["--start", "--vault-force", v3], root, startEvent({ session_id: "S1", source: "startup" }));
  addMemory(v3, "a");
  run(["--start", "--vault-force", v3], root, startEvent({ session_id: "S2", source: "startup" }));
  check("다른 session_id 면 기준선 갱신(1건)", JSON.parse(readMarkerRaw(v3)).count === 1, readMarkerRaw(v3));

  // 5-4. 다른 세션의 Stop 은 비교가 성립하지 않으므로 침묵
  const cross = run(["--stop", "--vault-force", v3], root, stopEvent({ session_id: "S1" }));
  check("마커를 남긴 세션과 다르면 stop 침묵", cross.out.trim() === "", cross.out.slice(0, 200));

  // 5-5. 구형(숫자만) 마커 하위 호환 — 업그레이드해도 경고가 깨지지 않아야 한다
  const v4 = makeVault(root, "M4", 2);
  fs.writeFileSync(path.join(v4, ".bbm-session-start"), "2", "utf-8");
  const legacy = run(["--stop", "--vault-force", v4], root, stopEvent({ session_id: "S9" }));
  check("구형 숫자 마커도 해석해 경고", stopContext(legacy.out) !== "", legacy.out.slice(0, 200));
}

// ── 6. 경고 빈도 (H6)
//
// 고정하는 버그: Stop 은 세션 종료가 아니라 **매 턴**(Claude 가 응답을 마칠 때마다)
// 발화한다. 그대로 두면 저장 전까지 모든 응답에 같은 경고가 붙어, 정작 봐야 할
// 신호가 소음에 묻힌다(경보 피로).
console.log("6) 경고 빈도 — Stop 은 매 턴 발화한다");
{
  const root = freshDir("nag");
  const v = makeVault(root, "N", 1);
  run(["--start", "--vault-force", v], root, startEvent({ session_id: "S1", source: "startup" }));
  const turns = /** @type {string[]} */ (Array());
  for (let turn = 0; turn < 5; turn++) {
    turns.push(run(["--stop", "--vault-force", v], root, stopEvent({ session_id: "S1" })).out.trim());
  }
  const spoke = turns.filter((t) => t !== "");
  check("5턴 동안 경고는 1회뿐", spoke.length === 1, `발화 ${spoke.length}회`);
  check("경고는 첫 턴에 나온다", turns[0] !== "", `turns=${JSON.stringify(turns.map((t) => t !== ""))}`);
  const firstCtx = stopContext(spoke[0] ?? "");
  check("세션당 1회임을 문구로 밝힘", /once per session/.test(firstCtx), firstCtx.slice(-200));
  // "새로 저장 0건" 과 "볼트 총 N건" 이 동시에 읽혀도 모순으로 보이지 않아야 한다
  check("무저장과 볼트 총량을 구분해 표현", /stored 0 new memories/.test(firstCtx) && /vault still holds \d+/.test(firstCtx), firstCtx.slice(0, 200));

  // 잡담 세션에는 남길 durable 한 사실이 없다 — 도구를 실제로 쓴 세션에만 말을 건다.
  // 줄 수로 재던 종전 방식은 실측 1439개 트랜스크립트에서 진짜 작업 세션의 38%를
  // 침묵시켰다(4줄짜리 93KB 트랜스크립트가 흔하다 — 줄 수와 작업량은 무관하다).
  const toolUse = (n) => "{\"type\":\"tool_use\"}\n".repeat(n);
  const v2 = makeVault(root, "N2", 1);
  const tpChat = path.join(root, "t-chat.jsonl");
  fs.writeFileSync(tpChat, "{}\n".repeat(400), "utf-8"); // 줄은 많지만 도구는 0회
  run(["--start", "--vault-force", v2], root, startEvent({ session_id: "S2", source: "startup" }));
  const chat = run(["--stop", "--vault-force", v2], root, stopEvent({ session_id: "S2", transcript_path: tpChat }));
  check("길지만 도구를 안 쓴 잡담 세션에는 침묵", chat.out.trim() === "", chat.out.slice(0, 200));

  const tpWork = path.join(root, "t-work.jsonl");
  fs.writeFileSync(tpWork, toolUse(4), "utf-8"); // 줄은 4개뿐이지만 실제 작업이다
  const work = run(["--stop", "--vault-force", v2], root, stopEvent({ session_id: "S2", transcript_path: tpWork }));
  check("줄 수가 적어도 도구를 썼으면 경고", stopContext(work.out) !== "", work.out.slice(0, 200));

  // 길이를 모를 때 침묵하면 안전망 자체가 사라진다
  const v3 = makeVault(root, "N3", 1);
  run(["--start", "--vault-force", v3], root, startEvent({ session_id: "S3", source: "startup" }));
  const unknown = run(["--stop", "--vault-force", v3], root, stopEvent({ session_id: "S3" }));
  check("트랜스크립트 경로를 모르면 종전대로 경고", stopContext(unknown.out) !== "", unknown.out.slice(0, 200));

  const v4 = makeVault(root, "N4", 1);
  run(["--start", "--vault-force", v4], root, startEvent({ session_id: "S4", source: "startup" }));
  const gone = run(["--stop", "--vault-force", v4], root, stopEvent({ session_id: "S4", transcript_path: path.join(root, "없음.jsonl") }));
  check("트랜스크립트가 없어도 경고(게이트 통과)", stopContext(gone.out) !== "", gone.out.slice(0, 200));

  // 서브에이전트 위임 세션은 부모 트랜스크립트에 흔적이 거의 없다 — 실제 작업은
  // 별도 컨텍스트에서 벌어졌는데 부모 기준으로는 잡담처럼 보여 게이트에 걸린다.
  // 위임을 침묵시키면 위임 경로의 저장률을 잴 수단 자체가 사라진다.
  const v5 = makeVault(root, "N5", 1);
  const tpAgent = path.join(root, "t-agent.jsonl");
  fs.writeFileSync(tpAgent, '{"type":"tool_use","name":"Agent","input":{}}\n', "utf-8"); // 도구 1회 = 게이트 미만
  run(["--start", "--vault-force", v5], root, startEvent({ session_id: "S5", source: "startup" }));
  const delegated = run(["--stop", "--vault-force", v5], root, stopEvent({ session_id: "S5", transcript_path: tpAgent }));
  check("서브에이전트에 위임한 세션도 경고 대상", stopContext(delegated.out) !== "", delegated.out.slice(0, 200));
}

// ── 5-b. 볼트 손실 감지 (H9)
//
// 고정하는 사고: 이 저장소의 라이브 볼트가 2026-07-18/19 에 19건이었는데 07-22 에 2건이었고
// archive/ 는 비어 있었다. 즉 17건이 정상 경로가 아닌 방법으로 사라졌는데 **아무도 몰랐다.**
// forget 은 삭제가 아니라 archive 이동이므로(P6) **활성+아카이브 총량은 정상적으로는 줄지 않는다.**
console.log("5-b) 볼트 손실 감지");
{
  const root = freshDir("loss");
  const v = makeVault(root, "L", 5);
  const archiveOf = (vault) => path.join(vault, "archive");

  // 1회차: 기준선 기록 (총 5건)
  run(["--start", "--vault-force", v], root, startEvent({ session_id: "L1", source: "startup" }));
  check("마커에 총량 기록", JSON.parse(readMarkerRaw(v)).total === 5, readMarkerRaw(v));

  // forget 은 이동이다 — 총량 불변이므로 경고하면 안 된다 (오탐 방지)
  fs.mkdirSync(archiveOf(v), { recursive: true });
  fs.renameSync(path.join(v, "memories", "L-0.md"), path.join(archiveOf(v), "L-0.md"));
  const forgot = run(["--start", "--vault-force", v], root, startEvent({ session_id: "L2", source: "startup" }));
  check("forget(아카이브 이동)은 손실이 아님", !/MEMORY LOSS/.test(forgot.out), forgot.out.slice(0, 200));
  check("이동 후에도 총량은 5로 유지", JSON.parse(readMarkerRaw(v)).total === 5, readMarkerRaw(v));

  // 진짜 소실 — 볼트 밖에서 파일이 사라진다
  fs.unlinkSync(path.join(v, "memories", "L-1.md"));
  fs.unlinkSync(path.join(v, "memories", "L-2.md"));
  const loss = run(["--start", "--vault-force", v], root, startEvent({ session_id: "L3", source: "startup" }));
  check("총량이 줄면 손실 경고", /MEMORY LOSS DETECTED/.test(loss.out), loss.out.slice(0, 300));
  check("몇 건 사라졌는지 명시", /held 5 memories .* holds 3 now/.test(loss.out.replace(/\n/g, " ")), loss.out.slice(0, 400));
  check("중복 저장 금지를 지시", /do NOT start re-storing/.test(loss.out), loss.out.slice(0, 500));
  check("경고해도 종료코드 0", loss.code === 0);

  // 한 번 알렸으면 기준선이 갱신돼 다음 세션에는 조용하다 (경보 피로 방지)
  const after = run(["--start", "--vault-force", v], root, startEvent({ session_id: "L4", source: "startup" }));
  check("갱신 후에는 반복 경고 없음", !/MEMORY LOSS/.test(after.out), after.out.slice(0, 200));

  // ★ 전부 사라진 경우 — 콜드 스타트 분기가 "빈 볼트는 정상" 이라고 안심시키면 안 된다
  const v2 = makeVault(root, "M", 3);
  run(["--start", "--vault-force", v2], root, startEvent({ session_id: "M1", source: "startup" }));
  for (let i = 0; i < 3; i++) fs.unlinkSync(path.join(v2, "memories", `M-${i}.md`));
  const wiped = run(["--start", "--vault-force", v2], root, startEvent({ session_id: "M2", source: "startup" }));
  check("전멸해도 손실을 먼저 알림", /MEMORY LOSS DETECTED/.test(wiped.out), wiped.out.slice(0, 300));
  check("손실 경고가 COLD START 보다 앞에 온다", wiped.out.indexOf("MEMORY LOSS") < wiped.out.indexOf("COLD START"), wiped.out.slice(0, 300));

  // 구형 마커(총량 없음)에는 손실 판정을 하지 않는다 — 오경보보다 침묵이 낫다
  const v3 = makeVault(root, "N", 4);
  fs.writeFileSync(path.join(v3, ".bbm-session-start"), "4", "utf-8"); // 구형 숫자 마커
  fs.unlinkSync(path.join(v3, "memories", "N-0.md"));
  const legacyMarker = run(["--start", "--vault-force", v3], root, startEvent({ session_id: "N1", source: "startup" }));
  check("구형 마커면 손실 판정 생략", !/MEMORY LOSS/.test(legacyMarker.out), legacyMarker.out.slice(0, 200));
}

// ── 6-b. 인덱스 절단을 숨기지 않는다 (H8)
//
// MAX_LINES=200 에서 조용히 잘렸다. 모델은 주입된 것이 볼트 전부라고 읽고
// 안 보이는 기억을 찾지 않는다 — 잘린 것과 없는 것이 구분되지 않는다.
console.log("6-b) 인덱스 절단 표시");
{
  const root = freshDir("trunc");
  const v = makeVault(root, "T", 300);
  fs.writeFileSync(path.join(v, "MEMORY.md"), Array.from({ length: 400 }, (_, i) => `- 항목 ${i}`).join("\n"), "utf-8");
  const big = run(["--start", "--vault-force", v], root, startEvent({ session_id: "T1", source: "startup" }));
  check("절단 사실을 명시", /index truncated at 200 lines/.test(big.out), big.out.slice(-300));
  check("전체 건수를 함께 알림", /300 memories are stored in total/.test(big.out), big.out.slice(-300));
  check("나머지 도달 경로를 안내", /reachable only via recall/.test(big.out), big.out.slice(-300));
  check("절단선 이후는 실리지 않음", !big.out.includes("- 항목 250"));

  // 안 잘렸으면 군더더기를 붙이지 않는다
  const small = makeVault(root, "S", 3);
  fs.writeFileSync(path.join(small, "MEMORY.md"), "- 하나\n- 둘\n- 셋", "utf-8");
  const fits = run(["--start", "--vault-force", small], root, startEvent({ session_id: "T2", source: "startup" }));
  check("짧은 인덱스에는 절단 문구 없음", !/truncated/.test(fits.out), fits.out.slice(0, 300));
}

// ── 7. stdin 이 없거나 깨져도 멈추지 않는다 (H7)
//
// Stop 은 매 턴 실행되므로 한 번의 지연이 대화 전체에 곱해진다. stdin 이 닫히지 않는
// 파이프로 상속돼도 훅은 반드시 즉시 끝나야 한다.
console.log("7) stdin 부재·불량 내성");
{
  const root = freshDir("stdin");
  const v = makeVault(root, "I", 2);
  const t0 = Date.now();
  const noStdin = run(["--start", "--vault-force", v], root);
  const elapsed = Date.now() - t0;
  check("stdin 없이도 즉시 종료(5초 미만)", elapsed < 5000, `${elapsed}ms`);
  check("stdin 없이도 주입은 정상", noStdin.out.includes('memories="2"'), noStdin.out.slice(0, 200));
  check("stdin 없이도 종료코드 0", noStdin.code === 0);

  const junk = run(["--start", "--vault-force", v], root, "이건 JSON 이 아닙니다{{{");
  check("깨진 stdin 이어도 종료코드 0", junk.code === 0);
  check("깨진 stdin 이어도 주입은 정상", junk.out.includes("bigbrainmemory-index"), junk.out.slice(0, 200));
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\n세션 훅 회귀 테스트 통과 ✔");
