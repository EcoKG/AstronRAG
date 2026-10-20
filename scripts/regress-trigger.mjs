// T7/T9/T10 회귀 테스트 — 회상 트리거와 상태 가시성.
//
// 고정하는 버그:
//   E1 볼트 내용이 어떤 경로로도 자동 노출되지 않아, 모델이 "무엇이 저장돼 있는지"
//      모른 채 recall 키워드를 추측해야 했다 (네이티브는 MEMORY.md 가 매 세션 주입됨)
//   E3 잘못된 ASTRONRAG_VAULT 는 조용히 빈 볼트를 새로 만들고 경고가 없어,
//      "기억 전무" 가 정상처럼 보이고 볼트가 분열됐다
//   E4 recall 결과에 시간 정보가 0개라 120일 방치 기억이 아무 표시 없이 등장했다
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
function freshDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-trig-"));
  cleanups.push(d);
  return d;
}

/** 설정 그대로 서버를 띄우고 {instructions, stderr, tools} 를 돌려준다 */
async function boot(vaultDir, extraEnv = {}) {
  let stderr = "";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, ASTRONRAG_STORE: "file", ASTRONRAG_VAULT: vaultDir, ...extraEnv },
    stderr: "pipe",
  });
  const client = new Client({ name: "regress-trigger", version: "0.0.1" });
  await client.connect(transport);
  transport.stderr?.on("data", (d) => {
    stderr += d.toString();
  });
  const { tools } = await client.listTools();
  await new Promise((r) => setTimeout(r, 120)); // stderr 플러시 대기
  const instructions = client.getInstructions() ?? "";
  await client.close();
  return { instructions, stderr, tools };
}

// ── 0. 훅 미설치 감지 (E5)
//
// 고정하는 문제: 대조 실험 60회가 SessionStart 훅을 **주 메커니즘**으로 특정했다.
//   1차(지연 로드) ON 10/10 · OFF 6/10 (p=0.0433)
//   2차(상시 로드) ON 10/10 · OFF 7/10 (p=0.1053)
//   3차(채점판)    ON  9/10 · OFF 4/10 (p=0.0286)
//   층화검정(CMH, 60회) chi2=11.16, 단측 p=0.00042
// 그런데 훅 설치는 옵트인이라, 안 깐 사용자는 조용히 35% 를 흘리면서 그 사실조차
// 모른다. 서버가 훅을 대신할 수는 없으므로(instructions 는 온전히 전달되는데도
// 행동을 못 만든다) 최선은 **없다는 사실을 크게 말하는 것**이다.
console.log("0) SessionStart 훅 미설치 감지 (E5)");
{
  const dir = freshDir();
  // HOME/USERPROFILE 을 빈 디렉터리로 돌려 "훅 미설치" 상태를 만든다
  const emptyHome = freshDir();
  const off = await boot(dir, { HOME: emptyHome, USERPROFILE: emptyHome });
  check("미설치면 instructions 에 경고", /SessionStart hook is NOT installed/.test(off.instructions), off.instructions.slice(0, 200));
  check("근거(29/30 vs 17/30)를 함께 제시", /29\/30/.test(off.instructions) && /17\/30/.test(off.instructions));
  check("조치 방법을 지시", /npm run setup:hook/.test(off.instructions));
  check("스스로 보완하라는 지시", /`recall` now and `remember` as soon as a trigger fires/.test(off.instructions), off.instructions.slice(-300));
  check("사람도 보게 stderr 에도 출력", /setup:hook/.test(off.stderr), off.stderr.slice(0, 300));
  // 경고가 붙은 상태가 예산상 최악이다 — 이때도 넘치면 안 된다
  check(`경고 포함 ${off.instructions.length}자 ≤ 2048`, off.instructions.length <= 2048);
  check("경고가 행동수칙을 밀어내지 않음", /RECALL FIRST/.test(off.instructions) && /2\. REMEMBER/.test(off.instructions));

  // 훅이 설치돼 있으면 한 줄도 나가지 않는다 — 평상시 예산을 축내면 안 된다
  const fakeHome = freshDir();
  fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, ".claude", "settings.json"),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node /x/session-guard.mjs --start" }] }] } }),
    "utf-8",
  );
  const on = await boot(dir, { HOME: fakeHome, USERPROFILE: fakeHome });
  check("설치돼 있으면 경고 없음", !/SessionStart hook is NOT installed/.test(on.instructions), on.instructions.slice(0, 200));
  check("설치돼 있으면 stderr 도 조용", !/setup:hook/.test(on.stderr), on.stderr.slice(0, 200));
  check("경고가 빠진 만큼 예산이 돌아옴", on.instructions.length < off.instructions.length);

  // 끄고 싶은 사용자를 위한 탈출구
  const opted = await boot(dir, { HOME: emptyHome, USERPROFILE: emptyHome, ASTRONRAG_HOOK_CHECK: "0" });
  check("ASTRONRAG_HOOK_CHECK=0 이면 검사 자체를 끔", !/SessionStart hook is NOT installed/.test(opted.instructions));
}

// ── 0-b. 예산이 빠듯해도 볼트 상태가 통째로 사라지지 않는다 (E6)
//
// 고정하는 회귀: 상태 블록(COLD START·스코프 안내) 적재가 all-or-nothing 이었다.
// essential + state 가 1자라도 넘치면 state 전체를 버렸고, 최종 길이는 예산 미달이라
// 초과 경고도 울리지 않아 **조용히** 사라졌다. 하필 빈 볼트 + 경고 2개가 다 붙은
// 최악 구성에서만 발생해, e315656 이 고친 "콜드 스타트 침묵" 이 그 조건에서 부활했다.
// 실측(패치 전): 긴 경로 + 볼트 경고 + 훅 경고 = 1818자인데 COLD START 탈락.
console.log("0-b) 예산 압박 시 볼트 상태 단계적 축약 (E6)");
{
  const emptyHome = freshDir();
  // 경로를 길게 만들어 VAULT_WARNING 을 부풀린다 — 예산을 미는 유일한 가변 요소다
  const deep = path.join(freshDir(), "a".repeat(60), "nested", "deeply", "vault");
  fs.mkdirSync(deep, { recursive: true });
  const worst = await boot(deep, {
    HOME: emptyHome,
    USERPROFILE: emptyHome,
    ASTRONRAG_PROJECT: "aVeryLongProjectNameToSqueezeTheBudget",
  });
  check(`최악 구성 ${worst.instructions.length}자 ≤ 2048`, worst.instructions.length <= 2048);
  check("경고 2개가 모두 살아 있음", /WARNING: ASTRONRAG_VAULT/.test(worst.instructions) && /hook is NOT installed/.test(worst.instructions));
  // ★ 이 단언이 패치 전 실패한다 — 축약형이 없으면 COLD START 가 통째로 빠졌다
  check("COLD START 는 축약해서라도 남는다", /COLD START/.test(worst.instructions), worst.instructions.slice(-400));
  check("행동수칙은 어떤 경우에도 온전", /1\. RECALL FIRST/.test(worst.instructions) && /5\. REFLECT/.test(worst.instructions));
  // ★ 침묵 제거 — 버렸으면 예산 안에 들어왔더라도 사람이 알아야 한다
  check("무엇을 줄였는지 stderr 로 보고", /볼트 상태를 줄였습니다/.test(worst.stderr), worst.stderr.slice(0, 300));

  // 여유가 있으면 축약하지 않는다 — 축약이 상시 동작이 되면 안 된다
  const roomy = freshDir();
  const ok = await boot(roomy, { ASTRONRAG_PROJECT: "p" });
  check("여유 있으면 전문 그대로", /vault is EMPTY \(0 memories\)/.test(ok.instructions) && /recall returns this project's memories/.test(ok.instructions));
  check("여유 있으면 축약 보고 없음", !/볼트 상태를 줄였습니다/.test(ok.stderr));
}

// ── 1. 인덱스가 instructions 에 실린다 (E1)
console.log("1) 기억 인덱스 자동 노출 (E1)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({
    title: "빌드는 corepack pnpm 으로",
    description: "pnpm 이 PATH 에 없어 corepack 을 거쳐야 한다",
    content: "상세 본문.",
    type: "procedural",
  });
  s.remember({
    title: "프로덕션은 I 드라이브",
    description: "설치본은 I:\\Program Files\\SimpleMailServer",
    content: "상세 본문.",
    type: "semantic",
  });

  const { instructions } = await boot(dir);
  check("기본 행동수칙이 유지됨", instructions.includes("RECALL FIRST"));
  check("인덱스 헤더 노출", /Vault index \(2 stored\)/.test(instructions), instructions.slice(-400));
  check("1번 기억 제목 노출", instructions.includes("빌드는 corepack pnpm 으로"));
  check("2번 기억 제목 노출", instructions.includes("프로덕션은 I 드라이브"));
  check("설명도 함께 노출", instructions.includes("pnpm 이 PATH 에 없어"));
  check("타입 표기 포함", instructions.includes("[procedural]") && instructions.includes("[semantic]"));
}

// ── 2. 빈 볼트(콜드 스타트)는 비어 있다고 명시하고, 오히려 지시를 강하게 준다
//
// 종전에는 빈 볼트일 때 한 문장만 내보냈고, 조기 반환 탓에 스코프 안내까지 통째로
// 빠졌다 — 설득이 가장 필요한 콜드 스타트에서 가장 약하게 말하는 역전이었다.
// 여기서는 (a) 비었다는 사실, (b) 빈 recall 을 "불필요" 로 오해하지 말라는 지시,
// (c) 즉시 저장하라는 행동 지시, (d) 스코프 안내 누락 없음 을 모두 고정한다.
console.log("2) 빈 볼트(콜드 스타트) 표기");
{
  const dir = freshDir();
  const { instructions } = await boot(dir);
  check("EMPTY 사실 노출", /vault is EMPTY/i.test(instructions), instructions.slice(-400));
  check("콜드 스타트로 명시", /COLD START/i.test(instructions), instructions.slice(-400));
  check(
    "빈 recall 을 '기억 불필요' 로 오해하지 말라는 지시",
    /NOT evidence memory is unneeded/i.test(instructions),
    instructions.slice(-400),
  );
  check(
    "즉시 저장 행동 지시(끝까지 미루지 말 것)",
    /right then, not at the end/i.test(instructions),
    instructions.slice(-400),
  );
  check("행동수칙은 그대로", instructions.includes("RECALL FIRST"));
}

// ── 2-b. 빈 볼트여도 프로젝트 스코프 안내가 사라지지 않는다 (조기 반환 버그 회귀 방지)
console.log("2-b) 빈 볼트 + 프로젝트 스코프");
{
  const dir = freshDir();
  const { instructions } = await boot(dir, { ASTRONRAG_PROJECT: "acme" });
  check("EMPTY 사실 노출", /vault is EMPTY/i.test(instructions));
  check(
    "스코프 안내가 빈 볼트에서도 실린다",
    instructions.includes('Project scope "acme"'),
    instructions.slice(-500),
  );
  check(
    "스코프별 저장 지침도 함께",
    /omit it for knowledge that should follow the user everywhere/.test(instructions),
    instructions.slice(-500),
  );
}

// ── 2-c. REMEMBER 규칙에 관측 가능한 이벤트 앵커가 있다
//
// "after learning a durable fact" 는 경계가 없어 모델이 저장 시점을 판정할 수 없었다
// (무저장 세션의 주원인). RECALL 의 "at the start of a task" 처럼 감지 가능한 사건이어야 한다.
console.log("2-c) REMEMBER 이벤트 앵커");
{
  const dir = freshDir();
  const { instructions } = await boot(dir);
  check(
    "저장 시점이 '세션 끝' 이 아님을 명시",
    /not at the end of the session/.test(instructions),
    instructions.slice(0, 900),
  );
  for (const anchor of [
    "edited a durable doc",
    "corrected you",
    "unfamiliar code",
    "non-obvious root cause",
    "convention or workflow was agreed",
  ]) {
    check(`앵커 포함: ${anchor}`, instructions.includes(anchor));
  }
  check(
    "내장 메모리와 별개 저장소임을 선언",
    instructions.includes("different store from CLAUDE.md"),
    instructions.slice(0, 1200),
  );
}

// ── 2-d. instructions 문자 예산 (클라이언트 절단 방어)
//
// 클라이언트는 MCP instructions 를 정확히 2048자에서 말없이 자른다
// (블록 2079 = 헤더 18 + 본문 2048 + "… [truncated]" 13). 서버는 3268자를
// 내보내고 있었으므로 37% 가 유실됐고, 하필 배열 맨 끝에 있던 인덱스와
// COLD START 가 가장 먼저 잘려 **E1 은 설계 이래 한 번도 도달한 적이 없었다.**
//
// 기존 회귀 15종이 이를 전부 놓친 이유는 "서버가 내보낸 문자열" 만 검사하고
// **길이를 재지 않았기** 때문이다. 이 단언이 그 구멍을 막는다.
const BUDGET = 2048;
console.log("2-d) instructions 예산 준수");
{
  const empty = freshDir();
  const e = await boot(empty);
  check(`빈 볼트 ${e.instructions.length}자 ≤ ${BUDGET}`, e.instructions.length <= BUDGET);
  check("잘렸다면 사라졌을 COLD START 가 살아있음", e.instructions.includes("COLD START"));

  // 볼트가 커져도 예산을 넘지 않고, 행동수칙이 인덱스에 밀려나지 않아야 한다.
  // remember() 는 호출마다 인덱스를 재생성해 O(n²) 이므로 파일을 직접 쓴다.
  const big = freshDir();
  fs.mkdirSync(path.join(big, "memories"), { recursive: true });
  for (let i = 0; i < 200; i++) {
    fs.writeFileSync(
      path.join(big, "memories", `대용량-기억-${i}.md`),
      `---\nid: mem-big${i}\ntitle: 대용량 기억 ${i} 제목이 제법 길어지는 경우를 가정한다\n` +
        `description: 이 기억에 대한 한 줄 설명도 짧지 않게 들어간다 ${i}\ntype: semantic\n` +
        `status: active\nconfidence: 0.8\nstorage_strength: 1\n---\n\n본문.\n`,
      "utf-8",
    );
  }
  const b = await boot(big);
  check(`200건 볼트 ${b.instructions.length}자 ≤ ${BUDGET}`, b.instructions.length <= BUDGET);
  check("행동수칙이 인덱스에 밀려나지 않음 (RECALL)", b.instructions.includes("RECALL FIRST"));
  check("행동수칙이 인덱스에 밀려나지 않음 (REMEMBER)", b.instructions.includes("2. REMEMBER"));
  check(
    "헤더가 자르기 전 총건수(200)를 말함",
    /Vault index \(200 stored, \d+ most recently updated shown\)/.test(b.instructions),
    b.instructions.slice(-250),
  );
}

// ── 3. 상한 초과 시 총건수와 표시건수를 함께 알린다
console.log("3) 인덱스 상한 처리");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  for (let i = 0; i < 7; i++) {
    s.remember({ title: `기억 번호 ${i}`, description: `설명 ${i}`, content: `본문 ${i}`, type: "semantic" });
  }
  const { instructions } = await boot(dir, { ASTRONRAG_INDEX_LIMIT: "3" });
  check("총건수 7 표기", /Vault index \(7 stored/.test(instructions), instructions.slice(-400));
  check("표시건수 3 표기", /3 most recently updated shown/.test(instructions));
  const listed = (instructions.match(/^- \[semantic\] 기억 번호 /gm) ?? []).length;
  check("실제로 3건만 나열", listed === 3, `listed=${listed}`);
  check("나머지는 recall 로 보라는 안내", /use `recall` for the rest/.test(instructions));
}

// ── 4. 잘못된 볼트 경로가 조용히 넘어가지 않는다 (E3)
console.log("4) 볼트 경로 오타 가시화 (E3)");
{
  const wrong = path.join(freshDir(), "오타난", "경로");
  const { instructions, stderr } = await boot(wrong);
  check("stderr 에 경고 출력", /WARNING: ASTRONRAG_VAULT points at/.test(stderr), stderr.slice(0, 300));
  check("instructions 첫머리에 경고 부착", instructions.startsWith("WARNING:"), instructions.slice(0, 120));
  check("중복 저장 금지 안내 포함", /do NOT start storing duplicates/.test(instructions));
  check("기동 로그에 기억 수 표기", /memories=0/.test(stderr), stderr.slice(0, 300));
  check("도구는 정상 등록 (기동 자체는 성공)", true);
}

// ── 5. 정상 볼트에는 경고가 없다 (거짓 양성 방지)
console.log("5) 정상 볼트 — 오경보 없음");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "정상 기억", description: "설명", content: "본문.", type: "semantic" });
  const { instructions, stderr } = await boot(dir);
  check("경고 없음", !/WARNING/.test(instructions), instructions.slice(0, 200));
  check("기동 로그에 memories=1", /memories=1/.test(stderr), stderr.slice(0, 300));
  check("정상 안내로 시작", instructions.startsWith("AstronRAG is a persistent"));
}

// ── 6. 마커가 있으면 빈 볼트여도 경고하지 않는다 (의도적으로 비운 경우)
console.log("6) 마커 있는 빈 볼트 — 경고 없음");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  const rec = s.remember({ title: "곧 지울 기억", description: "설명", content: "본문.", type: "semantic" }).record;
  fs.unlinkSync(path.join(dir, "memories", `${rec.slug}.md`)); // 사용자가 비운 상태
  check("마커 파일 생성돼 있음", fs.existsSync(path.join(dir, ".bigbrain-vault")));
  const { instructions, stderr } = await boot(dir);
  check("경고 없음", !/WARNING/.test(instructions));
  check("기동 로그는 memories=0", /memories=0/.test(stderr), stderr.slice(0, 200));
}

// ── 7. 격리 파일이 있으면 알린다
console.log("7) 격리 파일 존재 알림");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "멀쩡한 기억", description: "설명", content: "본문.", type: "semantic" });
  fs.writeFileSync(path.join(dir, "memories", "깨진것.md"), "---\nbad:\t: {{\n---\n", "utf-8");
  new MemoryStore(new Vault(dir)).loadAll(true); // 격리 유발

  const { stderr } = await boot(dir);
  check("기동 로그에 quarantined 표기", /quarantined=1/.test(stderr), stderr.slice(0, 300));
  check("확인 요청 메시지 출력", /vault\/quarantine\/ 확인 필요/.test(stderr));
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT7/T9 트리거·가시성 회귀 테스트 통과 ✔");
