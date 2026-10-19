#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Vault } from "./vault.js";
import { MAX_ALT_QUERIES, MemoryStore, isStale, reviewOverdue } from "./store.js";
import { initUsageLog, logUsage, queryField } from "./usage.js";
import { logError, logInfo, logWarn } from "./log.js";
import { INDEX_DIR, type ScopeFilter } from "./retriever.js";
import type { MemoryRecord, SearchResult } from "./types.js";
import type { VectorRetriever } from "./vector-retriever.js";
import { ontologySchema } from "./ontology.js";
import { recommendModel, type Role } from "./recommender.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ontologyOverride = process.env.BBM_ONTOLOGY_PATH?.trim();
const ontologyPath = ontologyOverride ? path.resolve(ontologyOverride) : path.resolve(here, "..", "ontology", "ontology.json");

/** 버전은 package.json 이 단일 출처다 — 종전에는 여기 하드코딩돼 이중 관리였다 (T39) */
const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(here, "..", "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/**
 * 빌드 스탬프 — 실행 중인 서버가 **어느 빌드**인지. MCP 서버는 세션보다 오래 사는데
 * 버전 문자열은 커밋마다 바뀌지 않아서, "고쳤는데 왜 그대로지" 가 재시작 필요 여부를
 * 확인할 방법 없이 반복됐다. 자기 파일(dist/index.js)의 mtime 이 곧 빌드 시각이다.
 */
const BUILD_STAMP = (() => {
  try {
    return fs.statSync(fileURLToPath(import.meta.url)).mtime.toISOString();
  } catch {
    return "unknown";
  }
})();
const vaultDir = process.env.BIGBRAIN_VAULT
  ? path.resolve(process.env.BIGBRAIN_VAULT)
  : path.resolve(here, "..", "vault");

const vault = new Vault(vaultDir);
const store = new MemoryStore(vault);
initUsageLog(vaultDir);

/**
 * 볼트가 "지정됐는데 비어 있고 마커도 없는" 상태면 경로 오타/드라이브 이동을 의심한다 (감사 E3).
 * 이 경우 조용히 빈 볼트로 동작하면 모델이 "기억이 없다" 고 판단해 중복 저장을 시작하고
 * 볼트가 두 갈래로 분열된다. stderr 와 instructions 양쪽에 경고를 띄워 사람과 모델이
 * 모두 알아채게 한다. (BIGBRAIN_VAULT 를 지정하지 않은 첫 실행은 정상이므로 제외)
 */
function computeVaultWarning(): string | null {
  // 네이티브 메모리 디렉터리 오지정 — 마커보다 **먼저** 본다.
  // 마커 뒤에 두면 1회차에 박힌 마커가 2회차부터 이 경고를 삼켜, 사고가 사고를 은폐한다.
  // 문구도 오타 의심이 아니라 실제 상황을 말해야 한다 — 경로는 정확하고, 형식이 다르다.
  const native = vault.nativeMemoryFiles;
  if (native.length > 0) {
    return (
      `WARNING: "${vaultDir}" is a Claude Code NATIVE memory directory (${native.length} notes at its root), not a BigBrainMemory vault. ` +
      `BigBrainMemory keeps memories in a \`memories/\` subfolder, so it reads 0 here — those notes are NOT lost, just invisible. ` +
      `Its own MEMORY.md is left untouched. Tell the user to run \`npm run import:native\` (preview) then \`-- --apply\`, and point BIGBRAIN_VAULT at a separate vault directory.`
    );
  }
  const st = vault.inspect();
  if (st.memories > 0 || st.archived > 0) return null;
  if (!process.env.BIGBRAIN_VAULT) return null; // 기본 경로의 첫 실행 — 정상
  if (st.hasMarker) return null; // 진짜로 비운 볼트
  return `WARNING: BIGBRAIN_VAULT points at "${vaultDir}" but it contains no memories and no vault marker. If you expected memories here, the path may be wrong (typo, moved drive) — do NOT start storing duplicates until it is confirmed.`;
}

/**
 * **기동 직후 한 번만** 판정한다. main() 의 regenerateIndex 가 볼트 마커를 만들기 때문에,
 * 나중에 다시 계산하면 경고가 사라져 instructions 와 stderr 가 어긋난다.
 */
const VAULT_WARNING = computeVaultWarning();

/**
 * SessionStart 훅이 설치돼 있는지 본다.
 *
 * 왜 서버가 훅 설치 여부까지 신경 쓰는가 — 60회 대조 실험이 훅을 **주 메커니즘**으로
 * 특정했기 때문이다:
 *   1차(지연 로드)    ON 10/10  OFF  6/10   Fisher 단측 p=0.0433
 *   2차(상시 로드)    ON 10/10  OFF  7/10                p=0.1053
 *   3차(채점판)       ON  9/10  OFF  4/10                p=0.0286
 *   층화(CMH, 60회)                          chi2=11.16, 단측 p=0.00042
 * 라운드마다 조건이 달랐으므로 단순 통합(p=0.00022)이 아니라 층화값을 보고한다.
 * 세 라운드에서 방향이 일치했고, 훅이 없으면 저장률이 97% → 57% 로 떨어진다.
 *
 * 결정적으로 **서버는 이 역할을 대신할 수 없다.** instructions 는 온전히 전달되는데도
 * (1485자, 무절단) 행동을 만들지 못했다. 훅 출력은 대화 컨텍스트에 블록으로 들어가는
 * 반면 instructions 는 서버 메타데이터로 들어가고, 그 차이가 실제 행동 차이를 만든다.
 * MCP 에는 대화 컨텍스트에 자동 주입되는 채널이 없다(prompts·resources 는 호출해야 한다).
 *
 * 그래서 서버가 할 수 있는 최선은 **없다는 사실을 크게 말하는 것**이다. 훅 설치는
 * 옵트인이라, 안 깐 사용자는 조용히 35% 를 흘리면서 그 사실조차 모른다.
 * 자동 설치는 하지 않는다 — 전역 설정을 몰래 고치는 건 나쁜 관행이고, CI 나
 * Claude Code 를 쓰지 않는 환경에서도 실행돼 버린다.
 */
function computeHookWarning(): string | null {
  if (process.env.BIGBRAIN_HOOK_CHECK === "0") return null;
  const candidates = [
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(process.cwd(), ".claude", "settings.json"),
    path.join(process.cwd(), ".claude", "settings.local.json"),
  ];
  for (const fp of candidates) {
    try {
      if (/session-guard/.test(fs.readFileSync(fp, "utf-8"))) return null;
    } catch {
      /* 없거나 못 읽음 — 다음 후보 */
    }
  }
  return (
    "NOTE: the BigBrainMemory SessionStart hook is NOT installed. In 60 controlled trials sessions saved " +
    "29/30 with it vs 17/30 without — these instructions alone often fail. Ask the user to run " +
    "`npm run setup:hook`; until then, `recall` now and `remember` as soon as a trigger fires."
  );
}
const HOOK_WARNING = computeHookWarning();

const MEMORY_TYPE = z
  .enum(["episodic", "semantic", "procedural", "preference"])
  .describe(
    "Memory type: episodic (events/experiences), semantic (facts/knowledge), procedural (how-to/workflows), preference (user tastes/style)",
  );

/** instructions 에 실을 기억 인덱스 최대 건수 (컨텍스트 예산 보호). 0 이면 인덱스 생략 */
const INDEX_LIMIT = (() => {
  const v = Number(process.env.BIGBRAIN_INDEX_LIMIT);
  return Number.isFinite(v) && v >= 0 ? v : 40;
})();

/**
 * instructions 문자 예산 — **클라이언트가 초과분을 말없이 잘라낸다**.
 *
 * 실측: 전달된 블록 2079자 = 헤더 "## BigBrainMemory\n"(18) + 본문 2048 + "… [truncated]"(13).
 * 정확히 2^11 이다. 서버는 3268자(빈 볼트)를 내보내고 있었으므로 37% 가 유실됐다.
 *
 * 치명적이었던 것은 **잘리는 순서**다. memoryIndexLines() 출력이 배열 맨 끝에 붙어
 * 있어서 가장 먼저 잘렸고, 그 결과
 *   - E1(기억 인덱스 자동 노출)은 설계 이래 **한 번도 모델에 도달한 적이 없으며**
 *   - COLD START 지시도, age_days 해석 지침도 전량 유실됐다.
 * 회귀 테스트 15종이 이를 전부 놓친 이유는 "서버가 내보낸 문자열" 만 검사했기 때문이다.
 *
 * 그래서 이제 예산을 명시적으로 잡고, 우선순위가 낮은 것부터 **서버가 스스로 줄인다**.
 * 잘림을 클라이언트에 맡기지 않는다.
 */
const INSTRUCTIONS_BUDGET = (() => {
  const v = Number(process.env.BIGBRAIN_INSTRUCTIONS_BUDGET);
  return Number.isFinite(v) && v > 0 ? v : 2048;
})();

/**
 * 이 서버 인스턴스의 기본 프로젝트 스코프 (감사 E2).
 * 프로젝트별 .mcp.json 의 env 로 지정하면 그 프로젝트의 기억만 + 전역 기억이 회상된다.
 * 미지정이면 스코프 필터를 걸지 않는다(= 종전과 동일하게 전체 조회).
 */
const DEFAULT_PROJECT = process.env.BIGBRAIN_PROJECT?.trim() || undefined;

/**
 * 서버 기동 시점의 기억 인덱스를 instructions 에 덧붙인다 (감사 E1).
 *
 * 네이티브 메모리는 MEMORY.md 내용 자체가 매 세션 시스템 프롬프트에 주입돼
 * 모델이 "무엇이 저장돼 있는지" 를 보고 시작한다. BigBrainMemory 는 vault/MEMORY.md 를
 * 생성만 하고 어떤 경로로도 재노출하지 않아, 볼트에 무엇이 있는지 모르는 모델이
 * recall 키워드를 추측해야 했다 — 표층 문자열 검색(D1)과 겹치면 첫 질의가 0건이 되기 쉽다.
 *
 * MCP instructions 는 클라이언트가 세션 컨텍스트에 실어주므로, 여기에 제목·설명
 * 한 줄 인덱스를 붙이면 "무엇이 있는지" 가 자동 노출된다.
 * 주의: 이 스냅샷은 **서버 기동 시점** 기준이다. 항상 최신이 필요하면
 * SessionStart 훅으로 vault/MEMORY.md 를 주입하는 방법을 README 참조.
 */
/**
 * 볼트 상태 안내(짧고 가치 높음)와 인덱스 항목(길고 가변)을 분리해 돌려준다.
 * `total` 은 INDEX_LIMIT/예산으로 자르기 **전** 의 실제 건수다 — 헤더가 총계를
 * 잘못 말하면 모델이 "이게 전부" 라고 오해한다.
 */
/**
 * 볼트 상태 한 블록. `full` 이 안 들어가면 `short` 로라도 싣는다.
 *
 * 왜 축약형을 따로 들고 다니는가 — 종전에는 상태 블록 전체가 all-or-nothing 이라,
 * 예산이 30자 모자라면 272자짜리 COLD START 가 통째로 사라졌다. 그것도 조용히.
 * 하필 **가장 필요한 상황**(빈 볼트 + 경고 2개가 다 붙은 최악 구성)에서만 사라져,
 * e315656 이 고친 "콜드 스타트 침묵" 이 그 조건에서 되살아났다.
 * 실측: 긴 경로 + 볼트 경고 + 훅 경고 = 1818자(예산 2048)인데 COLD START 탈락.
 */
type StateBlock = { full: string; short: string };

function vaultState(): { state: StateBlock[]; items: string[]; total: number } {
  let list: ReturnType<typeof store.list>;
  try {
    list = store.list(DEFAULT_PROJECT ? { project: DEFAULT_PROJECT } : undefined);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logWarn(`인덱스 요약 실패(계속 진행): ${detail}`);
    // 빈 배열을 돌려주면 모델은 기억 상태 신호를 하나도 못 받는다 — 실패 사실이라도 전한다
    return {
      state: [
        {
          full: `NOTE — the vault index could not be built (${detail}). The tools still work; you just cannot see an up-front list. Do NOT infer the vault is empty: call \`recall\` before concluding anything is missing.`,
          short: "NOTE — the vault index could not be built. Do NOT infer the vault is empty; call `recall` first.",
        },
      ],
      items: [],
      total: 0,
    };
  }

  // 우선순위 순으로 담는다 — 예산이 모자라면 뒤쪽부터 축약/탈락한다.
  // COLD START 가 스코프 안내보다 앞이다: 전자는 저장 행동을 만들고, 후자는 저장할 때의 분류다.
  const state: StateBlock[] = [];
  if (list.length === 0) {
    state.push({
      full: "COLD START — this vault is EMPTY (0 memories). `recall` will return nothing; that is expected on a fresh vault and is NOT evidence memory is unneeded. Seeding it is part of this session's job: when a REMEMBER trigger fires, call `remember` right then, not at the end.",
      short: "COLD START — vault is EMPTY (0). Not evidence memory is unneeded; `remember` as soon as a trigger fires.",
    });
  }
  if (DEFAULT_PROJECT) {
    state.push({
      full: `Project scope "${DEFAULT_PROJECT}": recall returns this project's memories plus global ones. When storing, set \`project\` for facts only true here; omit it for knowledge that should follow the user everywhere.`,
      short: `Project scope "${DEFAULT_PROJECT}": set \`project\` for local-only facts, omit it for global knowledge.`,
    });
  }

  if (list.length === 0 || INDEX_LIMIT === 0) return { state, items: [], total: list.length };
  return {
    state,
    items: list.slice(0, INDEX_LIMIT).map((m) => `- [${m.type}] ${m.title} — ${m.description}`),
    total: list.length,
  };
}

/**
 * 예산(INSTRUCTIONS_BUDGET) 안에서 instructions 를 조립한다.
 *
 * 우선순위가 핵심이다. 종전에는 가장 동적이고 행동을 지시하는 내용이 배열 맨 끝에
 * 있어서 **100% 잘려나갔다**. 이제 순서를 뒤집고, 넘치면 서버가 스스로 줄인다:
 *   1) 볼트 경고        — 잘못된 볼트를 쓰는 사고를 막는 최우선 신호
 *   2) 행동수칙 1~5     — 이 서버의 유일하고 대체 불가능한 가치
 *   3) 볼트 상태        — COLD START / 스코프 안내 (짧고 행동을 바꾼다)
 *   4) 기억 인덱스      — 남는 예산만큼만. SessionStart 훅(길이 제한 없음)이 같은
 *                          역할을 하므로, 예산이 부족하면 가장 먼저 양보한다.
 * 정적 설명(confidence 축 구분, source 권고, age_days 해석)은 도구 description 으로
 * 옮겼다 — 도구 스키마는 이 예산과 별개로 전달되고, 어차피 그 도구를 쓸 때 필요하다.
 */
function buildInstructions(): string {
  const { state, items, total } = vaultState();
  // 절대 양보하지 않는 부분 — 경고와 행동수칙. 이게 이 서버만이 줄 수 있는 값이다.
  const essential = [
    ...(VAULT_WARNING ? [VAULT_WARNING, ""] : []),
    // 훅 부재 경고는 행동수칙보다 앞에 둔다 — 수칙이 왜 잘 안 먹히는지를 설명하는 전제다.
    // 훅이 깔려 있으면 이 줄은 아예 없으므로 평상시 예산을 축내지 않는다.
    ...(HOOK_WARNING ? [HOOK_WARNING, ""] : []),
    "BigBrainMemory is a persistent memory vault (Obsidian-compatible markdown). Behave like someone with long-term memory:",
    "1. RECALL FIRST — at the start of a task, or when the user mentions past context, call `recall` before answering.",
    "2. REMEMBER — call `remember` the moment any of these happens, not at the end of the session: you edited a durable doc (CLAUDE.md, README, design notes) and a decision settled; the user corrected you or stated a preference; you finished exploring unfamiliar code and formed a conclusion worth reusing; you found a non-obvious root cause; a convention or workflow was agreed. Skip trivia that only matters in this conversation.",
    "3. CORRECT — when new information contradicts a memory, `revise` it (or `forget` if it is simply wrong) instead of storing a duplicate. If `remember` reports similar memories, revise one of those.",
    "4. ASSOCIATE — `link` related memories so recall spreads across them.",
    "5. REFLECT — periodically call `reflect`, then clean up. Nothing is ever auto-deleted.",
    "This vault is a different store from CLAUDE.md and any built-in file memory, and is reached only through `recall` — storing a durable fact here is not duplication even if a project file also mentions it.",
  ];

  // 볼트 상태 설명(COLD START·스코프 안내)은 경고·수칙보다 낮은 우선순위다.
  // **머리 부분만으로 예산이 찰 수 있다** — 경고가 붙는 최악의 경우가 그렇다.
  //
  // 종전에는 여기서 상태 전체를 버렸다(all-or-nothing). 그게 회귀였다: 예산이
  // 230자 남았는데 272자짜리 블록 하나가 안 들어간다고 통째로 버렸고, 최종 길이는
  // 예산 미달이라 아래 초과 경고도 울리지 않아 **조용히** 사라졌다.
  // 이제 블록 단위로 full → short 순서로 넣고, 무엇이 줄었는지 반드시 보고한다.
  const head = [...essential];
  const degraded: string[] = [];
  for (const block of state) {
    const fits = (s: string) => [...head, s].join("\n").length <= INSTRUCTIONS_BUDGET;
    if (fits(block.full)) head.push(block.full);
    else if (fits(block.short)) {
      head.push(block.short);
      degraded.push(`축약: ${block.full.slice(0, 24)}…`);
    } else degraded.push(`탈락: ${block.full.slice(0, 24)}…`);
  }

  // 헤더는 자르기 **전** 총건수(total)를 말한다 — INDEX_LIMIT/예산으로 줄어든 수를
  // 총계로 쓰면 모델이 "이게 전부" 라고 오해해 없는 기억을 찾지 않는다.
  const indexHeader = (shownCount: number) =>
    shownCount < total
      ? `Vault index (${total} stored, ${shownCount} most recently updated shown) — use \`recall\` for the rest:`
      : `Vault index (${total} stored) — use \`recall\` for full text:`;

  let text = head.join("\n");
  if (items.length > 0) {
    // 남는 예산만큼만 인덱스를 싣는다 — 한 줄도 못 실으면 헤더째 생략한다
    const shown: string[] = [];
    for (const line of items) {
      const candidate = [...head, indexHeader(shown.length + 1), ...shown, line].join("\n");
      if (candidate.length > INSTRUCTIONS_BUDGET) break;
      shown.push(line);
    }
    if (shown.length > 0) text = [...head, indexHeader(shown.length), ...shown].join("\n");
  }

  if (text.length > INSTRUCTIONS_BUDGET) {
    // 고정부만으로 예산을 넘는 경우 — 잘림을 클라이언트에 맡기지 않고 알린다
    logWarn(`instructions ${text.length}자 — 예산 ${INSTRUCTIONS_BUDGET} 초과. 클라이언트가 뒷부분을 자를 수 있습니다.`);
  }
  // 예산 안에 들어왔더라도 **무언가를 버렸으면 말한다.** 최종 길이만 보고 판단하면
  // 버린 덕분에 예산에 들어온 경우가 정상으로 보인다 — 그 침묵이 위 회귀를 6주간 숨겼다.
  if (degraded.length > 0) {
    logWarn(`instructions 예산 ${INSTRUCTIONS_BUDGET}자에 맞추려고 볼트 상태를 줄였습니다 (${text.length}자): ${degraded.join(", ")}`);
  }
  return text;
}

const INSTRUCTIONS = buildInstructions();

const server = new McpServer(
  { name: "bigbrainmemory", version: PKG_VERSION },
  { instructions: INSTRUCTIONS },
);

/** 본문이 이 글자 수를 넘으면 사실 단위로 나누라고 경고한다(저장은 막지 않음) */
const LONG_BODY_CHARS = 1500;

/** 비밀정보로 보이는 값의 종류와 검출 패턴 — 최소 길이 조건으로 키 이름·접두사 언급은 통과시킨다 */
const SECRET_PATTERNS: [string, RegExp][] = [
  ["Anthropic API 키(sk-ant-)", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["API 키(sk-)", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["GitHub 토큰(ghp_)", /\bghp_[A-Za-z0-9]{36}\b/],
  ["AWS 액세스 키(AKIA)", /\bAKIA[0-9A-Z]{16}\b/],
  ["개인키(PRIVATE KEY)", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ["비밀번호(password=)", /password\s*=\s*["']?[^\s"']{4,}/i],
];

/** 텍스트들에서 비밀정보로 보이는 값을 찾아 종류 이름을 돌려준다(없으면 null) */
function findSecret(...texts: (string | undefined)[]): string | null {
  const joined = texts.filter((t): t is string => typeof t === "string").join("\n");
  for (const [kind, re] of SECRET_PATTERNS) if (re.test(joined)) return kind;
  return null;
}

/** 비밀정보 저장 거부 응답 */
function secretRejected(kind: string) {
  return fail(
    `저장 거부: 비밀정보(${kind})로 보이는 값이 있습니다. 값 대신 위치(예: .env 의 키 이름, 비밀 관리 도구의 항목명)를 저장하세요.`,
  );
}

/** 본문이 길면 사실 단위로 나누라는 경고 문구를 돌려준다 */
function longBodyHint(content: string | undefined): string | null {
  const n = content?.trim().length ?? 0;
  return n > LONG_BODY_CHARS
    ? `본문 ${n}자(기준 ${LONG_BODY_CHARS}자 초과) — 사실 단위로 나눠 remember 하고 [[링크]]로 이으세요.`
    : null;
}

/**
 * 기억의 나이를 응답에 실어준다 (감사 E4).
 *
 * recall 결과에는 시간 정보가 하나도 없어서, 120일 방치된 기억도 아무 표시 없이
 * 등장했다. confidence 는 "얼마나 참인가" 축이라 시간 경과를 표현하지 못하므로
 * 보완재가 되지 못한다. 감쇠는 순위만 낮출 뿐 나이를 전달하지 않는다.
 * 그 결과 모델이 반년 전 코드 구조 기억을 최신 사실로 인용할 수 있었다 —
 * 네이티브 메모리가 Read 시 자동으로 붙여주는 "N days old" 리마인더에 해당하는 것이 없었다.
 */
function ageInfo(m: MemoryRecord): Record<string, unknown> {
  const ms = Date.now() - Date.parse(m.updated);
  if (!Number.isFinite(ms)) return {};
  const ageDays = Math.max(0, Math.floor(ms / 86_400_000));
  return {
    updated: m.updated,
    age_days: ageDays,
    ...(isStale(m, ageDays)
      ? {
          stale_hint: reviewOverdue(m)
            ? `이 기억은 검토일(review_after ${m.reviewAfter})이 지났습니다(${ageDays}일 전 갱신) — 현재 코드/사실과 대조한 뒤 사용하고, 달라졌으면 revise 로 교정하세요.`
            : `이 기억은 ${ageDays}일 전에 갱신됐습니다 — 현재 코드/사실과 대조한 뒤 사용하고, 달라졌으면 revise 로 교정하세요.`,
        }
      : {}),
  };
}

function brief(m: MemoryRecord): Record<string, unknown> {
  return {
    ...ageInfo(m),
    id: m.id,
    slug: m.slug,
    title: m.title,
    description: m.description,
    type: m.type,
    tags: m.tags,
    confidence: m.confidence,
    storage_strength: Number(m.storageStrength.toFixed(2)),
    status: m.status,
    access_count: m.accessCount,
    source: m.source,
    project: m.project,
    review_after: m.reviewAfter,
    links: m.links,
  };
}

function full(m: MemoryRecord): Record<string, unknown> {
  return { ...brief(m), created: m.created, updated: m.updated, history: m.history, body: m.body };
}

function searchHit(r: SearchResult): Record<string, unknown> {
  return {
    ...brief(r.record),
    score: Number(r.score.toFixed(2)),
    activation: Number(r.activation.toFixed(2)),
    inhibited: r.inhibited ?? false,
    ...(r.via ? { via: r.via } : {}),
    snippet: r.snippet,
  };
}

/** 선택형 벡터 계층과 그 모듈 — BIGBRAIN_VECTOR=1 일 때만 main 이 동적 import 로 채운다 */
let vector: { vr: VectorRetriever; mod: typeof import("./vector-retriever.js") } | null = null;

/**
 * 벡터 계층이 ready 면 질의의 벡터 결과(항목 키·점수), 아니면 undefined. 실패는 경고만 남기고 어휘 검색으로 계속한다.
 * 항목은 마지막 어휘 sync·upsert 기준이라, 밖에서 고친 기억의 임베딩은 다음 회상부터 반영된다.
 */
async function vectorHits(query: string, filter: ScopeFilter): Promise<{ key: string; score: number }[] | undefined> {
  if (!vector || vector.vr.state !== "ready") return undefined;
  const { vr, mod } = vector;
  try {
    await vr.sync(store.retriever.entries());
    const qv = await vr.embedQuery(query);
    return vr.nearest(qv, filter, mod.VECTOR_TOP_K).map((h) => ({ key: h.key, score: mod.VECTOR_WEIGHT * h.cos }));
  } catch (err) {
    logWarn(`벡터 검색 실패(어휘 결과만 반환): ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** recall 응답의 벡터 상태 필드 — 벡터 계층을 켜지 않았으면 비어 있다 */
function vectorField(): Record<string, unknown> {
  if (!vector) return {};
  const { vr } = vector;
  return vr.state === "unavailable" ? { vector: vr.state, vector_note: `${vr.reason} (어휘 검색 결과만 반환)` } : { vector: vr.state };
}

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

/**
 * `remember` / `recall` 을 **지연 로드에서 제외**시키는 표식.
 *
 * ⚠️ 이 표식을 넣은 원래 근거는 **틀렸다.** 당시 근거는 "ToolSearch 로 도구를 로드한
 * 회차 16/16 이 전부 저장했으므로 병목은 발견이다" 였는데, 이건 인과가 아니라
 * 선택 효과였다 — ToolSearch 를 부른 회차는 이미 메모리를 쓰기로 한 회차라 저장률이
 * 100% 인 게 당연하다. 상시 로드를 적용한 2차 20회에서 훅 OFF 는 6/10 → 7/10 로
 * 사실상 그대로였고, 실패 3건은 전부 **도구가 이미 보이는 상태에서 안 부른** 것이었다.
 * 실패의 성격이 바뀌었을 뿐 사라지지 않았다.
 *
 * 그래도 유지하는 이유: 2차 표본(팔당 10회)은 60%→70% 크기의 차이를 잡을 검정력이
 * 없다(그러려면 팔당 약 280회 필요). 즉 **효과가 없다고 반증된 게 아니라 미측정**이다.
 * 비용은 도구 2개 분량의 컨텍스트뿐이고 해가 없으므로 남긴다. 다만 이것을 "저장
 * 문제의 해법" 으로 취급해서는 안 된다 — 확인된 주 메커니즘은 SessionStart 훅이다.
 *
 * 이 두 개만 표시한다. 나머지 6개(revise/forget/link/reflect/read_memory/
 * list_memories)는 모델이 이미 메모리를 쓰기 시작한 뒤에 필요해지므로 지연 로드로
 * 충분하고, 전부 올리면 컨텍스트만 축낸다.
 *
 * 표식은 MCP 스펙이 보장하는 `_meta` 통과 필드라, 이 키를 모르는 클라이언트는
 * 그냥 무시한다(하위 호환).
 */
const ALWAYS_LOAD = process.env.BIGBRAIN_ALWAYS_LOAD === "0" ? undefined : { "anthropic/alwaysLoad": true };

server.registerTool(
  "remember",
  {
    title: "Remember (store a new memory)",
    description:
      "Store a durable memory as a markdown note in the vault. Call this after learning a lasting fact, user preference, decision, lesson, or workflow. " +
      "NOT for transient conversation details. If the result lists `similar_existing_memories`, consider calling `revise` on one of them instead of keeping a duplicate. " +
      "Use `supersedes` to replace an outdated memory with this new one.\n" +
      // instructions 예산(2048자) 밖으로 밀려나 모델에 전달되지 않던 설명을 여기로 옮겼다.
      // 도구 스키마는 그 예산과 별개로 전달되고, 어차피 이 도구를 쓸 때 필요한 내용이다.
      "This vault is a SEPARATE store from CLAUDE.md, project docs, or built-in file memory, and is reached only through `recall` — a fact written into CLAUDE.md is not retrievable by `recall` from another project, so storing it here is not duplication. " +
      "`confidence` and recall accessibility are independent: `confidence` is how likely the memory is TRUE (changed only via `revise`), while how easily it surfaces is computed from frequency and recency. A rarely-recalled memory can still be highly trusted. " +
      "Memories are stored verbatim and never auto-merged; consolidate only via explicit `revise`.",
    _meta: ALWAYS_LOAD,
    inputSchema: {
      title: z.string().min(1).describe("Short human-readable title (becomes the note filename)"),
      content: z.string().min(1).describe("The memory body in markdown. May contain [[wikilinks]]"),
      description: z.string().optional().describe("One-line summary used for recall ranking (defaults to first line of content)"),
      type: MEMORY_TYPE,
      tags: z.array(z.string()).optional().describe("Topic tags for recall"),
      links: z.array(z.string()).optional().describe("Slugs or ids of related memories to link bidirectionally"),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Truthfulness — how certain this memory is CORRECT (default 0.8). Independent of how often it is recalled."),
      source: z
        .string()
        .optional()
        .describe("Where this came from (e.g. 'user stated', 'inferred from code', 'docs/x.md'). Recorded to prevent source confusion."),
      project: z
        .string()
        .optional()
        .describe(
          "Project this memory belongs to. OMIT for knowledge that applies everywhere (user preferences, general workflows) — those stay globally recallable. Set it for project-specific facts so other projects are not polluted.",
        ),
      supersedes: z.string().optional().describe("Slug or id of an outdated memory this one replaces"),
      slug: z
        .string()
        .optional()
        .describe(
          "Filename / wikilink target. Defaults to a slug derived from `title`. Set it when you want a stable ASCII link target while keeping a human-readable title in another language — do not distort the title just to control the filename.",
        ),
      derived_from: z
        .array(z.string())
        .optional()
        .describe(
          "Slugs of the episodic memories this one abstracts (consolidation). Use when you notice the same thing happened several times and are recording the general rule. " +
            "The source episodes are NEVER modified or deleted — they stay verbatim and keep surfacing in recall. This field only records where the generalisation came from, so it can be audited and revisited.",
        ),
      review_after: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Review date (YYYY-MM-DD). After this date the memory is flagged with `stale_hint` regardless of age."),
    },
  },
  async (args) => {
    const secret = findSecret(args.title, args.description, args.content);
    if (secret) {
      logUsage({ tool: "remember", ok: false, secretBlocked: secret });
      return secretRejected(secret);
    }
    // project 를 생략하면 전역 기억이다 — 서버 스코프를 몰래 씌우지 않는다.
    // (씌우면 "전역이면 생략" 이라는 도구 설명과 모순되고, 사용자 선호 같은
    //  범용 지식이 한 프로젝트에 갇혀 다른 곳에서 조용히 회상되지 않는다)
    const { record, similar, contradictions, dangling } = store.remember({
      ...args,
      derivedFrom: args.derived_from,
      reviewAfter: args.review_after,
    });
    logUsage({
      tool: "remember",
      ok: true,
      type: args.type,
      derivedCount: record.derivedFrom?.length ?? 0,
      scoped: args.project !== undefined,
      similarCount: similar.length,
      contradictionCount: contradictions.length,
      danglingCount: dangling.length,
      hasSource: args.source !== undefined,
      confidence: record.confidence,
    });
    // 깨진 링크는 **보고만** 한다 — 아직 안 쓴 기억을 미리 가리키는 선행 참조는
    // 정상이므로 저장을 막으면 안 된다. 다만 모르고 지나가면 볼트가 조용히 썩는다.
    const hints = [
      similar.length > 0
        ? "Similar memories exist. If this duplicates one of them, call `forget` on this new memory and `revise` the existing one instead."
        : null,
      contradictions.length > 0
        ? "기존 기억과 숫자/버전/부정이 다릅니다(possible_contradiction) — 기존 것을 revise 하거나 supersedes 로 대체하세요. 자동 병합·삭제는 하지 않습니다."
        : null,
      dangling.length > 0
        ? `Broken wikilinks (no such memory): ${dangling.map((d) => `[[${d}]]`).join(", ")}. Either \`remember\` those, or \`revise\` this body to remove them — do not leave links pointing at nothing.`
        : null,
      longBodyHint(args.content),
    ].filter((x): x is string => x !== null);
    return ok({
      stored: brief(record),
      similar_existing_memories: similar.filter((m) => m.slug !== record.slug).map(brief),
      possible_contradiction:
        contradictions.length > 0
          ? contradictions.map((c) => ({ ...brief(c.record), reasons: c.reasons }))
          : undefined,
      broken_links: dangling.length > 0 ? dangling : undefined,
      hint: hints.length > 0 ? hints.join(" ") : undefined,
    });
  },
);

server.registerTool(
  "recall",
  {
    title: "Recall (search memories)",
    description:
      "Search the memory vault by keywords. Call this FIRST when starting a task, when the user references past work/preferences, or before answering anything that prior sessions may have covered. " +
      "Results are ranked by relevance x truthfulness(confidence) x base-level activation (power-law of frequency+recency, ACT-R). Competing near-duplicate memories are laterally inhibited in ranking (retrieval-induced forgetting) — see `inhibited`. Associated (linked) memories are surfaced too. Active recall reinforces the recalled memories.\n" +
      "Pass `alt_queries` (up to 3): for a Korean query add English phrasings, for an English query add Korean phrasings — synonyms and broader concepts too. Per-query result lists are fused (each memory keeps its best weighted score, the original query weighted highest) before ranking; each memory is reinforced at most once per call.\n" +
      // instructions 예산 밖으로 밀려나 전달되지 않던 나이 해석 지침을 여기로 옮겼다.
      "Every result carries `age_days` (days since last update). A memory is a point-in-time observation, not live state: when it cites code, file paths, versions or config and `stale_hint` is present, verify against the current source before asserting it as fact — and `revise` it when reality has moved on.",
    _meta: ALWAYS_LOAD,
    inputSchema: {
      query: z.string().min(1).describe("Keywords to search for (matched against title, tags, description, body)"),
      alt_queries: z
        .array(z.string())
        .optional()
        .describe(
          "Up to 3 alternative phrasings of the same need; extras beyond 3 are ignored. If the query is Korean, add English phrasings; if English, add Korean phrasings — also synonyms and broader terms.",
        ),
      type: MEMORY_TYPE.optional(),
      limit: z.number().int().min(1).max(20).optional().describe("Max direct results (default 5)"),
      include_linked: z.boolean().optional().describe("Also surface 1-hop linked memories as associations (default true)"),
      project: z
        .string()
        .optional()
        .describe(
          "Restrict to this project's memories plus global ones. Defaults to the server's BIGBRAIN_PROJECT. Pass an empty string to search every project.",
        ),
    },
  },
  async ({ query, alt_queries, type, limit, include_linked, project }) => {
    const scope = project === undefined ? DEFAULT_PROJECT : project || undefined;
    const { results, totalMatched } = store.searchDetailed(query, {
      type,
      limit,
      includeLinked: include_linked,
      project: scope,
      altQueries: alt_queries,
      vectorHits: await vectorHits(query, { type, project: scope }),
    });
    // 상한을 넘긴 변형은 거부하지 않고 버린 뒤 알린다 — 재호출 한 턴을 아낀다
    const dropped = Math.max(0, (alt_queries?.length ?? 0) - MAX_ALT_QUERIES);
    const altNote =
      dropped > 0
        ? { alt_queries_note: `alt_queries 는 최대 ${MAX_ALT_QUERIES}개만 씁니다 — 앞 ${MAX_ALT_QUERIES}개만 사용하고 ${dropped}개는 무시했습니다.` }
        : {};
    // 0건 비율은 검색 품질의 1차 지표다 — 회상이 실패하는지 아예 안 불리는지를 가른다
    logUsage({
      tool: "recall",
      ok: true,
      resultCount: results.length,
      totalMatched,
      zeroHit: results.length === 0,
      scoped: scope !== undefined,
      ...(store.shadowTop5 !== undefined ? { shadowTop5: Number(store.shadowTop5.toFixed(3)) } : {}),
      ...queryField(query),
    });
    if (results.length === 0) {
      // 0건에 곧장 remember 를 권하면 "사실은 있는데 표현이 어긋난" 기억이 중복 저장된다.
      // 재질의를 먼저 유도한다 (감사 D2).
      return ok({
        results: [],
        note: "No memories matched this query. Before concluding nothing is stored: retry with different wording (synonyms, the other language, a broader single keyword), or call `list_memories` to see what exists. Only use `remember` once you are confident this is genuinely new.",
        ...altNote,
        ...vectorField(),
      });
    }
    const shownDirect = results.filter((r) => !r.snippet.startsWith("(연상")).length;
    return ok({
      results: results.map(searchHit),
      total_matched: totalMatched,
      // 컷오프가 있었으면 알린다 — 종전에는 상한에 잘린 사실 자체가 노출되지 않아
      // 에이전트가 "이게 전부" 라고 믿고 재질의할 계기가 없었다 (감사 D5)
      ...(totalMatched > shownDirect
        ? {
            truncated: `직접 매칭 ${totalMatched}건 중 ${shownDirect}건만 표시했습니다. 더 필요하면 limit 을 올려 재질의하세요 (최대 20).`,
          }
        : {}),
      ...altNote,
      ...vectorField(),
    });
  },
);

server.registerTool(
  "read_memory",
  {
    title: "Read a memory in full",
    description: "Read the full body and history of one memory by slug or id. Reading reinforces the memory.",
    inputSchema: { id: z.string().describe("Memory slug or id") },
  },
  async ({ id }) => {
    const m = store.read(id);
    logUsage({ tool: "read_memory", ok: m !== null });
    if (!m) return fail(`Memory not found: ${id}`);
    return ok(full(m));
  },
);

server.registerTool(
  "revise",
  {
    title: "Revise (correct a memory)",
    description:
      "Correct or update an existing memory when it is wrong, incomplete, or outdated (memory reconsolidation). Always provide `reason` — it is appended to the memory's history for audit. " +
      "Revising reinforces the memory and refreshes its recency. Lower `confidence` if the memory became doubtful; raise it when re-confirmed. Prefer this over creating duplicate memories.",
    inputSchema: {
      id: z.string().describe("Memory slug or id"),
      reason: z.string().min(1).describe("Why this revision is being made (recorded in history)"),
      content: z.string().optional().describe("New full markdown body (replaces the old body)"),
      title: z.string().optional(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      confidence: z.number().min(0).max(1).optional().describe("New truthfulness score (0-1)"),
      source: z.string().optional().describe("Updated provenance for this memory"),
      project: z
        .string()
        .optional()
        .describe("Reassign project scope. Pass an empty string to make the memory global again."),
      type: MEMORY_TYPE.optional().describe(
        "Reclassify the memory type. Use to fix a misclassification, or when a repeated experience has become general knowledge (episodic → semantic). The change is recorded in history.",
      ),
      review_after: z
        .string()
        .regex(/^(\d{4}-\d{2}-\d{2})?$/)
        .optional()
        .describe("Set the review date (YYYY-MM-DD). Pass an empty string to clear it."),
    },
  },
  async ({ id, reason, content, title, description, tags, confidence, source, project, type, review_after }) => {
    const secret = findSecret(title, description, content);
    if (secret) {
      logUsage({ tool: "revise", ok: false, secretBlocked: secret });
      return secretRejected(secret);
    }
    const m = store.revise(id, {
      reason,
      content,
      title,
      description,
      tags,
      confidence,
      source,
      project,
      type,
      reviewAfter: review_after,
    });
    // revise 호출률은 자기교정 루프가 도는지의 지표다 — 낡은 기억이 방치되는지 여기서 드러난다
    logUsage({
      tool: "revise",
      ok: m !== null,
      contentChanged: content !== undefined,
      confidenceChanged: confidence !== undefined,
      typeChanged: type !== undefined,
    });
    if (!m) return fail(`Memory not found: ${id}`);
    return ok({ revised: full(m), hint: longBodyHint(content) ?? undefined });
  },
);

server.registerTool(
  "forget",
  {
    title: "Forget (archive a wrong/obsolete memory)",
    description:
      "Archive a memory that turned out to be wrong or is no longer relevant. Not a hard delete — the note moves to the archive with the reason recorded, so it can be audited or restored by hand. " +
      "Use when information is proven false; use `revise` instead if it just needs correction.",
    inputSchema: {
      id: z.string().describe("Memory slug or id"),
      reason: z.string().min(1).describe("Why this memory is being forgotten (recorded in history)"),
    },
  },
  async ({ id, reason }) => {
    const m = store.forget(id, reason);
    logUsage({ tool: "forget", ok: m !== null });
    if (!m) return fail(`Memory not found: ${id}`);
    return ok({ forgotten: brief(m), archived_to: `archive/${m.slug}.md` });
  },
);

server.registerTool(
  "link",
  {
    title: "Link (associate two memories)",
    description:
      "Create a bidirectional association ([[wikilink]]) between two memories, like human associative memory. Linked memories surface together during recall. " +
      "Call this when two memories are about the same project, cause/effect, or complement each other.",
    inputSchema: {
      source: z.string().describe("Slug or id of the first memory"),
      target: z.string().describe("Slug or id of the second memory"),
      relation: z.string().optional().describe("Short label for the relationship, e.g. 'same project', 'contradicts', 'caused by'"),
    },
  },
  async ({ source, target, relation }) => {
    const linked = store.link(source, target, relation);
    logUsage({ tool: "link", ok: linked !== null, hasRelation: relation !== undefined });
    if (!linked) return fail(`Could not link: one of [${source}, ${target}] not found, or they are the same memory.`);
    return ok({ linked: { source: brief(linked.source), target: brief(linked.target), relation } });
  },
);

server.registerTool(
  "reflect",
  {
    title: "Reflect (memory health check)",
    description:
      "Metacognition over the whole vault: counts by type/status, WEAKENED memories (base-level activation fallen below the retrieval threshold — hard to recall), FORGET CANDIDATES (weakened AND low-confidence), low-confidence memories, likely duplicates, and orphans (no links). " +
      "Nothing is deleted automatically — this only surfaces candidates. Call periodically, then clean up with `revise`, `forget`, or `link`.",
    inputSchema: {},
  },
  async () => {
    const r = store.reflect();
    logUsage({
      tool: "reflect",
      ok: true,
      total: r.counts.total,
      duplicates: r.duplicates.length,
      orphans: r.orphans.length,
      forgetCandidates: r.forgetCandidates.length,
      brokenLinks: r.danglingLinks.length,
    });
    return ok({
      counts: r.counts,
      weakened_hard_to_recall: r.weakened,
      forget_candidates: r.forgetCandidates,
      trusted_but_faded: r.trustedButFaded,
      low_confidence: r.lowConfidence.map((m) => ({ slug: m.slug, title: m.title, confidence: m.confidence })),
      possible_duplicates: r.duplicates,
      orphans_without_links: r.orphans.map((m) => m.slug),
      broken_links: r.danglingLinks,
      // 서버는 후보만 낸다 — 어느 것이 진짜 패턴인지는 본문을 읽어야 알 수 있고 그건 모델의 일이다
      consolidation_candidates: r.consolidationCandidates,
      suggestion:
        "Review forget_candidates and `forget` the ones that are truly obsolete/wrong (reversible — moved to archive). Revise low-confidence memories if you can confirm or correct them. Merge duplicates (revise one, forget the other). Link orphans to related memories." +
        (r.danglingLinks.length > 0
          ? " broken_links point at slugs that do not exist — either `remember` the missing memory or `revise` the body to drop the link."
          : "") +
        (r.consolidationCandidates.length > 0
          ? " consolidation_candidates are episodes that keep recurring under one theme. Read them, and if a general rule genuinely holds across them, `remember` it as `semantic` with `derived_from` set to those slugs. " +
            "Do NOT delete or rewrite the episodes — they stay verbatim as the evidence. If the episodes only look alike on the surface, leave them alone: three coincidences are not a rule."
          : ""),
    });
  },
);

server.registerTool(
  "list_memories",
  {
    title: "List memories",
    description: "Browse the memory index. Defaults to active memories, most recently updated first.",
    inputSchema: {
      type: MEMORY_TYPE.optional(),
      status: z.enum(["active", "superseded", "archived"]).optional().describe("Filter by status (default: active)"),
      project: z
        .string()
        .optional()
        .describe(
          "Restrict to this project's memories plus global ones. Defaults to the server's BIGBRAIN_PROJECT. Pass an empty string to list every project.",
        ),
    },
  },
  async ({ type, status, project }) => {
    const scope = project === undefined ? DEFAULT_PROJECT : project || undefined;
    const items = store.list({ type, status, project: scope });
    logUsage({ tool: "list_memories", ok: true, resultCount: items.length, scoped: project !== undefined });
    return ok({ count: items.length, memories: items.map(brief) });
  },
);

/**
 * 기억 통합 정리 절차 (감사 E6).
 *
 * `reflect` 는 후보만 내놓고, 실제 정리는 모델의 즉흥 판단에 맡겨져 있었다.
 * 네이티브 메모리에는 `consolidate-memory` 스킬이 있어 슬래시 호출 한 번으로
 * "중복 병합 · 낡은 사실 수정 · 인덱스 정리" 절차가 로드되는데, 여기엔 대응물이 없었다.
 * MCP 프롬프트로 등록하면 Claude Code 에서
 * `/mcp__bigbrainmemory__consolidate` 슬래시 커맨드로 노출된다 —
 * 사용자가 원하는 시점에 정리를 **주도**할 수 있게 된다.
 */
server.registerPrompt(
  "consolidate",
  {
    title: "기억 통합 정리",
    description: "reflect 결과를 실제 정리(병합·교정·연결)까지 잇는 절차를 로드한다",
  },
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            "bigbrainmemory 볼트를 정리하라. 아래 절차를 순서대로 따르되, 각 단계에서 판단 근거를 짧게 밝혀라.",
            "",
            "1. `reflect` 를 호출해 현재 상태를 파악한다.",
            "",
            "2. **possible_duplicates** — 각 쌍을 `read_memory` 로 **둘 다 읽어** 비교한다.",
            "   정말 같은 사실이면 더 정확·완전한 쪽을 `revise` 로 보강하고(양쪽의 고유 정보를 합칠 것),",
            "   다른 쪽은 `forget`(reason: \"merged into [[슬러그]]\") 한다.",
            "   비슷해 보여도 다른 사실이면 병합하지 말고 넘어간다 — 잘못된 병합은 되돌리기 어렵다.",
            "",
            "3. **forget_candidates** — 약해졌고 확신도도 낮은 기억들이다. 각각을 현재 코드·사실과 대조해",
            "   여전히 유효하면 `revise` 로 확신도를 올리고, 낡았으면 `forget`(사유 명시) 한다.",
            "",
            "4. **trusted_but_faded** 가 0보다 크면, 확신도가 높아 후보에서 빠졌지만 오래 방치된 기억이 그만큼 있다는 뜻이다.",
            "   `list_memories` 로 훑어 여전히 참인지 표본 점검하고, 사실이 바뀐 것은 `revise` 한다.",
            "",
            "5. **low_confidence** — 확인 가능한 것은 근거를 찾아 `revise` 로 확신도를 조정한다.",
            "   확인할 수 없으면 그대로 두고, 확신도가 낮다는 사실 자체를 유지한다.",
            "",
            "6. **orphans_without_links** — 주제가 겹치는 기억을 `recall` 로 찾아 `link` 로 연결한다.",
            "   억지로 엮지 말 것 — 무관한 연결은 회상을 오염시킨다.",
            "",
            "7. `reflect` 를 다시 호출해 잔여를 확인하고, 무엇을 왜 했는지 요약해 보고한다.",
            "",
            "주의: 기억은 시점 관측이다. `age_days` 가 크거나 `stale_hint` 가 붙은 항목은",
            "현재 코드·파일을 실제로 확인한 뒤에만 \"여전히 유효\" 라고 판단하라.",
            "삭제는 되돌리기 어렵다 — 애매하면 `forget` 대신 `revise` 로 확신도를 낮춰라.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerTool(
	"recommend",
	{
		title: "Recommend model placement",
		description: "Recommend a model and effort for an AstronAgent node role from the packaged ontology.",
		inputSchema: {
			description: z.string().trim().min(1).max(4000),
			role: z.enum(["research", "plan", "impl", "review", "ship", "ops", "coordinator"]),
		},
	},
	async ({ description, role }) => {
		try {
			const ontology = ontologySchema.parse(JSON.parse(fs.readFileSync(ontologyPath, "utf8")));
			return ok(recommendModel(ontology, description, role as Role));
		} catch (error) {
			return fail(`Recommendation unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	},
);

async function main() {
  // 인덱스 재생성 실패가 서버 기동을 막아서는 안 된다(감사 A1: 손상 파일 1개로
  // process.exit(1) → 8개 도구 전부 사용 불능). MEMORY.md 는 파생 파일이고
  // 기억 조회 자체는 인덱스 없이도 동작한다.
  try {
    store.regenerateIndex();
  } catch (err) {
    logWarn(`인덱스 재생성 실패(계속 진행): ${err instanceof Error ? err.message : String(err)}`);
  }
  // 영속 역색인을 기동 시 볼트와 맞춘다 — 훅의 읽기 전용 회상이 최신 인덱스를 보게 한다
  try {
    store.retriever.sync(vault);
  } catch (err) {
    logWarn(`역색인 동기화 실패(계속 진행): ${err instanceof Error ? err.message : String(err)}`);
  }
  // 벡터 계층은 켰을 때만 불러온다 — 연결 전에 만들어 두어 첫 recall 부터 상태(warming)를 알린다
  if (process.env.BIGBRAIN_VECTOR === "1") {
    const mod = await import("./vector-retriever.js");
    vector = { vr: new mod.VectorRetriever(vault.nativeMemoryFiles.length > 0 ? null : path.join(vaultDir, INDEX_DIR)), mod };
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout은 MCP 프로토콜 전용 — 로그는 반드시 stderr로
  const st = vault.inspect();
  const parts = [`memories=${st.memories}`];
  if (st.archived > 0) parts.push(`archived=${st.archived}`);
  if (st.quarantined > 0) parts.push(`quarantined=${st.quarantined}(!)`);
  if (DEFAULT_PROJECT) parts.push(`project=${DEFAULT_PROJECT}`);
  logInfo(`ready. v${PKG_VERSION} built=${BUILD_STAMP} vault=${vaultDir} ${parts.join(" ")}`);
  if (VAULT_WARNING) logWarn(VAULT_WARNING);
  if (HOOK_WARNING) {
    logWarn(
      `SessionStart 훅이 설치돼 있지 않습니다. 대조 실험 40회에서 훅이 있으면 20/20, ` +
        `없으면 13/20 이 저장됐습니다 — instructions 만으로는 저장이 잘 일어나지 않습니다. ` +
        `BigBrainMemory 저장소에서 \`npm run setup:hook\` 을 실행해 주세요.`,
    );
  }
  if (st.quarantined > 0) {
    logWarn(`격리된 손상 파일 ${st.quarantined}건이 있습니다 — vault/quarantine/ 확인 필요`);
  }
  // 모델 로드·첫 임베딩은 기다리지 않는다 — 그동안 recall 은 어휘 결과만 낸다
  if (vector) {
    const { vr } = vector;
    const t0 = Date.now();
    void vr.warm(() => store.retriever.entries()).then(() => {
      if (vr.state === "ready") logInfo(`벡터 계층 준비됨 (${Date.now() - t0}ms, model=${vr.model})`);
      else logWarn(`벡터 계층 사용 불가(어휘 검색으로 계속): ${vr.reason}`);
    });
  }
}

main().catch((err) => {
  logError("fatal", err);
  process.exit(1);
});
