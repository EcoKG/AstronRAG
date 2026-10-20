#!/usr/bin/env node
// AstronRAG 세션 훅을 설치하거나 제거한다.
//
// 왜 이 스크립트가 필요한가:
//   MCP 서버는 호스트(Claude Code)의 설정 파일을 건드릴 수 없다 — stdio 로 격리된
//   별개 프로세스이고, 프로토콜에 "설정을 바꿔달라" 는 메시지 타입 자체가 없다.
//   그래서 훅은 구조적으로 자동 생성이 불가능하며, 사용자가 명시적으로 실행하는
//   이 스크립트가 그 간극을 메운다.
//
// 왜 postinstall 이 아닌가:
//   전역 설정을 몰래 고치는 것은 나쁜 관행이다. Claude Code 를 쓰지 않는 사용자,
//   CI 환경에서도 실행되어 버린다. 반드시 사용자가 직접 부른다.
//
// 처리하는 함정 4가지:
//   1) OS 분기 — POSIX(sh) 와 Windows(PowerShell) 는 문법이 완전히 다르다.
//   2) 셸 변수 회피 — 명령 문자열에 `$` 를 쓰면 호스트 셸이 먼저 치환해 명령이 깨진다.
//      양쪽 명령 모두 변수를 쓰지 않는다.
//   3) 볼트 경로 주입 — ASTRONRAG_VAULT 를 지정한 사용자는 훅도 그 경로를 봐야 한다.
//      등록된 MCP 서버 설정에서 실제 경로를 읽어와 일치시킨다.
//   4) 기존 설정 병합 — 다른 훅을 쓰고 있을 수 있으므로 덮어쓰지 않고 항목만 더한다.
//
// 사용법:
//   npm run setup:hook                 설치(기본) — 백업 후 적용
//   npm run setup:hook -- --dry-run    무엇이 바뀌는지만 출력, 쓰지 않음
//   npm run setup:hook -- --remove     제거
//   npm run setup:hook -- --vault <경로>     볼트 경로 직접 지정
//   npm run setup:hook -- --settings <경로>  대상 settings.json 직접 지정
//                                            (예: 저장소의 .claude/settings.json)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { readEnv } from "./lib/env.mjs";

/**
 * 우리 훅을 식별하는 표식 — 이 문자열로 기존 항목을 찾아 갱신/제거한다.
 * 구버전(셸 one-liner)도 함께 인식해야 재실행 시 깨끗이 교체된다.
 */
const HOOK_MARKERS = ["session-guard.mjs", "<bigbrainmemory-index>"];
/** 실제 로직이 든 스크립트 — 훅은 이 파일을 호출만 한다 */
const GUARD = path.join(repoRootPlaceholder(), "scripts", "session-guard.mjs");
function repoRootPlaceholder() {
  // repoRoot 는 아래에서 정의되므로, 상수 초기화 순서를 피하려고 함수로 감싼다
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

// ── 인자 파싱
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

const DRY_RUN = hasFlag("--dry-run");
const REMOVE = hasFlag("--remove");
const settingsPath = path.resolve(
  valueOf("--settings") ?? path.join(os.homedir(), ".claude", "settings.json"),
);

let failed = false;
const fail = (msg) => {
  console.error(`  ✘ ${msg}`);
  failed = true;
};

/** 명시 경로·등록 서버·환경·저장소 기본값 순서로 설치 볼트를 정한다. */
function resolveVault() {
  const flag = valueOf("--vault");
  if (flag) return { dir: path.resolve(flag), source: "--vault 플래그" };

  try {
    const cj = path.join(os.homedir(), ".claude.json");
    if (fs.existsSync(cj)) {
      const parsed = JSON.parse(fs.readFileSync(cj, "utf-8"));
      const env = parsed?.mcpServers?.astronrag?.env ?? {};
      const fromEnv = readEnv("ASTRONRAG_VAULT", "BIGBRAIN_VAULT", env, false);
      if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
        readEnv("ASTRONRAG_VAULT", "BIGBRAIN_VAULT", env);
        return { dir: path.resolve(fromEnv), source: "등록된 MCP 서버 설정(~/.claude.json)" };
      }
    }
  } catch {
    /* 등록 정보를 못 읽어도 다음 후보로 넘어간다 */
  }

  const vault = readEnv("ASTRONRAG_VAULT", "BIGBRAIN_VAULT");
  if (vault?.trim()) {
    return { dir: path.resolve(vault), source: "ASTRONRAG_VAULT 환경변수" };
  }
  return { dir: path.join(repoRoot, "vault"), source: "기본값(<저장소>/vault)" };
}

/**
 * 훅 명령 생성 (함정 1·2 해소).
 *
 * 셸 문법을 아예 쓰지 않는다 — 로직은 session-guard.mjs 안에 있고, 훅은 그것을
 * 호출만 한다. 그래서 OS 분기도, 따옴표 이스케이프도, `$` 치환 사고도 없다.
 * node 는 PATH 대신 **현재 실행 중인 절대 경로**(process.execPath)를 박는다 —
 * 호스트가 훅을 띄울 때 PATH 가 비어 있을 수 있기 때문이다.
 * 경로는 forward slash 로 통일해 JSON 백슬래시 이스케이프를 피한다.
 */
function buildCommands(vaultDir, explicit) {
  const node = process.execPath.replace(/\\/g, "/");
  const guard = GUARD.replace(/\\/g, "/");
  const vault = vaultDir.replace(/\\/g, "/");
  // 사용자가 --vault 로 명시했으면 --vault-force 로 박아 자동탐지를 이기게 하고,
  // 자동 감지값이면 --vault 로 넘겨 **실행 시점 탐지가 우선**하게 둔다.
  // 후자가 핵심이다: 설치 시점 경로를 고정하면 프로젝트별 볼트 분리가 깨진다.
  const flag = explicit ? "--vault-force" : "--vault";
  const base = `"${node}" "${guard}"`;
  return {
    SessionStart: `${base} --start ${flag} "${vault}"`,
    Stop: `${base} --stop ${flag} "${vault}"`,
    // 자동 회상(T44)·부호화 큐(T34) — 턴 **시작** 시점에 나가야 원문이 아직 살아 있다.
    // Stop 은 세션 끝이라 이미 늦고, 압축됐다면 요약에서 재구성하게 된다(P8 위반).
    UserPromptSubmit: `${base} --prompt ${flag} "${vault}"`,
  };
}

function loadSettings() {
  if (!fs.existsSync(settingsPath)) return {};
  // BOM 제거 — Windows 에서 메모장이나 PowerShell 로 settings.json 을 편집하면
  // BOM 이 붙는데, JSON.parse 는 이를 거부한다. 사용자에게는 멀쩡해 보이는 파일이라
  // 벗겨주지 않으면 "문법을 고치라" 는 안내가 오히려 혼란만 준다.
  const raw = fs.readFileSync(settingsPath, "utf-8").replace(/^﻿/, "");
  if (raw.trim() === "") return {};
  return JSON.parse(raw); // 진짜로 깨진 JSON 은 여기서 던져 상위에서 안내한다
}

/** 훅 배열에서 우리 항목의 인덱스 (없으면 -1). 구버전 셸 명령도 인식한다 */
function findOurs(list) {
  return list.findIndex((entry) =>
    (entry?.hooks ?? []).some(
      (h) =>
        typeof h?.command === "string" && HOOK_MARKERS.some((m) => h.command.includes(m)),
    ),
  );
}

/**
 * 한 훅 이벤트(SessionStart / Stop)에 우리 항목을 반영한다.
 * 기존 항목이 있으면 제자리 갱신(중복 생성 방지), 없으면 추가.
 * 반환: { action, otherCount, unchanged }
 */
function applyHook(hooks, event, command) {
  const list = Array.isArray(hooks[event]) ? hooks[event] : [];
  const idx = findOurs(list);
  const otherCount = list.length - (idx >= 0 ? 1 : 0);
  const entry = { hooks: [{ type: "command", command, timeout: 10 }] };

  if (REMOVE) {
    if (idx < 0) return { action: "없음", otherCount, unchanged: true };
    list.splice(idx, 1);
    if (list.length === 0) delete hooks[event];
    else hooks[event] = list;
    return { action: "제거", otherCount, unchanged: false };
  }

  if (idx >= 0) {
    if (list[idx]?.hooks?.[0]?.command === command) {
      return { action: "동일", otherCount, unchanged: true };
    }
    list[idx] = entry;
    hooks[event] = list;
    return { action: "갱신", otherCount, unchanged: false };
  }
  list.push(entry);
  hooks[event] = list;
  return { action: "추가", otherCount, unchanged: false };
}

function backup() {
  if (!fs.existsSync(settingsPath)) return null;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const dest = `${settingsPath}.bak-bbm-${stamp}`;
  fs.copyFileSync(settingsPath, dest);
  return dest;
}

// ── 본체
console.log(`AstronRAG — 세션 훅 ${REMOVE ? "제거" : "설치"}\n`);

const vault = resolveVault();
const explicitVault = vault.source === "--vault 플래그";
const commands = buildCommands(vault.dir, explicitVault);

console.log(`설정 파일 : ${settingsPath}`);
console.log(`볼트 경로 : ${vault.dir}`);
console.log(`  └ 출처  : ${vault.source}`);
console.log(
  explicitVault
    ? `  └ 고정  : --vault 로 명시하셨으므로 이 경로로 고정합니다.`
    : `  └ 추적  : 훅은 매 세션 실행 시점에 볼트를 다시 해석합니다 — 프로젝트별\n            .mcp.json 으로 볼트를 나눠도 훅이 따라갑니다(이 값은 폴백).`,
);
if (!fs.existsSync(vault.dir)) {
  console.log(`  ⚠ 아직 존재하지 않습니다 — 첫 기억을 저장하면 생성됩니다.`);
}
console.log("");

let settings;
try {
  settings = loadSettings();
} catch (err) {
  console.error(`설정 파일을 파싱할 수 없습니다: ${settingsPath}`);
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  console.error("  JSON 문법을 고친 뒤 다시 실행하세요. 아무것도 변경하지 않았습니다.");
  process.exit(1);
}

const hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};

// 세 훅을 한 벌로 다룬다 — 전부 같은 마커 파일로 세션 상태를 공유한다.
//   SessionStart    회상 트리거 (볼트 인덱스 주입)
//   UserPromptSubmit 자동 회상·부호화 큐 (턴 시작 — 원문이 아직 살아 있는 시점)
//   Stop            무저장 감지 (안전망, 세션 끝)
const results = {
  SessionStart: applyHook(hooks, "SessionStart", commands.SessionStart),
  UserPromptSubmit: applyHook(hooks, "UserPromptSubmit", commands.UserPromptSubmit),
  Stop: applyHook(hooks, "Stop", commands.Stop),
};
if (Object.keys(hooks).length === 0) delete settings.hooks;
else settings.hooks = hooks;

for (const [event, r] of Object.entries(results)) {
  console.log(`${event.padEnd(13)}: ${r.action} (기존 다른 항목 ${r.otherCount}개 보존)`);
}

if (Object.values(results).every((r) => r.unchanged)) {
  console.log(
    REMOVE
      ? "\n설치된 AstronRAG 훅이 없습니다. 변경할 것이 없습니다."
      : "\n이미 동일한 설정으로 설치돼 있습니다. 변경할 것이 없습니다." +
          "\n(볼트 경로를 바꿨다면 --vault 로 지정해 다시 실행하세요.)",
  );
  process.exit(0);
}

if (!REMOVE) {
  // commands 를 그대로 순회한다 — 하드코딩하면 훅을 늘렸을 때 표시가 조용히 빠진다
  // (실제로 UserPromptSubmit 추가 시 "추가" 로 집계되면서 명령 목록에는 안 나왔다)
  console.log(`\n등록할 명령:`);
  const width = Math.max(...Object.keys(commands).map((k) => k.length));
  for (const [event, cmd] of Object.entries(commands)) {
    console.log(`  ${event.padEnd(width)} : ${cmd}`);
  }
}
console.log("");

if (DRY_RUN) {
  console.log("--dry-run 이므로 아무것도 쓰지 않았습니다.");
  process.exit(0);
}

// 실제 동작하는 명령인지 먼저 확인 — 못 도는 명령을 설정에 남기지 않는다
if (!REMOVE) {
  console.log("명령 자체 검증:");
  if (!fs.existsSync(GUARD)) {
    fail(`훅 본체를 찾을 수 없습니다: ${GUARD}`);
  }
  for (const [event, cmd] of Object.entries(commands)) {
    try {
      execSync(cmd, { encoding: "utf-8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
      console.log(`  ✔ ${event} 정상 실행`);
    } catch (err) {
      fail(`${event} 실행 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

if (failed) {
  console.error("\n검증에 실패해 설정을 변경하지 않았습니다.");
  process.exit(1);
}

const bak = backup();
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");

// 쓰고 나서 다시 읽어 유효성 확인 — 깨진 설정을 남기면 Claude 가 뜨지 않는다
try {
  JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
} catch (err) {
  console.error(`\n치명적: 쓴 설정이 유효한 JSON 이 아닙니다 — ${err}`);
  if (bak) {
    fs.copyFileSync(bak, settingsPath);
    console.error(`백업에서 복구했습니다: ${bak}`);
  }
  process.exit(1);
}

console.log(`\n백업      : ${bak ?? "(기존 파일 없음 — 새로 생성)"}`);
console.log(`✔ ${REMOVE ? "제거" : "설치"} 완료: ${settingsPath}`);
if (!REMOVE) {
  console.log("\n다음 단계: Claude 를 재시작하면");
  console.log("  · SessionStart — 매 세션 시작 시 MEMORY.md 를 주입합니다(회상).");
  console.log("  · UserPromptSubmit — 부호화 큐를 내고, ASTRONRAG_AUTO_RECALL=1 이면 프롬프트와 관련된 기억을 자동 주입합니다(기본 끔).");
  console.log("  · Stop         — 세션에서 새로 저장된 기억이 0건이면 경고합니다(무저장 감지).");
  console.log("되돌리려면: npm run setup:hook -- --remove");
} else {
  console.log("Claude 를 재시작하면 반영됩니다.");
}
