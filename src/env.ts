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
