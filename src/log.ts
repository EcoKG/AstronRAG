/**
 * stderr 로그 위계 (T39).
 *
 * stdout 은 MCP 프로토콜 전용이라 모든 로그가 stderr 로 갈 수밖에 없다. 그런데
 * 수준 표기가 없어 로그 수집기가 "stderr = 오류" 로 집계했고, 실측에서 그렇게
 * 집계된 "오류" 22건이 전부 정상 기동 메시지(ready.)였다 — 소음이 신호를 덮으면
 * 진짜 오류도 함께 묻힌다.
 *
 * 접두 형식: `[AstronRAG][info|warn|error]`. 파서가 수준만 보고 거를 수 있다.
 */
export function logInfo(msg: string): void {
  console.error(`[AstronRAG][info] ${msg}`);
}

export function logWarn(msg: string): void {
  console.error(`[AstronRAG][warn] ${msg}`);
}

export function logError(msg: string, err?: unknown): void {
  const detail = err === undefined ? "" : ` — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
  console.error(`[AstronRAG][error] ${msg}${detail}`);
}
