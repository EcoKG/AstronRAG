#!/usr/bin/env node
// BigBrainMemory — 세션 훅 도우미. setup-hook.mjs 가 등록하는 세 훅의 실제 본체다.
//
//   --start  : 세션 시작 시점의 기억 수를 마커에 기록하고, MEMORY.md 를 컨텍스트에 주입한다.
//   --prompt : 부호화 큐를 내고, BIGBRAIN_AUTO_RECALL=1 이면 프롬프트로 역색인을 읽기 전용 검색해 관련 기억을 주입한다(자동 회상).
//   --stop   : 세션 동안 새로 저장된 기억이 0건이면 경고한다.
//
// 왜 셸 one-liner 가 아니라 Node 스크립트인가:
//   Stop 훅은 "세션 시작 시점과 지금을 비교" 하는 상태 비교가 필요하다. 이를 Windows
//   PowerShell 과 POSIX sh 양쪽에서 안전하게 쓰려면 문법이 갈리고, 따옴표·변수 치환
//   사고가 나기 쉽다(실제로 `$` 변수를 쓴 첫 시도가 호스트 셸 치환으로 깨졌다).
//   Node 는 이미 이 서버의 필수 의존성이므로, 로직을 한 곳에 두고 훅은 이 파일을
//   호출만 하게 한다 — OS 분기도, 셸 이스케이프도 구조적으로 사라진다.
//
// 원칙: **어떤 경우에도 세션을 방해하지 않는다.** 실패하면 조용히 종료하고,
//       종료 코드는 항상 0 이다(Stop 훅이 0 이 아니면 세션 종료를 막을 수 있다).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 세션 시작 시점의 기억 수를 담는 마커 (볼트 루트, 점 파일이라 Obsidian 에서 숨겨진다) */
const MARKER = ".bbm-session-start";
/** 주입할 MEMORY.md 최대 줄 수 — 볼트가 커져도 컨텍스트 예산을 넘지 않게 하는 안전장치 */
const MAX_LINES = 200;
/**
 * 무저장 경고를 띄우기 위한 최소 **도구 호출 수**. 한두 마디 묻고 끝나는 대화에는
 * 애초에 남길 durable 한 사실이 없으므로, 실제로 작업한 세션에만 말을 건다.
 *
 * 왜 줄 수가 아니라 도구 호출 수인가 — 처음엔 트랜스크립트 25줄로 걸렀는데,
 * 실측 1439개 트랜스크립트에 대보니 **명백히 틀린 지표**였다:
 *   · 도구를 3회 이상 쓴 진짜 작업 세션 1285개 중 486개(38%)가 25줄 미만이라 침묵당함
 *   · 줄 수와 작업량이 무관함 — 4줄짜리 93KB 트랜스크립트가 흔하다(한 줄이 거대함)
 * 도구 호출 수로 바꾸니 분포가 깨끗하게 갈렸다: 0회 118개(잡담) / 1~2회 36개 /
 * 3회 이상 1285개(작업). 실패 사례로 보고된 호출열(Grep Read Read Read 등)도 전부 3 이상이다.
 */
const MIN_TOOL_USES = (() => {
  const v = Number(process.env.BIGBRAIN_STOP_MIN_TOOLS);
  return Number.isFinite(v) && v >= 0 ? v : 3;
})();
/** 훅 입력(stdin) 을 기다리는 한계 시간 — 넘기면 없는 셈 치고 진행한다(행 방지) */
const STDIN_TIMEOUT_MS = 250;
/** 자동 회상: 이보다 짧은 프롬프트는 검색하지 않는다 */
const AUTO_MIN_PROMPT = 8;
/** 자동 회상: 코드블록을 뺀 프롬프트에서 질의로 쓰는 앞부분 길이 */
const AUTO_QUERY_CHARS = 500;
/** 자동 회상: 한 번에 주입하는 최대 건수 */
const AUTO_MAX = 3;
/** 자동 회상: 1위 점수 대비 이 비율 미만인 결과는 버린다 */
const AUTO_RELATIVE = 0.5;
/** 자동 회상: 마커에 남기는 주입 slug 수 상한 */
const AUTO_SLUG_KEEP = 200;
/** 자동 회상: 주입할 최소 절대 점수 (BIGBRAIN_AUTO_MIN_SCORE) */
const AUTO_MIN_SCORE = (() => {
  const v = Number(process.env.BIGBRAIN_AUTO_MIN_SCORE);
  return process.env.BIGBRAIN_AUTO_MIN_SCORE?.trim() && Number.isFinite(v) && v >= 0 ? v : 9;
})();
/** 자동 회상: 주입 블록 전체 문자 수 상한 (BIGBRAIN_AUTO_BUDGET) */
const AUTO_BUDGET = (() => {
  const v = Number(process.env.BIGBRAIN_AUTO_BUDGET);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 1500;
})();

const argv = process.argv.slice(2);
const mode = argv.includes("--stop") ? "stop" : argv.includes("--prompt") ? "prompt" : "start";
const argValue = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
/** 자동탐지가 실패했을 때만 쓰는 폴백 (설치 시점 자동 감지값) */
const vaultArg = argValue("--vault");
/** 사용자가 설치 시 명시한 경로 — 자동탐지보다 우선한다 */
const vaultForced = argValue("--vault-force");

/** 경로별 readJson 결과 */
const jsonCache = new Map();

/** JSON 파일을 조용히 읽는다 (없거나 깨졌으면 null). 한 번 읽은 파일은 프로세스 안에서 다시 파싱하지 않는다 */
function readJson(fp) {
  if (jsonCache.has(fp)) return jsonCache.get(fp);
  let v = null;
  try {
    v = JSON.parse(fs.readFileSync(fp, "utf-8").replace(/^﻿/, ""));
  } catch {
    v = null;
  }
  jsonCache.set(fp, v);
  return v;
}

/**
 * mcpServers 맵에서 이 서버의 항목을 찾아 `{ name, vault }` 로 돌려준다.
 *
 * **등록 키 이름만으로 찾으면 안 된다.** 종전에는 `/bigbrain/i` 로 키를 걸렀는데,
 * 사용자가 `bbm` · `memory` · `brain` 같은 이름으로 등록하면 항목을 통째로 놓친다.
 * 그 결과가 특히 나쁘다 — 볼트는 전역 폴백으로 새고, 도구 이름은 하드코딩된
 * `mcp__bigbrainmemory__remember` 로 나간다. 지연 로드된 도구는 **정확한 이름으로만**
 * 부를 수 있으므로, 존재하지 않는 이름을 광고하면 모델이 로드에 실패하고
 * "메모리를 쓸 수 없다" 고 결론짓는다. 아무것도 주입하지 않느니만 못하다.
 *
 * 그래서 이름이 아니라 **실체**로 판별한다: BIGBRAIN_VAULT 를 들고 있거나,
 * 실행 명령이 이 패키지를 가리키거나, 키가 bigbrain 계열이거나.
 */
function findServer(servers) {
  if (!servers || typeof servers !== "object") return null;
  const hasVault = (cfg) => typeof cfg?.env?.BIGBRAIN_VAULT === "string" && cfg.env.BIGBRAIN_VAULT.trim() !== "";
  const looksLikeUs = (name, cfg) => {
    if (/bigbrain/i.test(name)) return true;
    if (hasVault(cfg)) return true;
    const cmd = [cfg?.command, ...(Array.isArray(cfg?.args) ? cfg.args : [])].filter((x) => typeof x === "string").join(" ");
    return /bigbrainmemory/i.test(cmd);
  };
  // 볼트를 실제로 들고 있는 항목을 우선한다 — 여러 개가 걸릴 때 더 구체적인 쪽이다
  const entries = Object.entries(servers).filter(([n, c]) => looksLikeUs(n, c));
  const withVault = entries.find(([, c]) => hasVault(c));
  const [name] = withVault ?? entries[0] ?? [];
  if (!name) return null;
  const env = servers[name]?.env;
  const v = env?.BIGBRAIN_VAULT;
  const p = env?.BIGBRAIN_PROJECT;
  return {
    name,
    vault: typeof v === "string" && v.trim() !== "" ? v : null,
    project: typeof p === "string" && p.trim() !== "" ? p.trim() : undefined,
  };
}
const vaultFromServers = (servers) => findServer(servers)?.vault ?? null;
const serverNameFromServers = (servers) => findServer(servers)?.name ?? null;

/**
 * 주입문에 박을 MCP 도구 이름의 서버 키를 해석한다 (`mcp__<서버키>__remember`).
 *
 * 왜 이름을 박아야 하는가:
 *   클라이언트가 MCP 도구를 **지연 로드(deferred)** 하면 스키마가 컨텍스트에 없어서,
 *   모델은 도구를 "쓸지 말지" 판단하기 전에 먼저 이름으로 지목해 불러와야 한다.
 *   "기억하세요" 라고만 쓰면 무엇을 로드해야 하는지 알 수 없다. 관측된 콜드 스타트
 *   실패에서 모델은 저장을 판단하고 안 한 게 아니라 **도구 탐색 자체를 하지 않았다.**
 *   등록 키는 사용자마다 다를 수 있으므로 설정에서 실제 값을 찾아 쓴다.
 */
function resolveServerName() {
  const cwd = process.cwd();
  const fromProject = serverNameFromServers(readJson(path.join(cwd, ".mcp.json"))?.mcpServers);
  if (fromProject) return fromProject;
  const userCfg = readJson(path.join(os.homedir(), ".claude.json"));
  return (
    serverNameFromServers(userCfg?.projects?.[cwd]?.mcpServers) ??
    serverNameFromServers(userCfg?.mcpServers) ??
    "bigbrainmemory"
  );
}

/**
 * 서버의 기본 검색 범위(BIGBRAIN_PROJECT)를 서버 설정과 같은 우선순위로 찾는다. 없으면 undefined(전체).
 * 범위를 맞추지 않으면 자동 회상이 서버 recall 에서는 보이지 않는 다른 프로젝트 기억을 주입한다.
 */
function resolveProject() {
  if (process.env.BIGBRAIN_PROJECT?.trim()) return process.env.BIGBRAIN_PROJECT.trim();
  const cwd = process.cwd();
  const userCfg = readJson(path.join(os.homedir(), ".claude.json"));
  for (const servers of [readJson(path.join(cwd, ".mcp.json"))?.mcpServers, userCfg?.projects?.[cwd]?.mcpServers, userCfg?.mcpServers]) {
    const s = findServer(servers);
    if (s) return s.project;
  }
  return undefined;
}

/**
 * **실행 시점**에 볼트를 해석한다 — 이것이 이 스크립트의 핵심이다.
 *
 * 설치 시점 경로를 훅에 박아두면, 프로젝트마다 BIGBRAIN_VAULT 로 볼트를 나누는
 * 순간 훅만 옛 볼트를 계속 바라본다. 그러면 한 세션 안에서
 *   훅  : "볼트에 이런 기억들이 있다" (볼트 B 내용)
 *   서버: "COLD START — this vault is EMPTY" (볼트 A 기준)
 * 라는 **정면으로 모순된 두 신호**가 동시에 주입된다. 모델은 인덱스에 내용이
 * 보이면 "메모리는 이미 잘 돌고 있다" 고 판단해 저장을 건너뛰기 쉽다.
 * 실제로 그 분열이 관측됐다(훅은 실제 볼트 3건, 서버는 빈 테스트 볼트).
 *
 * 그래서 서버와 **같은 근거**를 같은 우선순위로 다시 읽는다.
 * 훅은 프로젝트 디렉터리에서 실행되므로 cwd 가 기준점이다.
 */
function resolveVault(fallback, forced) {
  const cwd = process.cwd();

  // 사용자가 설치 시 --vault 로 **명시**했다면 그 의도가 자동탐지를 이긴다
  if (forced) return { dir: path.resolve(forced), source: "설치 시 명시(--vault)" };

  if (process.env.BIGBRAIN_VAULT?.trim()) {
    return { dir: path.resolve(process.env.BIGBRAIN_VAULT), source: "BIGBRAIN_VAULT 환경변수" };
  }
  // 프로젝트 스코프가 사용자 전역보다 우선한다
  const fromProject = vaultFromServers(readJson(path.join(cwd, ".mcp.json"))?.mcpServers);
  if (fromProject) return { dir: path.resolve(cwd, fromProject), source: "프로젝트 .mcp.json" };

  const userCfg = readJson(path.join(os.homedir(), ".claude.json"));
  const fromUserProject = vaultFromServers(userCfg?.projects?.[cwd]?.mcpServers);
  if (fromUserProject) {
    return { dir: path.resolve(fromUserProject), source: "~/.claude.json (이 프로젝트)" };
  }
  const fromUserGlobal = vaultFromServers(userCfg?.mcpServers);
  if (fromUserGlobal) return { dir: path.resolve(fromUserGlobal), source: "~/.claude.json (전역)" };

  if (fallback) return { dir: path.resolve(fallback), source: "설치 시점 기본값" };
  return null;
}

const resolved = resolveVault(vaultArg, vaultForced);
// 어디서도 볼트를 못 찾으면 침묵 종료 — 설정이 어긋났다고 세션을 시끄럽게 만들지 않는다
if (!resolved) process.exit(0);

const vaultDir = resolved.dir;
const memoriesDir = path.join(vaultDir, "memories");
const markerPath = path.join(vaultDir, MARKER);

/** 활성 기억 파일 수. 볼트가 아직 없으면 0 */
function countMemories() {
  try {
    return fs.readdirSync(memoriesDir).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

/**
 * 활성 + 아카이브 총량. **손실 감지의 기준값**이다.
 *
 * 왜 활성 수가 아니라 총량인가 — `forget` 은 삭제가 아니라 archive 이동이므로(P6, 가역성)
 * 활성 수만 보면 정상적인 망각과 진짜 소실이 구분되지 않는다. 총량은 정상 경로로는
 * 줄어들 수 없다. 줄었다면 파일이 볼트 밖에서 사라진 것이다.
 *
 * 왜 필요한가 — 실측으로 확인된 사고다. 이 저장소의 라이브 볼트가 2026-07-18/19 에 19건이었는데
 * 2026-07-22 에 2건이었고 `archive/` 는 비어 있었다. 즉 17건이 정상 경로가 아닌 방법으로
 * 없어졌는데 **아무도 눈치채지 못했다.** 원자적 쓰기·손상 격리·구본 스냅샷을 다 갖춰 놓고도
 * "건수가 줄었다" 를 보는 눈이 없었다. 기억이 사라지지 않는다는 보장은 대체의 전제다.
 */
function countTotal() {
  const n = (dir) => {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length;
    } catch {
      return 0;
    }
  };
  return n(memoriesDir) + n(path.join(vaultDir, "archive"));
}

/**
 * 훅 입력 JSON 을 stdin 에서 읽는다 — `session_id`, `source`, `transcript_path` 가 온다.
 *
 * **절대 멈추면 안 된다.** stdin 이 닫히지 않는 파이프로 상속될 수 있고, Stop 훅은 매 턴
 * 실행되므로 한 번의 지연이 대화 전체에 곱해진다. 그래서 타임아웃을 두고, 넘으면
 * 입력이 없는 셈 치고 진행한다(그 경우 종전 동작으로 자연히 퇴화한다).
 */
async function readHookInput() {
  const empty = { sessionId: null, source: null, transcriptPath: null, prompt: null };
  if (process.stdin.isTTY) return empty;
  const raw = await new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        process.stdin.pause();
      } catch {
        /* 무시 */
      }
      resolve(v);
    };
    const timer = setTimeout(() => done(buf), STDIN_TIMEOUT_MS);
    try {
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (c) => (buf += c));
      process.stdin.on("end", () => done(buf));
      process.stdin.on("error", () => done(""));
    } catch {
      done("");
    }
  });
  try {
    const o = JSON.parse(String(raw));
    return {
      sessionId: typeof o?.session_id === "string" ? o.session_id : null,
      source: typeof o?.source === "string" ? o.source : null,
      transcriptPath: typeof o?.transcript_path === "string" ? o.transcript_path : null,
      // UserPromptSubmit 에만 온다. **문서로 확정되지 않은 필드라, 있으면 쓰고 없으면
      // 상태 기반으로 자연히 퇴화한다** — 미확인 계약 위에 기능을 세우지 않는다.
      prompt: typeof o?.prompt === "string" ? o.prompt : null,
    };
  } catch {
    return empty;
  }
}

/**
 * 마커 읽기. 신형은 JSON, 구형은 숫자 하나 — 둘 다 받는다.
 * (구형 마커를 남긴 채 업그레이드해도 경고가 깨지지 않아야 한다)
 */
function readMarker() {
  let raw;
  try {
    raw = fs.readFileSync(markerPath, "utf-8").replace(/^﻿/, "").trim();
  } catch {
    return null;
  }
  if (raw === "") return null;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === "object") {
      return {
        sessionId: typeof o.sessionId === "string" ? o.sessionId : null,
        count: Number.isFinite(o.count) ? o.count : Number.NaN,
        // 구형 마커에는 없다 — 없으면 손실 검사를 건너뛴다(오경보보다 침묵이 낫다)
        total: Number.isFinite(o.total) ? o.total : Number.NaN,
        warned: o.warned === true,
        /** 무저장 결과를 계측 로그에 남겼는가 (Stop 이 매 턴 발화하므로 1회 제한) */
        logged: o.logged === true,
        /** 저장 결과를 남겼는가 — 무저장 기록과 별개다(경고 뒤 저장한 세션을 잡기 위해) */
        loggedStored: o.loggedStored === true,
        /** 이 세션에서 부호화 큐를 낸 적이 있는가 (진단용) */
        cued: o.cued === true,
        /** 지금까지의 사용자 턴 수 — prompt 를 못 받는 환경의 폴백 기준 */
        turns: Number.isFinite(o.turns) ? o.turns : 0,
        /** 마지막 큐를 낸 턴 — 쿨다운 기준 (세션당 1회가 아니다) */
        lastCueTurn: Number.isFinite(o.lastCueTurn) ? o.lastCueTurn : Number.NaN,
        /** 마지막 저장 시점의 기억 수·턴 — 큐 판정의 기준선. 저장할 때마다 리셋된다 */
        cueBaseCount: Number.isFinite(o.cueBaseCount) ? o.cueBaseCount : Number.NaN,
        cueBaseTurn: Number.isFinite(o.cueBaseTurn) ? o.cueBaseTurn : Number.NaN,
        /** 이 세션에서 자동 회상으로 이미 주입한 slug */
        autoSlugs: Array.isArray(o.autoSlugs) ? o.autoSlugs.filter((s) => typeof s === "string") : [],
      };
    }
  } catch {
    /* 구형 포맷 — 아래에서 숫자로 해석 */
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n)
    ? { sessionId: null, count: n, total: Number.NaN, warned: false, logged: false, loggedStored: false, cued: false, turns: 0, autoSlugs: [] }
    : null;
}

/**
 * 사용 계측 — 서버와 **같은 로그 파일**에 세션 단위 사건을 남긴다 (T33).
 *
 * 왜 훅이 기록하는가: 저장률의 분모인 "세션" 을 아는 것은 훅뿐이다. stdio 서버는 세션
 * 개념이 없고(프로세스가 곧 세션에 가까운 근사일 뿐), `session_id` 는 훅 입력으로만 온다.
 * 게다가 Stop 훅은 이미 "이 세션에서 새로 저장됐는가" 를 계산하고 있다 — A/B 1차 지표를
 * 이미 손에 쥐고 있으면서 버리고 있었다.
 *
 * 내용은 남기지 않는다. 수치와 식별자뿐이다.
 */
function logUsage(event) {
  if (process.env.BIGBRAIN_USAGE_LOG === "0") return;
  try {
    fs.appendFileSync(
      path.join(vaultDir, ".bbm-usage.jsonl"),
      `${JSON.stringify({ ts: new Date().toISOString(), src: "hook", ...event })}\n`,
      "utf-8",
    );
  } catch {
    /* 계측 실패가 훅을 망가뜨리면 안 된다 */
  }
}

function writeMarker(m) {
  try {
    fs.writeFileSync(markerPath, JSON.stringify(m), "utf-8");
  } catch {
    /* 볼트 미생성 등 — 무시 */
  }
}

/** ``` 또는 ~~~ 펜스 코드블록을 뺀 텍스트 (닫히지 않은 펜스는 끝까지 뺀다) */
function stripFences(text) {
  let fence = "";
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const f = /^\s*(`{3,}|~{3,})/.exec(line)?.[1] ?? "";
      if (fence) {
        if (f && f[0] === fence[0] && f.length >= fence.length) fence = "";
        return false;
      }
      fence = f;
      return !f;
    })
    .join("\n");
}

/**
 * 프롬프트로 영속 역색인을 읽기 전용 검색해 자동 회상 블록을 만든다 (T44). BIGBRAIN_AUTO_RECALL=1 일 때만 동작한다.
 * 검색하지 않았으면 null, 검색했으면 { block(주입할 게 없으면 null), slugs, topScore }.
 * 인덱스·기억 파일을 쓰지 않고 강화도 하지 않는다 — 모델이 고른 회상이 아니므로 저장강도를 올릴 근거가 없다.
 */
async function autoRecall(prompt, injected) {
  if (process.env.BIGBRAIN_AUTO_RECALL !== "1" || typeof prompt !== "string") return null;
  const text = prompt.trim();
  if (text.length < AUTO_MIN_PROMPT || text.startsWith("/")) return null;
  const query = stripFences(text).trim().slice(0, AUTO_QUERY_CHARS);
  let store;
  try {
    // 무거운 모듈(gray-matter 등)은 이 경로에서 불러오지 않는다 — regress-auto-recall 이 import 목록을 고정한다
    store = await import(new URL("../dist/store.js", import.meta.url).href);
  } catch {
    return null;
  }
  const project = resolveProject();
  // 1위 점수(top)는 이미 주입한 것을 포함한 활성 결과의 최고점이다 — 질의에 가장 잘 맞는 기억이 기준이다
  const eligible = (score, top) => score >= AUTO_MIN_SCORE && score >= top * AUTO_RELATIVE;
  let picked;
  let top = 0;
  // 비활성·이미 주입한 결과를 먼저 거른 뒤 AUTO_MAX 건으로 자른다. 받은 결과의 최저점까지 기준을 넘으면 더 받는다
  for (let limit = AUTO_MAX * 2; ; limit *= 2) {
    let results;
    try {
      results = store.searchPersistedIndex(vaultDir, query, { limit, project }).results;
    } catch {
      return null;
    }
    const active = results.filter((r) => r.record.status === "active");
    top = active.reduce((a, r) => Math.max(a, r.score), 0);
    picked = active
      .filter((r) => eligible(r.score, top) && !injected.includes(r.record.slug))
      .sort((a, b) => b.score - a.score)
      .slice(0, AUTO_MAX);
    const floor = results.reduce((a, r) => Math.min(a, r.score), Number.POSITIVE_INFINITY);
    if (picked.length >= AUTO_MAX || results.length < limit || !eligible(floor, top)) break;
  }
  const open = (n) =>
    `<bigbrainmemory-auto-recall matched="${n}" note="자동 검색 결과. 관련 없으면 무시. 전문은 read_memory">`;
  const close = "</bigbrainmemory-auto-recall>";
  const line = (r, desc) => {
    const m = r.record;
    const age = Math.max(0, Math.floor((Date.now() - Date.parse(m.updated)) / 86_400_000));
    const days = Number.isFinite(age) ? age : 0;
    const stale = store.isStale(m, days) ? ", 대조 필요" : "";
    return `- [${m.slug}] ${desc} (${m.type}, conf ${Number(m.confidence.toFixed(2))}, ${days}일 전${stale})`;
  };
  // 여는·닫는 태그와 줄바꿈까지 포함해 예산을 센다
  let used = open(picked.length).length + close.length + 1;
  let full = false;
  // 예산을 넘는 줄에서 멈춘다. 한 줄도 못 넣었으면 첫 줄의 설명을 잘라서라도 넣는다
  const fitted = picked.flatMap((r) => {
    if (full) return [];
    const desc = (r.record.description.trim() || r.record.title).replace(/[\r\n<>]+/g, " ").trim();
    let text = line(r, desc);
    if (used + text.length + 1 > AUTO_BUDGET) {
      const room = AUTO_BUDGET - used - 1 - line(r, "…").length;
      full = true;
      if (r !== picked[0] || room < 1) return [];
      text = line(r, `${desc.slice(0, room)}…`);
    }
    used += text.length + 1;
    return [{ slug: r.record.slug, text }];
  });
  return {
    block: fitted.length > 0 ? `${open(fitted.length)}\n${fitted.map((f) => f.text).join("\n")}\n${close}` : null,
    slugs: fitted.map((f) => f.slug),
    topScore: Math.round(top * 100) / 100,
  };
}

const hookInput = await readHookInput();

// ── prompt: 부호화 큐 (T34)
//
// **왜 Stop 이 아니라 여기인가.** 사람은 "이걸 기억해야지" 하고 기억하지 않는다 —
// 놀라움·정정·완결 같은 계기가 그 자리에서 부호화를 유발한다(Craik & Lockhart 1972 의
// 부수적 조건 파지). BBM 의 유일한 부호화 경로는 명시적 remember 호출이었고, 유일한
// 넛지는 Stop 훅이라 **세션이 끝날 때** 나왔다. 그때는 이미 늦다: 맥락이 압축됐을 수 있고,
// 그러면 요약에서 재구성해 저장하게 되는데 그건 P8 이 금지하는 요지 기반 재구성이다.
// UserPromptSubmit 은 stdout 이 컨텍스트로 들어가는 확인된 세 이벤트 중 하나이고,
// 무엇보다 **턴 시작 시점**이라 아직 원문이 살아 있다.
//
// **자동 저장은 만들지 않는다.** 훅은 큐만 내고 판단은 모델이 한다 — P6(자동 삭제 금지)의
// 대칭이다. 정규식이 사용자의 의도를 아는 척하면 안 되므로, 큐는 스스로 기계 휴리스틱임을
// 밝히고 출처·타입을 지정하지 않는다.
if (mode === "prompt") {
  const m = readMarker();
  // 기준선이 없거나(세션 시작을 못 봤으면) 다른 세션의 마커면 큐 판단 근거가 없다
  const tracked =
    !!m && Number.isFinite(m.count) && !(hookInput.sessionId && m.sessionId && hookInput.sessionId !== m.sessionId);

  // 자동 회상 (T44). 이미 주입한 slug 는 같은 세션의 마커가 있을 때만 거르고 기록한다
  const recall = await autoRecall(hookInput.prompt, m && tracked ? m.autoSlugs : []);
  if (recall) {
    // 질의 내용은 남기지 않는다 — 건수와 1위 점수뿐이다
    logUsage({ tool: "auto_recall", sessionId: hookInput.sessionId, injected: recall.slugs.length, topScore: recall.topScore });
    if (m && tracked && recall.slugs.length > 0) m.autoSlugs = [...m.autoSlugs, ...recall.slugs].slice(-AUTO_SLUG_KEEP);
  }
  /**
   * 회상 블록과 부호화 큐를 한 JSON 의 hookSpecificOutput.additionalContext 로 낸다(회상 → 큐 순서). 낼 것이 없으면 아무것도 쓰지 않는다.
   * 평문과 JSON 을 섞어 내면 JSON 으로 해석되지 않고, 최상위 additionalContext 는 무시된다.
   */
  const emitPrompt = (cue = "") => {
    const context = [recall?.block, cue].filter(Boolean).join("\n");
    if (context) {
      process.stdout.write(
        `${JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } })}\n`,
      );
    }
  };
  if (!m || !tracked) {
    emitPrompt();
    process.exit(0);
  }
  const turns = Number.isFinite(m.turns) ? m.turns + 1 : 1;

  // **이진 판정이 아니라 증분 판정이다.**
  //
  // 처음 구현은 "이 세션에서 한 건이라도 저장했으면 영구 침묵" 이었다. 실사용에서 바로
  // 터졌다 — 3시간짜리 세션에서 초반에 사소한 것 하나를 저장하자 그 뒤 2시간 동안 결함
  // 3건을 확정하고 근본 원인을 규명하는 동안 신호가 한 번도 나가지 않았다. 세션 최대
  // 성과가 통째로 새어나갔는데 **저장률 지표상으로는 성공한 세션**이었다.
  // 지표가 실패를 못 보는 것이 결함 자체보다 나쁘다.
  //
  // 그래서 기준선을 세션 시작에 고정하지 않고 **저장이 일어날 때마다 리셋**한다.
  // 침묵은 영구가 아니라 재출발이다.
  const base = Number.isFinite(m.cueBaseCount) ? m.cueBaseCount : m.count;
  const baseTurn = Number.isFinite(m.cueBaseTurn) ? m.cueBaseTurn : 0;
  const current = countMemories();
  if (current > base) {
    // 저장이 있었다 — 시계를 여기서 다시 시작하고 이번 턴은 조용히 지나간다
    writeMarker({ ...m, turns, cueBaseCount: current, cueBaseTurn: turns });
    emitPrompt();
    process.exit(0);
  }

  // 쿨다운 — 세션당 1회는 과했지만 매 턴도 안 된다(경보 피로). 그 사이를 잡는다.
  const COOLDOWN = (() => {
    const v = Number(process.env.BIGBRAIN_CUE_COOLDOWN);
    return Number.isFinite(v) && v > 0 ? v : 15;
  })();
  if (Number.isFinite(m.lastCueTurn) && turns - m.lastCueTurn < COOLDOWN) {
    writeMarker({ ...m, turns });
    emitPrompt();
    process.exit(0);
  }

  // 정정·놀라움의 어휘 신호. 사용자가 "아니라" 고 말하는 순간이 부호화 계기다.
  // prompt 가 안 오는 환경에서는 이 경로가 통째로 비활성화되고 아래 턴 기반으로 퇴화한다.
  const LEXICAL = /아니(야|라|고|다|에요|예요)|틀렸|그게 아니|잘못(됐|했)|하지 ?말|말고|대신|정정|아까 말한|not that|actually|instead|you're wrong|that's wrong|no,? use/i;
  const lexicalHit = hookInput.prompt !== null && LEXICAL.test(hookInput.prompt);
  // prompt 를 못 받는 환경의 폴백 — 충분히 진행됐는데 아직 저장이 0건이면 한 번 물어본다
  const TURN_CUE = (() => {
    const v = Number(process.env.BIGBRAIN_CUE_TURNS);
    return Number.isFinite(v) && v > 0 ? v : 8;
  })();
  // 세션 시작이 아니라 **마지막 저장 이후** 몇 턴이 지났는지를 본다
  const turnHit = turns - baseTurn >= TURN_CUE;

  if (!lexicalHit && !turnHit) {
    writeMarker({ ...m, turns });
    emitPrompt();
    process.exit(0);
  }
  writeMarker({ ...m, turns, lastCueTurn: turns, cued: true });

  const tool = (n) => `mcp__${resolveServerName()}__${n}`;
  const why = lexicalHit
    ? `The user's message matched a correction-like phrasing. **This is a regex guess, not an observation** — ` +
      `verify against what the user actually wrote before treating it as a correction.`
    : `${turns - baseTurn} turns since anything was last stored${baseTurn > 0 ? " (a memory was stored earlier in this session — this is about what has happened since)" : ""}.`;

  emitPrompt(
    `<bigbrainmemory-cue kind="lexical-hint">\n` +
      `${why}\n` +
      `If a REMEMBER trigger genuinely fired — the user corrected you or stated a preference, a decision settled, ` +
      `you found a non-obvious root cause, a convention was agreed — call ${tool("remember")} **now**, while the ` +
      `wording is still verbatim in context, rather than at the end of the session. Record provenance accurately in ` +
      `\`source\` and pick \`type\` yourself; do not infer either from this cue. ` +
      `If nothing durable happened, ignore this and continue — it is shown once per session.\n` +
      `</bigbrainmemory-cue>`,
  );
  logUsage({ event: "cue", sessionId: m.sessionId, turns, reason: lexicalHit ? "lexical" : "turns" });
  process.exit(0);
}

if (mode === "start") {
  const count = countMemories();

  // 1) 비교 기준 기록.
  //
  // **매번 덮어쓰면 안 된다.** SessionStart 는 세션당 한 번이 아니라 startup/resume/
  // clear/compact 네 경우에 각각 발화한다. 종전처럼 무조건 현재 건수를 써버리면,
  // 세션 중간에 컨텍스트가 압축될 때 기준선이 "그때까지 저장한 만큼" 으로 리셋되고,
  // 그 전에 성실히 저장한 기억이 통째로 없던 일이 된다 → 종료 시 오탐 경고.
  // 재현: startup(0) → 2건 저장 → compact(기준선 2) → 종료 시 "0건" 경고.
  // 그래서 session_id 가 같으면 기존 기준선을 **보존**한다.
  const prev = readMarker();
  const total = countTotal();
  const sameSession =
    hookInput.sessionId && prev?.sessionId
      ? hookInput.sessionId === prev.sessionId
      : // session_id 를 못 받았을 때의 차선책 — 재개/압축은 이어지는 세션으로 본다
        !!prev && (hookInput.source === "resume" || hookInput.source === "compact");

  // 2) 손실 감지. 총량(활성+아카이브)은 정상 경로로 줄어들 수 없다 —
  // forget 은 이동이지 삭제가 아니기 때문이다. 줄었다면 볼트 밖에서 파일이 없어진 것이다.
  // 새 세션에서만 본다(같은 세션 안의 재개·압축에서 반복 경고하지 않도록).
  const lost = !sameSession && prev && Number.isFinite(prev.total) && prev.total > total ? prev.total - total : 0;

  if (!sameSession) {
    writeMarker({ sessionId: hookInput.sessionId, count, total, warned: false });
    // 새 세션의 시작만 기록한다 — resume/compact 재발화까지 세면 분모가 부풀어
    // 저장률이 실제보다 낮게 나온다
    logUsage({
      event: "session_start",
      sessionId: hookInput.sessionId,
      source: hookInput.source,
      count,
      total,
      ...(lost > 0 ? { lost } : {}),
    });
  } else if (prev && hookInput.source === "compact" && prev.autoSlugs.length > 0) {
    // 압축으로 앞서 주입한 자동 회상 블록이 컨텍스트에서 빠졌을 수 있다 — 다시 주입할 수 있게 비운다
    writeMarker({ ...prev, autoSlugs: [] });
  }

  // 볼트 디렉터리 자체가 없으면 침묵한다. 이건 콜드 스타트가 아니라 **설정이 어긋난**
  // 상태이고(경로 오타, 아직 이 프로젝트에 붙이지 않음), 그걸 매 세션 떠들면 노이즈다.
  if (!fs.existsSync(vaultDir)) process.exit(0);

  // 손실은 **가장 먼저** 말한다. 특히 전부 사라져 count===0 이 된 경우, 아래 콜드 스타트 분기는
  // "빈 볼트는 정상" 이라고 안심시키므로 정반대의 신호를 준다. 그 오해를 여기서 차단한다.
  const lossWarning =
    lost > 0
      ? `<bigbrainmemory-alert severity="high">\n` +
        `MEMORY LOSS DETECTED — the vault held ${lost + total} memories at the last session start and holds ${total} now ` +
        `(active + archived). This count cannot drop on its own: \`forget\` moves files to archive/ instead of deleting, ` +
        `so ${lost} memories disappeared outside the normal path — a wrong BIGBRAIN_VAULT path, an external delete, or a test ` +
        `pointed at the live vault. Tell the user before doing anything else, and do NOT start re-storing from scratch ` +
        `until the cause is known: if the vault is merely misconfigured, the memories still exist elsewhere and duplicating ` +
        `them will split the vault in two.\n` +
        `</bigbrainmemory-alert>\n`
      : "";

  const attrs = `vault="${vaultDir.replace(/\\/g, "/")}" memories="${count}"`;
  // 지연 로드된 도구는 정확한 이름으로만 불러올 수 있다 — 이름을 그대로 노출한다.
  const tool = (n) => `mcp__${resolveServerName()}__${n}`;
  const toolLines =
    `Load these by name when you need them (they may be lazily loaded and thus invisible until asked for):\n` +
    `  ${tool("recall")}   — search memory before answering from assumption\n` +
    `  ${tool("remember")} — store a durable fact, decision, preference, or lesson\n`;

  // 2) 볼트 상태 주입 (회상 트리거 채널 ②).
  //
  // 콜드 스타트에도 **반드시** 주입한다. 예전에는 MEMORY.md 본문이 비면 침묵했는데,
  // 그 침묵이 자기강화 루프를 만들었다: 볼트가 비어 있음 → 주입할 인덱스가 없음 →
  // 모델이 메모리의 존재를 인지 못 함 → 저장 0건 → 다음 세션도 비어 있음.
  // 대조 실험에서 이 루프가 실증됐다. 서버 instructions 의 COLD START 문구는 두 세션
  // 모두 온전히(1842자, 무절단) 도착했는데도 행동을 만들지 못했고, 갈린 변수는
  // **훅이 컨텍스트에 무언가를 넣었는가** 하나뿐이었다. 즉 instructions 만으로는
  // 부족하고 이 주입이 실제 트리거다.
  if (count === 0) {
    process.stdout.write(
      lossWarning +
        `<bigbrainmemory-index ${attrs}>\n` +
        `COLD START — this vault holds 0 memories. That is expected on a fresh vault and is NOT ` +
        `evidence that memory is unneeded; it means seeding the vault is part of this session's job.\n` +
        toolLines +
        `Call remember the moment a trigger fires — a decision settles, the user states a preference ` +
        `or corrects you, you find a non-obvious root cause — not at the end of the session.\n` +
        `</bigbrainmemory-index>\n`,
    );
    process.exit(0);
  }

  let body = "";
  try {
    // BOM 제거 — 주입되는 컨텍스트 첫머리에 보이지 않는 문자가 섞이지 않게 한다
    const md = fs.readFileSync(path.join(vaultDir, "MEMORY.md"), "utf-8").replace(/^﻿/, "");
    const lines = md.split(/\r?\n/);
    body = lines.slice(0, MAX_LINES).join("\n").trimEnd();
    // **잘랐으면 잘랐다고 말한다.** 말없이 자르면 모델은 주입된 것이 볼트 전부라고
    // 읽고, 안 보이는 기억을 찾지 않는다 — 없는 것과 구분이 안 된다.
    if (lines.length > MAX_LINES) {
      body += `\n\n(index truncated at ${MAX_LINES} lines — ${count} memories are stored in total; the rest are reachable only via recall)`;
    }
  } catch {
    /* 인덱스 파일이 없거나 못 읽음 — 아래에서 건수만으로 대체한다 */
  }
  // 기억이 있는데 인덱스를 못 읽었다면 침묵이 아니라 건수라도 알린다.
  // 여기서 침묵하면 "기억이 있는 볼트" 가 "빈 볼트" 와 구분되지 않는다.
  if (body === "") body = `(index unavailable — ${count} memories are stored; use recall to reach them)`;

  // 출처(볼트 경로·건수)를 함께 밝힌다 — 서버가 다른 볼트를 보고 있으면
  // "인덱스엔 기억이 있는데 서버는 EMPTY" 라는 모순이 눈에 보여야 한다.
  // 밝히지 않으면 모델은 인덱스만 보고 "메모리가 잘 돌고 있다" 고 오판한다.
  // 검증 지시를 반드시 함께 내보낸다.
  //
  // 이 블록은 대화 컨텍스트에 **사실처럼** 들어가고 확신도까지 달려 있어서, 모델이
  // 코드를 확인하지 않고 그대로 단정하는 프라이밍 사고가 관측됐다(사용자가 친 문자열이
  // 기억의 템플릿에 우연히 맞자, 저장소를 열어보기 전에 "이 프로젝트는 X 로 되어 있으므로"
  // 라고 답한 뒤 그 다음에 grep 을 시작했다). 네이티브 메모리는 기억 파일을 읽을 때마다
  // "N일 전 관측이다 — 현재 코드와 대조하라" 를 자동으로 붙여 이 위험을 막는다.
  // 주입은 회상을 **대체하는 것이 아니라 시작점**이라는 점을 같은 블록 안에서 말한다.
  process.stdout.write(
    lossWarning +
      `<bigbrainmemory-index ${attrs}>\n${body}\n</bigbrainmemory-index>\n` +
      toolLines +
      `These lines are point-in-time observations, not live state, and each carries its age. ` +
      `Treat them as a starting point for retrieval — not as verified fact: before asserting anything from ` +
      `this index about code, paths, versions or config, read the current source, and \`revise\` the memory if reality moved on. ` +
      `Use recall for full text; a one-line summary is not the memory.\n` +
      `(This index was injected by a SessionStart hook reading the vault above. ` +
      `If the bigbrainmemory server reports a different vault or says the vault is EMPTY, ` +
      `the two are pointing at different paths — trust the server's tools, and tell the user about the mismatch.)\n`,
  );
  process.exit(0);
}

// ── stop: 무저장 세션 감지
//
// 왜 "파일 수 증가" 로 판정하는가:
//   mtime 비교(-newer)를 쓰면 recall 의 강화 쓰기까지 "저장됨" 으로 잡혀,
//   정작 잡아야 할 무저장 세션이 조용히 통과한다(거짓 음성).
//   remember 로 새 노트가 생겼는지만 보는 편이 목적에 정확하다.
const m = readMarker();

// 비교 기준이 없으면 침묵한다 — 근거 없는 경고는 노이즈일 뿐이다
if (!m || !Number.isFinite(m.count)) process.exit(0);

// 마커를 남긴 세션과 지금 끝나는 세션이 다르면 비교가 성립하지 않는다.
// (여러 세션이 한 볼트를 공유하면 마커는 마지막 SessionStart 것이다)
if (hookInput.sessionId && m.sessionId && hookInput.sessionId !== m.sessionId) process.exit(0);

// 도구 호출 수는 "실제로 작업한 세션인가" 의 근사다 — 계측의 분모를 가르는 값이라
// 경고 게이트보다 먼저 재둔다(못 재면 null).
const toolUses = (() => {
  if (!hookInput.transcriptPath) return null;
  try {
    return (fs.readFileSync(hookInput.transcriptPath, "utf-8").match(/"type"\s*:\s*"tool_use"/g) ?? []).length;
  } catch {
    return null;
  }
})();

const stored = countMemories() - m.count;
if (stored > 0) {
  // 저장됐다 — 조용히 통과하되 **결과는 기록한다.** 이 값이 A/B 의 1차 지표(저장률)다.
  //
  // 두 개의 플래그를 쓰는 이유: Stop 은 매 턴 발화하므로 무제한 기록하면 턴 수만큼
  // 부풀지만, 반대로 "한 번 기록했으면 끝" 으로 두면 **경고를 받고 나서 저장한 세션이
  // 영원히 저장 0 으로 남는다.** 그건 우리가 유도하려는 바로 그 행동이므로 놓치면
  // 지표가 개선을 못 잡는다. 그래서 무저장 기록과 저장 기록을 따로 1회씩 허용하고,
  // 리포트가 세션별로 최대값을 취해 최종 결과를 쓴다.
  if (!m.loggedStored) {
    writeMarker({ ...m, logged: true, loggedStored: true });
    logUsage({ event: "session_end", sessionId: m.sessionId, stored, toolUses, warned: m.warned === true });
  }
  process.exit(0);
}

// **Stop 은 세션 끝이 아니라 매 턴 발화한다.** 그대로 두면 저장 전까지 모든 응답마다
// 같은 경고가 반복돼, 정작 봐야 할 신호가 소음에 묻힌다(경보 피로).
// 그래서 세션당 한 번만 알린다.
if (m.warned) process.exit(0);

// 실제로 작업한 세션에만 말을 건다 — 도구 호출 수로 판정한다(위 상수 주석 참고).
// 못 재면 종전대로 알린다(모른다고 침묵하면 안전망 자체가 사라진다).
if (hookInput.transcriptPath && MIN_TOOL_USES > 0 && toolUses !== null) {
  // 서브에이전트에 위임한 세션은 **부모 트랜스크립트에 호출 흔적이 거의 없다.**
  // 실제 작업은 별도 컨텍스트에서 벌어졌는데 부모 기준으로는 한두 번 부른 잡담처럼
  // 보여 게이트에 걸린다. 위임 자체를 작업 신호로 취급해 게이트를 통과시킨다.
  // (위임이 저장을 억제하는지는 아직 미측정이다 — 여기서 침묵하면 그 측정 자체가
  //  오염되므로, 제품 효과가 아니라 관측 가능성을 위해 넣는다)
  let delegated = false;
  try {
    delegated = /"name"\s*:\s*"(Agent|Task)"/.test(fs.readFileSync(hookInput.transcriptPath, "utf-8"));
  } catch {
    /* 못 읽음 — 게이트를 통과시킨다 */
  }
  if (toolUses < MIN_TOOL_USES && !delegated) {
    // 잡담 세션은 경고하지 않지만 **분모에서 빼지도 않는다.** 저장률을 계산할 때
    // "작업 세션" 만 세려면 이 구분이 로그에 남아 있어야 한다.
    if (!m.logged) {
      writeMarker({ ...m, logged: true });
      logUsage({ event: "session_end", sessionId: m.sessionId, stored: 0, toolUses, warned: false, belowGate: true });
    }
    process.exit(0);
  }
}

writeMarker({ ...m, warned: true, logged: true });
logUsage({ event: "session_end", sessionId: m.sessionId, stored: 0, toolUses, warned: true });

// **평문 stdout 으로 내면 아무에게도 도달하지 않는다.** 공식 문서:
//   "For most events, stdout is written to the debug log but not shown in the transcript.
//    The exceptions are UserPromptSubmit, UserPromptExpansion, and SessionStart,
//    where stdout is added as context that Claude can see and act on."
// Stop 은 그 예외 목록에 없다. 종전 구현은 이 경고를 평문으로 냈고, 그래서
// 마커·세션키잉·1회제한·도구게이트라는 장치 전체가 **디버그 로그로만** 흘러갔다.
// 회귀 테스트가 문자열만 검사해 통과시키는 바람에 6일간 드러나지 않았다.
//
// Stop 이 모델에 도달하는 유일한 비차단 경로는 JSON 의 hookSpecificOutput.additionalContext 다
// (같은 문서: "Stop and SubagentStop also accept hookSpecificOutput.additionalContext
//  for non-error feedback that continues the conversation").
// decision:"block" 은 쓰지 않는다 — 세션을 막지 않는다는 이 파일의 원칙(파일 상단) 때문이다.
//
// 수신자가 사용자가 아니라 **모델**로 바뀌었으므로 문구도 그에 맞춘다. 사람에게 권하는
// 안내문이 아니라, 모델이 지금 무엇을 판단해 무엇을 호출해야 하는지를 적는다.
const tool = (n) => `mcp__${resolveServerName()}__${n}`;
process.stdout.write(
  `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext:
        `BigBrainMemory: this session stored 0 new memories (vault still holds ${m.count}). ` +
        `Before finishing, check whether any REMEMBER trigger fired in this session — a decision settled, ` +
        `the user corrected you or stated a preference, you found a non-obvious root cause, a convention was agreed. ` +
        `If one did, call ${tool("remember")} now with what you still have verbatim in context. ` +
        `This is a fallback: the right moment was when the trigger fired, not at the end. ` +
        `If this session was compacted and you would be reconstructing from a summary rather than recalling verbatim, ` +
        `store nothing and say so. If nothing durable came up, ignore this — it is shown once per session.`,
    },
  })}\n`,
);
process.exit(0); // 경고일 뿐 — 세션 종료를 막지 않는다
