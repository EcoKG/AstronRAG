export type Environment = Readonly<Record<string, string | undefined>>;

export const LEGACY_WARNING_SYMBOL = Symbol.for("astronrag.env.legacy-warning.v1");

/** 새 환경 변수를 우선 읽고 옛 이름 사용을 프로세스당 한 번 안내한다. */
export function readEnv(
	newName: string,
	legacyName: string,
	env: Environment = process.env,
	warnLegacy: boolean = true,
): string | undefined {
	if (env[newName] !== undefined) return env[newName];
	const value = env[legacyName];
	const state = globalThis as typeof globalThis & { [LEGACY_WARNING_SYMBOL]?: boolean };
	if (value !== undefined && warnLegacy && !state[LEGACY_WARNING_SYMBOL]) {
		state[LEGACY_WARNING_SYMBOL] = true;
		console.error(`${legacyName} 대신 ${newName} 를 쓰십시오`);
	}
	return value;
}

const DEFAULT_USAGE_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** 사용 로그 상한 바이트를 읽고 미설정·0·음수·비정수는 기본 5MiB로 대체한다. */
export function usageLogMaxBytes(env: Environment = process.env): number {
	const raw = readEnv("ASTRONRAG_USAGE_LOG_MAX_BYTES", "BIGBRAIN_USAGE_LOG_MAX_BYTES", env)?.trim();
	const value = raw !== undefined && /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
	return Number.isSafeInteger(value) ? value : DEFAULT_USAGE_LOG_MAX_BYTES;
}