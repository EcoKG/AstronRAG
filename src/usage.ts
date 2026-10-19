import fs from "node:fs";
import path from "node:path";
import type { MemoryStore as Storage } from "./stores/memory-store.js";

/**
 * 사용 계측 — append-only JSONL 로그 (T33).
 *
 * **왜 필요한가.** 실사용 기저선을 재보니 트랜스크립트 1,492개에서 이 서버의 도구가
 * 실제로 호출된 것은 3회였고, 라이브 볼트 2건은 둘 다 `access_count: 0` 이었다.
 * 그런데 그 사실을 알아내는 데 트랜스크립트 전수 grep 이 필요했다 — 저장소 안에는
 * 저장률도 회상률도 재는 수단이 없다.
 *
 * `access_count` 로는 대신할 수 없다. 간격 게이트가 닫혀 있으면 강화 쓰기를 생략하므로
 * 디스크의 값은 "조회 횟수" 가 아니라 "게이트가 열린 채 조회된 횟수" 다(store.ts 참고).
 * 성능을 위한 의도된 절충이지만, 그래서 계측 지표로는 못 쓴다.
 *
 * **설계 규칙**
 * - 절대 던지지 않는다. 계측 실패가 기억 조회·저장을 망가뜨리면 안 된다.
 * - **내용을 기록하지 않는다.** 질의문·본문·제목은 남기지 않는다 — 로그는 사용자의
 *   기억 그 자체가 아니라 "무엇이 몇 번 일어났는가" 만 담는다. 골든 질의셋을 만들 때처럼
 *   질의문이 필요하면 `BIGBRAIN_LOG_QUERIES=1` 로 명시적으로 켠다.
 * - 볼트 안에 점 파일로 둔다 — Obsidian 에서 숨겨지고, 설명 대상인 볼트와 함께 이동한다.
 * - `BIGBRAIN_USAGE_LOG=0` 으로 끌 수 있다.
 */

const DISABLED = process.env.BIGBRAIN_USAGE_LOG === "0";
const LOG_QUERIES = /^(1|true|yes)$/i.test(process.env.BIGBRAIN_LOG_QUERIES ?? "");
/** 이 크기를 넘으면 .old 로 한 번 굴린다 (무한 증식 방지). 기본 5MB */
const MAX_BYTES = (() => {
  const v = Number(process.env.BIGBRAIN_USAGE_LOG_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 5 * 1024 * 1024;
})();

/** 프로세스 1개 = 세션 1개(stdio 는 클라이언트가 세션마다 spawn 한다)에 가까운 근사 식별자 */
const PROCESS_ID = `${process.pid}-${Date.now().toString(36)}`;

export type UsageEvent = {
  tool: string;
  ok: boolean;
  /** 도구별 메타데이터 — 내용이 아니라 수치만 */
  [k: string]: unknown;
};

let logPath: string | null = null;
let storage: Storage | null = null;

export function initUsageLog(target: string | Storage): void {
  if (typeof target === "string") {
    storage = null;
    logPath = path.join(target, ".bbm-usage.jsonl");
    return;
  }
  storage = target;
  logPath = null;
}

/** 질의문은 기본적으로 길이만 남긴다 (내용 비기록 원칙) */
export function queryField(q: string | undefined): Record<string, unknown> {
  if (q === undefined) return {};
  return LOG_QUERIES ? { query: q } : { queryLen: q.length };
}

export function logUsage(event: UsageEvent): void {
  if (DISABLED || (!storage && !logPath)) return;
  try {
    const row = { ts: new Date().toISOString(), pid: PROCESS_ID, ...event };
    if (storage) {
      storage.appendUsageEvent(row);
      return;
    }
    if (!logPath) return;
    try {
      if (fs.statSync(logPath).size > MAX_BYTES) fs.renameSync(logPath, `${logPath}.old`);
    } catch {
      /* 파일이 없거나 rename 실패 시 다음 append가 처리한다. */
    }
    fs.appendFileSync(logPath, `${JSON.stringify(row)}\n`, "utf-8");
  } catch {
    /* 사용량 계측은 기억 동작을 막지 않는다. */
  }
}
