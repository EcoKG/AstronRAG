/** @typedef {Readonly<Record<string, string | undefined>>} Environment */

export const LEGACY_WARNING_SYMBOL = Symbol.for("astronrag.env.legacy-warning.v1");

/**
 * 새 환경 변수와 호환 이름을 읽는 공용 호출 계약을 선언한다.
 * @param {string} newName
 * @param {string} legacyName
 * @param {Environment} [env=process.env]
 * @param {boolean} [warnLegacy=true]
 * @returns {string | undefined}
 */
export function readEnv(newName, legacyName, env = process.env, warnLegacy = true) {
	throw new Error("readEnv is not implemented");
}
