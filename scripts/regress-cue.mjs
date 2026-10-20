// T34 회귀 테스트 — 부호화 큐 (UserPromptSubmit).
//
// 사람은 "이걸 기억해야지" 하고 기억하지 않는다. 놀라움·정정·완결 같은 계기가 그 자리에서
// 부호화를 유발한다. BBM 의 부호화 경로는 명시적 remember 호출뿐이었고, 유일한 넛지는
// Stop 훅이라 **세션이 끝날 때** 나왔다 — 그때는 맥락이 압축됐을 수 있고, 그러면 요약에서
// 재구성해 저장하게 되는데 그건 P8 이 금지하는 요지 기반 재구성이다.
//
// 고정하는 계약:
//   · 큐는 턴 **시작** 시점에 나간다 (UserPromptSubmit — stdout 이 컨텍스트가 되는 확인된 이벤트)
//   · **자동 저장 경로를 만들지 않는다** — 훅은 큐만 내고 판단은 모델이 한다
//   · 큐는 스스로 기계 휴리스틱임을 밝히고 출처·타입을 지정하지 않는다
//   · 세션당 1회 (경보 피로 방지)
//   · prompt 필드가 없는 환경에서도 동작한다 (미확인 계약에 의존하지 않는다)
//
// 라이브 볼트는 건드리지 않는다.

import { execFileSync } from "node:child_process";
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
function freshVault(tag, n = 1) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bbm-cue-${tag}-`));
  cleanups.push(d);
  fs.mkdirSync(path.join(d, "memories"), { recursive: true });
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(d, "memories", `m${i}.md`), "x", "utf-8");
  fs.writeFileSync(path.join(d, "MEMORY.md"), "# idx\n", "utf-8");
  return d;
}
const run = (args, cwd, input, env = {}) => {
  try {
    return execFileSync(process.execPath, [guard, ...args], {
      cwd,
      encoding: "utf-8",
      timeout: 15000,
      input,
      env: { ...process.env, ASTRONRAG_STORE: "file", ...env },
    });
  } catch (err) {
    return err.stdout ?? "";
  }
};
const startEv = (o = {}) => JSON.stringify({ hook_event_name: "SessionStart", ...o });
const promptEv = (o = {}) => JSON.stringify({ hook_event_name: "UserPromptSubmit", ...o });
const marker = (v) => JSON.parse(fs.readFileSync(path.join(v, ".bbm-session-start"), "utf-8"));

// ── 1. 정정 어휘가 큐를 유발한다
console.log("1) 정정 어휘 감지");
{
  const v = freshVault("lex");
  run(["--start", "--vault-force", v], v, startEv({ session_id: "C1", source: "startup" }));
  const out = run(["--prompt", "--vault-force", v], v, promptEv({ session_id: "C1", prompt: "아니야 그게 아니라 8080 포트를 쓰라고" }));
  check("정정 발화에 큐 발생", /<astronrag-cue/.test(out), out.slice(0, 300));
  check("기계 휴리스틱임을 명시", /regex guess, not an observation/.test(out), out.slice(0, 400));
  check("지금 저장하라고 지시", /now/.test(out) && /remember/.test(out), out.slice(0, 400));
  check("원문이 살아있을 때 저장하라고", /verbatim/.test(out), out.slice(0, 500));
  check("출처·타입을 스스로 정하라고", /pick .type. yourself/.test(out) && /do not infer either from this cue/.test(out), out.slice(0, 600));
  check("도구 이름을 정확히 지목", /mcp__[\w-]+__remember/.test(out), out.slice(0, 400));
  check("무시해도 된다고 명시", /ignore this and continue/.test(out), out.slice(-300));

  // 평범한 발화에는 조용하다
  const v2 = freshVault("plain");
  run(["--start", "--vault-force", v2], v2, startEv({ session_id: "C2", source: "startup" }));
  const quiet = run(["--prompt", "--vault-force", v2], v2, promptEv({ session_id: "C2", prompt: "이 파일 좀 읽어줘" }));
  check("평범한 발화에는 침묵", quiet.trim() === "", quiet.slice(0, 200));
}

// ── 2. 세션당 1회 (경보 피로 방지)
console.log("2) 세션당 1회");
{
  const v = freshVault("once");
  run(["--start", "--vault-force", v], v, startEv({ session_id: "C3", source: "startup" }));
  const outs = /** @type {string[]} */ (Array());
  for (let i = 0; i < 4; i++) {
    outs.push(run(["--prompt", "--vault-force", v], v, promptEv({ session_id: "C3", prompt: "아니야 틀렸어" })).trim());
  }
  check("4턴 정정에도 큐는 1회", outs.filter((o) => o !== "").length === 1, `발화 ${outs.filter((o) => o !== "").length}회`);
  check("첫 턴에 나옴", outs[0] !== "");
}

// ── 3. prompt 필드가 없어도 동작한다 (미확인 계약 의존 금지)
console.log("3) prompt 부재 시 턴 기반 폴백");
{
  const v = freshVault("fallback");
  run(["--start", "--vault-force", v], v, startEv({ session_id: "C4", source: "startup" }));
  const outs = /** @type {string[]} */ (Array());
  for (let i = 0; i < 3; i++) {
    // prompt 없이 온다 — 문서로 확정되지 않은 필드이므로 이 경로가 실제 환경일 수 있다
    outs.push(run(["--prompt", "--vault-force", v], v, promptEv({ session_id: "C4" }), { ASTRONRAG_CUE_TURNS: "3" }).trim());
  }
  check("임계 전에는 침묵", outs[0] === "" && outs[1] === "", outs.map((o) => o.length).join(","));
  check("임계 턴에 큐 발생", outs[2] !== "", outs[2].slice(0, 200));
  // 기준은 "세션 시작 이후" 가 아니라 "마지막 저장 이후" 다 — 긴 세션에서 그 차이가 전부다
  check("턴 근거를 밝힘", /3 turns since anything was last stored/.test(outs[2]), outs[2].slice(0, 200));
  check("턴 수가 마커에 누적됨", marker(v).turns === 3, JSON.stringify(marker(v)));
}

// ── 4. 저장은 큐를 **영구히** 끄지 않는다 — 시계를 리셋할 뿐이다
//
// ★ 이 절이 실사용에서 터진 결함을 고정한다.
// 처음 구현은 "이 세션에서 한 건이라도 저장했으면 영구 침묵" 이었다. 3시간짜리 세션에서
// 초반에 사소한 것 하나를 저장하자, 그 뒤 2시간 동안 결함 3건을 확정하고 근본 원인을
// 규명하는 내내 신호가 한 번도 나가지 않았다. 세션 최대 성과가 통째로 새어나갔는데
// **저장률 지표상으로는 성공한 세션**이었다.
console.log("4) 저장은 큐를 영구히 끄지 않는다");
{
  const v = freshVault("reset");
  run(["--start", "--vault-force", v], v, startEv({ session_id: "C5", source: "startup" }));

  // 저장 직후에는 조용하다 — 부호화가 방금 일어났으니 맞다
  fs.writeFileSync(path.join(v, "memories", "새기억.md"), "x", "utf-8");
  const right = run(["--prompt", "--vault-force", v], v, promptEv({ session_id: "C5", prompt: "아니야 틀렸어" }));
  check("저장 직후에는 침묵", right.trim() === "", right.slice(0, 200));

  // ★ 패치 전 실패: 여기서부터 영원히 침묵했다. 이제는 시계가 다시 흐른다.
  const outs = /** @type {string[]} */ (Array());
  for (let i = 0; i < 6; i++) {
    outs.push(run(["--prompt", "--vault-force", v], v, promptEv({ session_id: "C5" }), { ASTRONRAG_CUE_TURNS: "4" }).trim());
  }
  check("저장 이후에도 시간이 지나면 다시 큐", outs.some((o) => o !== ""), `발화 ${outs.filter((o) => o).length}회`);
  const cue = outs.find((o) => o !== "");
  check("마지막 저장 기준으로 센다", /turns since anything was last stored/.test(cue ?? ""), (cue ?? "").slice(0, 200));
  check("세션 중 저장이 있었음을 밝힘", /a memory was stored earlier in this session/.test(cue ?? ""), (cue ?? "").slice(0, 300));

  // 다시 저장하면 또 리셋된다
  fs.writeFileSync(path.join(v, "memories", "두번째.md"), "x", "utf-8");
  const afterSecond = run(["--prompt", "--vault-force", v], v, promptEv({ session_id: "C5" }), { ASTRONRAG_CUE_TURNS: "4" });
  check("두 번째 저장도 시계를 리셋", afterSecond.trim() === "", afterSecond.slice(0, 200));
}

// ── 4-b. 쿨다운 — 세션당 1회는 과하고 매 턴은 시끄럽다
console.log("4-b) 쿨다운");
{
  const v = freshVault("cool");
  run(["--start", "--vault-force", v], v, startEv({ session_id: "C5b", source: "startup" }));
  const outs = /** @type {string[]} */ (Array());
  for (let i = 0; i < 12; i++) {
    outs.push(
      run(["--prompt", "--vault-force", v], v, promptEv({ session_id: "C5b", prompt: "아니야 틀렸어" }), {
        ASTRONRAG_CUE_COOLDOWN: "5",
      }).trim(),
    );
  }
  const fired = outs.map((o, i) => (o !== "" ? i : -1)).filter((i) => i >= 0);
  check("12턴 연속 정정에도 매번 울리지는 않음", fired.length < 12, `발화 ${fired.length}회`);
  check("세션당 1회보다는 자주 울림", fired.length >= 2, `발화 ${fired.length}회 (${fired.join(",")})`);
  check("발화 간격이 쿨다운 이상", fired.every((t, i) => i === 0 || t - fired[i - 1] >= 5), fired.join(","));
}

// ── 5. 자동 저장 경로를 만들지 않는다 (P6 의 대칭)
console.log("5) 자동 저장 없음");
{
  const v = freshVault("noauto");
  const before = fs.readdirSync(path.join(v, "memories")).length;
  run(["--start", "--vault-force", v], v, startEv({ session_id: "C6", source: "startup" }));
  run(["--prompt", "--vault-force", v], v, promptEv({ session_id: "C6", prompt: "아니야 그게 아니라" }));
  const after = fs.readdirSync(path.join(v, "memories")).length;
  check("훅이 기억을 만들지 않음", before === after, `${before} → ${after}`);
  check("아카이브도 건드리지 않음", !fs.existsSync(path.join(v, "archive")) || fs.readdirSync(path.join(v, "archive")).length === 0);
}

// ── 6. 세션을 방해하지 않는다
console.log("6) 무해성");
{
  const v = freshVault("safe");
  // 기준선이 없으면(세션 시작을 못 봤으면) 조용히 종료
  const orphan = run(["--prompt", "--vault-force", v], v, promptEv({ session_id: "C7", prompt: "아니야" }));
  check("마커 없으면 침묵", orphan.trim() === "", orphan.slice(0, 200));

  // 다른 세션의 프롬프트면 판정하지 않는다
  run(["--start", "--vault-force", v], v, startEv({ session_id: "C8", source: "startup" }));
  const other = run(["--prompt", "--vault-force", v], v, promptEv({ session_id: "다른세션", prompt: "아니야 틀렸어" }));
  check("다른 세션이면 침묵", other.trim() === "", other.slice(0, 200));

  // stdin 이 아예 없어도 죽지 않는다
  let code = 0;
  try {
    execFileSync(process.execPath, [guard, "--prompt", "--vault-force", v], { cwd: root, encoding: "utf-8", timeout: 15000, input: "", env: { ...process.env, ASTRONRAG_STORE: "file" } });
  } catch (err) {
    code = err.status ?? -1;
  }
  check("stdin 없어도 종료코드 0", code === 0, `code=${code}`);

  // 깨진 stdin 도 마찬가지
  let code2 = 0;
  try {
    execFileSync(process.execPath, [guard, "--prompt", "--vault-force", v], { cwd: root, encoding: "utf-8", timeout: 15000, input: "JSON 아님{{{", env: { ...process.env, ASTRONRAG_STORE: "file" } });
  } catch (err) {
    code2 = err.status ?? -1;
  }
  check("깨진 stdin 이어도 종료코드 0", code2 === 0, `code=${code2}`);
}

// ── 7. 계측에 남는다
console.log("7) 계측 기록");
{
  const v = freshVault("log");
  run(["--start", "--vault-force", v], v, startEv({ session_id: "C9", source: "startup" }));
  run(["--prompt", "--vault-force", v], v, promptEv({ session_id: "C9", prompt: "아니야 그게 아니라" }));
  const log = fs
    .readFileSync(path.join(v, ".bbm-usage.jsonl"), "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const cue = log.find((e) => e.event === "cue");
  check("큐 발생이 기록됨", cue !== undefined, JSON.stringify(log));
  check("발동 사유가 기록됨", cue?.reason === "lexical", JSON.stringify(cue));
  // 내용 비기록 원칙은 여기서도 지킨다
  check("사용자 발화가 로그에 없음", !fs.readFileSync(path.join(v, ".bbm-usage.jsonl"), "utf-8").includes("그게 아니라"));
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT34 부호화 큐 회귀 테스트 통과 ✔");
