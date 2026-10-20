export type Environment = Readonly<Record<string, string | undefined>>;

export const LEGACY_WARNING_SYMBOL = Symbol.for("astronrag.env.legacy-warning.v1");

/** 새 환경 변수와 호환 이름을 읽는 공용 호출 계약을 선언한다. */
export function readEnv(
	newName: string,
	legacyName: string,
	env: Environment = process.env,
	warnLegacy: boolean = true,
): string | undefined {
	throw new Error("readEnv is not implemented");
}
