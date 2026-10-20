/** @typedef {Readonly<Record<string, string | undefined>>} Environment */

export const LEGACY_WARNING_SYMBOL = Symbol.for("astronrag.env.legacy-warning.v1");

/**
 * 새 이름을 우선하고 옛 환경 변수 사용을 프로세스당 한 번 안내한다.
 * @param {string} newName
 * @param {string} legacyName
 * @param {Environment} [env=process.env]
 * @param {boolean} [warnLegacy=true]
 * @returns {string | undefined}
 */
export function readEnv(newName, legacyName, env = process.env, warnLegacy = true) {
	if (env[newName] !== undefined) return env[newName];
	const value = env[legacyName];
	if (value !== undefined && warnLegacy && !globalThis[LEGACY_WARNING_SYMBOL]) {
		globalThis[LEGACY_WARNING_SYMBOL] = true;
		process.stderr.write(`${legacyName} 대신 ${newName} 를 쓰십시오\n`);
	}
	return value;
}
