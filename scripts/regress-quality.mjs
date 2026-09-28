// 기억 품질 가드 회귀 시험 — 비밀 차단(T47), 모순 신호(T48), 검토일·타입별 낡음(T49), 긴 본문 경고(T50).
//
// 라이브 볼트는 건드리지 않는다 — 전부 os.tmpdir() 임시 볼트.
// 가짜 키는 push protection 에 걸리지 않도록 문자열 조합으로만 만든다.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 사용자 환경의 임계 설정이 기본값 시험을 오염시키지 않게 비운다 (store 모듈 로드 전에)
delete process.env.BIGBRAIN_STALE_DAYS;
delete process.env.BIGBRAIN_PROJECT;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const entry = path.join(root, "dist", "index.js");
const distUrl = (f) => `file://${path.join(root, "dist", f).replace(/\\/g, "/")}`;
const { Vault } = await import(distUrl("vault.js"));
const { MemoryStore } = await import(distUrl("store.js"));

const DAY_MS = 86_400_000;
let passes = 0;
let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passes++;
    console.log(`  ✔ ${name}`);
  } else {
    failures++;
    console.error(`  ✘ ${name} ${detail}`);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-quality-"));
const freshDir = (tag) => fs.mkdtempSync(path.join(tmpRoot, `${tag}-`));

/** 로컬 날짜 YYYY-MM-DD (오늘 기준 offset 일) */
function localDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * DAY_MS);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function withClient(dir, fn, env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, BIGBRAIN_VAULT: dir, ...env },
  });
  const client = new Client({ name: "regress-quality", version: "0.0.1" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** JSON 이면 파싱 결과, 아니면 undefined */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 도구 호출 결과를 { isError, text, json } 으로 돌려준다 — 스키마 거부 예외도 오류로 취급 */
async function call(client, name, args) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    return { isError: r.isError === true, text, json: parseJson(text) };
  } catch (e) {
    const text = String(e?.message ?? e);
    return { isError: true, text, json: parseJson(text) };
  }
}

const memFiles = (dir) => {
  const d = path.join(dir, "memories");
  return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
};
const memPath = (dir, slug) => path.join(dir, "memories", `${slug}.md`);

/** frontmatter 의 updated 를 N일(+1분) 전으로 되감는다 */
function rewind(dir, slug, days) {
  const fp = memPath(dir, slug);
  const past = new Date(Date.now() - days * DAY_MS - 60_000).toISOString();
  fs.writeFileSync(fp, fs.readFileSync(fp, "utf-8").replace(/updated: .*/, `updated: '${past}'`), "utf-8");
}

// ── T47 비밀정보 차단
console.log("T47) 비밀정보 차단");
{
  const dir = freshDir("secret");
  const fakes = [
    ["sk-ant-", ["sk", "ant", "api03", ""].join("-") + "A".repeat(40)],
    ["sk-", "sk" + "-" + "proj" + "-" + "B".repeat(30)],
    ["ghp_", "gh" + "p_" + "C".repeat(36)],
    ["AKIA", "AK" + "IA" + "Q".repeat(16)],
    ["PRIVATE KEY", "-----BEGIN " + "RSA PRIVATE" + " KEY-----\nMIIEpA" + "x".repeat(20) + "\n-----END " + "RSA PRIVATE" + " KEY-----"],
    ["password=", "pass" + "word" + "=" + "hunter2x9"],
    ["DB_PASSWORD=", "DB_" + "PASS" + "WORD" + "=" + "hunter2x9"],
    ["PGPASSWORD=", "PG" + "PASS" + "WORD" + "=" + "s3cr3tVal"],
    ["MYSQL_ROOT_PASSWORD=", "MYSQL_ROOT_" + "PASS" + "WORD" + " = " + "'rootPw77'"],
  ];
  await withClient(dir, async (c) => {
    for (const [kind, value] of fakes) {
      const before = memFiles(dir).length;
      const r = await call(c, "remember", {
        title: `배포 설정 ${kind}`,
        content: `배포에 쓰는 값: ${value}`,
        type: "semantic",
      });
      check(`${kind} 본문 차단`, r.isError, r.text.slice(0, 160));
      check(`${kind} 거부 문구에 위치 저장 안내`, /위치/.test(r.text) && /\.env/.test(r.text), r.text.slice(0, 160));
      check(`${kind} 거부 시 파일 미생성`, memFiles(dir).length === before);
      check(`${kind} 거부 문구에 값이 되풀이되지 않음`, !r.text.includes(value));
    }

    const t = await call(c, "remember", { title: "키 " + fakes[3][1], content: "제목에 키", type: "semantic" });
    check("제목의 키도 차단", t.isError, t.text.slice(0, 120));
    const d = await call(c, "remember", { title: "설명 키", description: `토큰 ${fakes[2][1]}`, content: "설명에 키", type: "semantic" });
    check("설명의 키도 차단", d.isError, d.text.slice(0, 120));

    const okCases = [
      ["키 위치", "ANTHROPIC_API_KEY 는 .env 에 있다."],
      ["키 회전", "sk- 접두 키는 분기마다 회전한다."],
      ["비밀번호 위치", "DB password 는 1Password 의 'prod-db' 항목에 있다."],
      ["AWS 키 이름", "AWS_ACCESS_KEY_ID 는 AKIA 로 시작하며 CI 비밀 변수에 둔다."],
      ["DB 비밀번호 키 이름", "DB_PASSWORD 는 .env 에 있다."],
    ];
    for (const [title, content] of okCases) {
      const r = await call(c, "remember", { title, content, type: "semantic" });
      check(`허용: "${content.slice(0, 30)}"`, !r.isError && typeof r.json?.stored?.slug === "string", r.text.slice(0, 160));
    }

    const target = "키-위치";
    const fp = memPath(dir, target);
    const orig = fs.readFileSync(fp, "utf-8");
    const rv = await call(c, "revise", { id: target, reason: "값 기록", content: `값은 ${fakes[0][1]}` });
    check("revise 본문의 키 차단", rv.isError && /위치/.test(rv.text), rv.text.slice(0, 160));
    const rt = await call(c, "revise", { id: target, reason: "제목 교체", title: fakes[1][1] });
    check("revise 제목의 키 차단", rt.isError, rt.text.slice(0, 160));
    check("revise 거부 시 원본 파일 불변", fs.readFileSync(fp, "utf-8") === orig);
  });

  const log = fs.readFileSync(path.join(dir, ".bbm-usage.jsonl"), "utf-8");
  check("사용 로그에 차단 종류 기록", /"secretBlocked"/.test(log));
  check("사용 로그에 키 값이 남지 않음", fakes.every(([, v]) => !log.includes(v.split("\n")[0].slice(-20))));
}

// ── T48 possible_contradiction
console.log("T48) possible_contradiction");
{
  const dir = freshDir("contra");
  await withClient(dir, async (c) => {
    const a = await call(c, "remember", {
      title: "개발 서버 포트",
      description: "로컬 개발 서버 포트 설정",
      content: "로컬 개발 서버 포트는 8080 이다.",
      type: "semantic",
    });
    const aSlug = a.json.stored.slug;
    const aBefore = fs.readFileSync(memPath(dir, aSlug), "utf-8");
    const b = await call(c, "remember", {
      title: "개발 서버 포트",
      description: "로컬 개발 서버 포트 설정",
      content: "로컬 개발 서버 포트는 9090 이다.",
      type: "semantic",
    });
    const pc = b.json?.possible_contradiction ?? [];
    const hitA = pc.find((x) => x.slug === aSlug);
    check("숫자 차이 → possible_contradiction 에 기존 기억", !!hitA, JSON.stringify(pc).slice(0, 200));
    check("사유에 number", hitA?.reasons?.includes("number"), JSON.stringify(hitA?.reasons));
    check("hint 가 revise/supersedes 유도", /revise/.test(b.json?.hint ?? "") && /supersedes/.test(b.json?.hint ?? ""), b.json?.hint);
    check("similar_existing_memories 도 유지", (b.json?.similar_existing_memories ?? []).some((x) => x.slug === aSlug));
    check("기존 기억 파일 불변(자동 병합 없음)", fs.readFileSync(memPath(dir, aSlug), "utf-8") === aBefore);
    check("새 기억은 별도 파일로 저장", fs.existsSync(memPath(dir, b.json.stored.slug)) && b.json.stored.slug !== aSlug);

    const v1 = await call(c, "remember", {
      title: "Node 런타임 버전",
      description: "빌드용 Node 버전",
      content: "빌드는 Node 20.11 을 쓴다.",
      type: "semantic",
    });
    const v2 = await call(c, "remember", {
      title: "Node 런타임 버전",
      description: "빌드용 Node 버전",
      content: "빌드는 Node 22.3 을 쓴다.",
      type: "semantic",
    });
    check(
      "버전 차이 → number 신호",
      (v2.json?.possible_contradiction ?? []).some((x) => x.slug === v1.json.stored.slug && x.reasons.includes("number")),
    );

    const n1 = await call(c, "remember", {
      title: "CI 빌드 캐시",
      description: "CI 빌드 캐시 정책",
      content: "CI 에서 빌드 캐시를 사용한다.",
      type: "procedural",
    });
    const n2 = await call(c, "remember", {
      title: "CI 빌드 캐시",
      description: "CI 빌드 캐시 정책",
      content: "CI 에서 빌드 캐시를 사용하지 마라.",
      type: "procedural",
    });
    const nHit = (n2.json?.possible_contradiction ?? []).find((x) => x.slug === n1.json.stored.slug);
    check("한국어 부정(하지 마) → negation 신호", nHit?.reasons?.includes("negation"), JSON.stringify(n2.json?.possible_contradiction));

    const e1 = await call(c, "remember", {
      title: "lockfile policy",
      description: "package lockfile policy",
      content: "Commit the lockfile with every dependency change.",
      type: "procedural",
    });
    const e2 = await call(c, "remember", {
      title: "lockfile policy",
      description: "package lockfile policy",
      content: "Do not commit the lockfile with dependency changes.",
      type: "procedural",
    });
    check(
      "영어 부정(do not) → negation 신호",
      (e2.json?.possible_contradiction ?? []).some((x) => x.slug === e1.json.stored.slug && x.reasons.includes("negation")),
    );

    const k1 = await call(c, "remember", {
      title: "커밋 서명 규칙",
      description: "커밋 서명 규칙",
      content: "커밋 서명은 금지된 옵션으로 우회한다.",
      type: "procedural",
    });
    const k2 = await call(c, "remember", {
      title: "커밋 서명 규칙",
      description: "커밋 서명 규칙",
      content: "커밋 서명은 옵션으로 우회한다.",
      type: "procedural",
    });
    check(
      "한국어 부정(금지) 한쪽에만 → negation 신호",
      (k2.json?.possible_contradiction ?? []).some((x) => x.slug === k1.json.stored.slug && x.reasons.includes("negation")),
    );

    const d1 = await call(c, "remember", {
      title: "로그 저장 위치",
      description: "애플리케이션 로그 저장 위치",
      content: "로그는 logs 폴더에 쌓인다.",
      type: "semantic",
    });
    const d2 = await call(c, "remember", {
      title: "로그 저장 위치",
      description: "애플리케이션 로그 저장 위치",
      content: "로그는 logs 폴더에 쌓인다.",
      type: "semantic",
    });
    check("단순 중복은 possible_contradiction 없음", d2.json?.possible_contradiction === undefined, JSON.stringify(d2.json?.possible_contradiction));
    check("단순 중복은 similar_existing_memories 로 안내", (d2.json?.similar_existing_memories ?? []).some((x) => x.slug === d1.json.stored.slug));

    const p1 = await call(c, "remember", {
      title: "스테이징 서버 포트",
      description: "스테이징 서버 포트 설정",
      content: "스테이징 서버 포트는 8443 이다.",
      type: "semantic",
    });
    const p2 = await call(c, "remember", {
      title: "스테이징 서버 포트",
      description: "스테이징 서버 포트 설정",
      content: "스테이징 서버 포트는 8443 이다. 2026-09-28 확인.",
      type: "semantic",
    });
    check(
      "날짜만 더한 중복은 possible_contradiction 없음",
      !(p2.json?.possible_contradiction ?? []).some((x) => x.slug === p1.json.stored.slug),
      JSON.stringify(p2.json?.possible_contradiction),
    );
    check("날짜만 더한 중복도 similar_existing_memories 로 안내", (p2.json?.similar_existing_memories ?? []).some((x) => x.slug === p1.json.stored.slug));

    const q1 = await call(c, "remember", {
      title: "워커 재시작 정책",
      description: "워커 재시작 정책",
      content: "워커는 실패하면 재시작한다. 제한 5회.",
      type: "procedural",
    });
    const q2 = await call(c, "remember", {
      title: "워커 재시작 정책",
      description: "워커 재시작 정책",
      content: "워커는 실패하면 재시작한다. 제한 5회, 간격 30초.",
      type: "procedural",
    });
    check(
      "숫자를 더 담은(부분집합) 중복은 number 신호 없음",
      !(q2.json?.possible_contradiction ?? []).some((x) => x.slug === q1.json.stored.slug && x.reasons.includes("number")),
      JSON.stringify(q2.json?.possible_contradiction),
    );

    const s = await call(c, "remember", {
      title: "개발 서버 포트",
      description: "로컬 개발 서버 포트 설정",
      content: "로컬 개발 서버 포트는 7070 이다.",
      type: "semantic",
      supersedes: aSlug,
    });
    check(
      "supersedes 대상은 possible_contradiction 에서 제외",
      !(s.json?.possible_contradiction ?? []).some((x) => x.slug === aSlug),
      JSON.stringify(s.json?.possible_contradiction),
    );
  });
}

// ── T49 review_after + 타입별 낡음 임계
console.log("T49) review_after · 타입별 낡음 임계");
{
  const dir = freshDir("review");
  const yesterday = localDate(-1);
  const tomorrow = localDate(1);
  await withClient(dir, async (c) => {
    const past = await call(c, "remember", { title: "검토일 지남", content: "검토일 시험 A", type: "preference", review_after: yesterday });
    check("review_after 지남 → 0일 기억에도 stale_hint", typeof past.json?.stored?.stale_hint === "string", past.text.slice(0, 200));
    check("stale_hint 에 검토일과 대조 지시", /검토일/.test(past.json?.stored?.stale_hint ?? "") && /대조/.test(past.json?.stored?.stale_hint ?? ""));
    check("응답에 review_after 노출", past.json?.stored?.review_after === yesterday);
    check("파일 frontmatter 에 review_after 저장", new RegExp(`review_after: ['"]?${yesterday}`).test(fs.readFileSync(memPath(dir, past.json.stored.slug), "utf-8")));

    const fut = await call(c, "remember", { title: "검토일 남음", content: "검토일 시험 B", type: "episodic", review_after: tomorrow });
    check("review_after 미래 → stale_hint 없음", !fut.isError && fut.json?.stored?.stale_hint === undefined, fut.text.slice(0, 200));

    const today = await call(c, "remember", { title: "검토일 오늘", content: "검토일 시험 C", type: "episodic", review_after: localDate(0) });
    check("review_after 오늘 → 아직 stale_hint 없음", today.json?.stored?.stale_hint === undefined);

    const bad = await call(c, "remember", { title: "검토일 형식", content: "검토일 시험 D", type: "semantic", review_after: "2026/10/01" });
    check("잘못된 review_after 형식 거부", bad.isError, bad.text.slice(0, 160));

    const cleared = await call(c, "revise", { id: past.json.stored.slug, reason: "검토 완료", review_after: "" });
    check("revise review_after \"\" → 해제", !cleared.isError && cleared.json?.revised?.review_after === undefined, cleared.text.slice(0, 200));
    check("해제 후 파일에 review_after 없음", !/review_after:/.test(fs.readFileSync(memPath(dir, past.json.stored.slug), "utf-8")));
    check("해제 후 stale_hint 없음", cleared.json?.revised?.stale_hint === undefined);

    const set = await call(c, "revise", { id: fut.json.stored.slug, reason: "검토일 앞당김", review_after: yesterday });
    check("revise 로 review_after 설정 → stale_hint", set.json?.revised?.review_after === yesterday && typeof set.json?.revised?.stale_hint === "string");
  });

  // 타입별 경계 — updated 를 되감은 뒤 새 서버로 읽는다
  const cases = [
    ["episodic", 13, false],
    ["episodic", 14, true],
    ["semantic", 59, false],
    ["semantic", 60, true],
    ["procedural", 59, false],
    ["procedural", 60, true],
    ["preference", 179, false],
    ["preference", 180, true],
  ];
  const s = new MemoryStore(new Vault(dir));
  const slugs = cases.map(([type, days]) => {
    const slug = s.remember({ title: `경계 ${type} ${days}`, content: `경계 시험 ${type} ${days}일`, type, slug: `edge-${type}-${days}` }).record.slug;
    return slug;
  });
  const ep20 = s.remember({ title: "덮어쓰기 에피소드", content: "덮어쓰기 시험", type: "episodic", slug: "override-episodic-20" }).record.slug;
  const se20 = s.remember({ title: "덮어쓰기 의미", content: "덮어쓰기 시험 의미", type: "semantic", slug: "override-semantic-20" }).record.slug;
  cases.forEach(([, days], i) => rewind(dir, slugs[i], days));
  rewind(dir, ep20, 20);
  rewind(dir, se20, 20);

  // 따옴표 없는 YAML 날짜로 손편집된 검토일
  const hand = s.remember({ title: "손편집 검토일", content: "손편집 시험", type: "preference", slug: "hand-review" }).record.slug;
  {
    const fp = memPath(dir, hand);
    fs.writeFileSync(fp, fs.readFileSync(fp, "utf-8").replace(/^status: /m, "review_after: 2020-01-15\nstatus: "), "utf-8");
  }
  check("따옴표 없는 YAML 날짜를 YYYY-MM-DD 로 읽음", new Vault(dir).read(hand)?.reviewAfter === "2020-01-15", String(new Vault(dir).read(hand)?.reviewAfter));

  await withClient(dir, async (c) => {
    for (let i = 0; i < cases.length; i++) {
      const [type, days, stale] = cases[i];
      const r = await call(c, "read_memory", { id: slugs[i] });
      check(
        `${type} ${days}일 → stale_hint ${stale ? "있음" : "없음"}`,
        (typeof r.json?.stale_hint === "string") === stale && r.json?.age_days === days,
        `age=${r.json?.age_days} hint=${r.json?.stale_hint}`,
      );
    }
    const ep = await call(c, "read_memory", { id: ep20 });
    check("기본값: episodic 20일 → stale_hint", typeof ep.json?.stale_hint === "string");
    const h = await call(c, "read_memory", { id: hand });
    check("손편집 review_after(과거) → stale_hint", /검토일/.test(h.json?.stale_hint ?? ""), h.json?.stale_hint);
  });
  await withClient(
    dir,
    async (c) => {
      const ep = await call(c, "read_memory", { id: ep20 });
      check("BIGBRAIN_STALE_DAYS=365 → episodic 20일 stale_hint 없음", ep.json?.stale_hint === undefined, ep.json?.stale_hint);
      const pf = await call(c, "read_memory", { id: slugs[7] });
      check("BIGBRAIN_STALE_DAYS=365 → preference 180일 stale_hint 없음", pf.json?.stale_hint === undefined);
      const h = await call(c, "read_memory", { id: hand });
      check("BIGBRAIN_STALE_DAYS=365 여도 review_after 지남은 stale_hint", typeof h.json?.stale_hint === "string");
    },
    { BIGBRAIN_STALE_DAYS: "365" },
  );
  await withClient(
    dir,
    async (c) => {
      const se = await call(c, "read_memory", { id: se20 });
      check("BIGBRAIN_STALE_DAYS=10 → semantic 20일 stale_hint", typeof se.json?.stale_hint === "string");
    },
    { BIGBRAIN_STALE_DAYS: "10" },
  );

  // SessionStart 인덱스 채널
  new MemoryStore(new Vault(dir)).regenerateIndex();
  const md = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf-8");
  const line = (slug) => md.split("\n").find((l) => l.includes(`memories/${slug}|`)) ?? "";
  cases.forEach(([type, days, stale], i) => {
    check(`인덱스: ${type} ${days}일 → 대조 필요 ${stale ? "있음" : "없음"}`, /대조 필요/.test(line(slugs[i])) === stale, line(slugs[i]));
  });
  check("인덱스: review_after 지남 → 대조 필요", /대조 필요/.test(line(hand)), line(hand));

  const script =
    `const {Vault}=await import(${JSON.stringify(distUrl("vault.js"))});` +
    `const {MemoryStore}=await import(${JSON.stringify(distUrl("store.js"))});` +
    `new MemoryStore(new Vault(${JSON.stringify(dir)})).regenerateIndex();`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf-8",
    timeout: 15000,
    env: { ...process.env, BIGBRAIN_STALE_DAYS: "365" },
  });
  const md365 = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf-8");
  const line365 = (slug) => md365.split("\n").find((l) => l.includes(`memories/${slug}|`)) ?? "";
  check("인덱스: BIGBRAIN_STALE_DAYS=365 → episodic 20일 대조 필요 없음", !/대조 필요/.test(line365(ep20)), line365(ep20));
  check("인덱스: BIGBRAIN_STALE_DAYS=365 여도 review_after 지남은 대조 필요", /대조 필요/.test(line365(hand)), line365(hand));
}

// ── T50 긴 본문 경고
console.log("T50) 긴 본문 경고");
{
  const dir = freshDir("long");
  await withClient(dir, async (c) => {
    const at = await call(c, "remember", { title: "정확히 기준 길이", content: "가".repeat(1500), type: "semantic" });
    check("1,500자 → 저장 성공, 경고 없음", !at.isError && !/사실 단위/.test(at.json?.hint ?? ""), at.json?.hint);
    const over = await call(c, "remember", { title: "기준 초과 길이", content: "나".repeat(1501), type: "semantic" });
    check("1,501자 → 저장 성공", !over.isError && fs.existsSync(memPath(dir, over.json?.stored?.slug ?? "-")));
    check("1,501자 → 사실 단위로 나누라는 경고", /사실 단위/.test(over.json?.hint ?? "") && /1501자/.test(over.json?.hint ?? ""), over.json?.hint);
    const rv = await call(c, "revise", { id: at.json.stored.slug, reason: "본문 확장", content: "다".repeat(1600) });
    check("revise 1,600자 → 성공 + 경고", !rv.isError && /사실 단위/.test(rv.json?.hint ?? ""), rv.text.slice(0, 200));
    const rs = await call(c, "revise", { id: at.json.stored.slug, reason: "본문 축소", content: "라".repeat(100) });
    check("revise 짧은 본문 → 경고 없음", !rs.isError && rs.json?.hint === undefined);
  });
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n통과 ${passes}건 / 실패 ${failures}건`);
if (failures > 0) process.exit(1);
console.log("기억 품질 가드 회귀 시험 통과 ✔");
