// T14 회귀 테스트 — 확장 간격(expanding spacing).
//
// 고정하는 버그(감사 C3):
//   간격 게이트가 "마지막 강화 후 고정 10분" 단일 기준이라 11분 주기로 기계적으로
//   recall 하면 회당 +1 씩 상한 없이 부풀릴 수 있었다(실측 30회 → 저장강도 1→31).
//   저장강도는 감소 경로가 없어 값이 영구히 남고, 하루 144회면 n=145 가 되어
//   그 기억은 reflect 의 weakened 에서 수십 년간 면제된다.
//   간격효과 이론이 요구하는 것은 간격의 **확대**이지 고정 rate limit 이 아니다.
//
// 라이브 볼트는 건드리지 않는다 — 전부 os.tmpdir() 임시 볼트.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const testTmp = path.resolve(process.env.BBM_TEST_TMPDIR ?? os.tmpdir());
fs.mkdirSync(testTmp, { recursive: true });
const distUrl = (f) => `file://${path.join(root, "dist", f).replace(/\\/g, "/")}`;
const { Vault } = await import(distUrl("vault.js"));
const { MemoryStore } = await import(distUrl("store.js"));

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name} ${detail}`);
  }
}

const cleanups = /** @type {string[]} */ (Array());
function freshDir() {
  const d = fs.mkdtempSync(path.join(testTmp, "bbm-space-"));
  cleanups.push(d);
  return d;
}
const memPath = (dir, slug) => path.join(dir, "memories", `${slug}.md`);
const strengthOf = (dir, slug) => {
  const match = /storage_strength: ([\d.]+)/.exec(fs.readFileSync(memPath(dir, slug), "utf-8"));
  if (!match) throw new Error("storage_strength 필드가 없습니다");
  return Number(match[1]);
};
/** last_reinforced 를 n분 전으로 되감아 "그만큼 기다린" 상태를 만든다 */
function waited(dir, slug, minutes) {
  const fp = memPath(dir, slug);
  const iso = new Date(Date.now() - minutes * 60_000).toISOString();
  fs.writeFileSync(fp, fs.readFileSync(fp, "utf-8").replace(/last_reinforced: .*/, `last_reinforced: '${iso}'`), "utf-8");
}
/** created 를 n시간 전으로 되감는다 */
function aged(dir, slug, hours) {
  const fp = memPath(dir, slug);
  const iso = new Date(Date.now() - hours * 3_600_000).toISOString();
  fs.writeFileSync(fp, fs.readFileSync(fp, "utf-8").replace(/created: .*/, `created: '${iso}'`), "utf-8");
}

// ── 1. 11분 주기 기계적 반복이 더 이상 무한 부풀리지 못한다
console.log("1) 11분 주기 벼락치기 차단 (C3)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "부풀리기 대상", content: "오스카 파파 본문.", type: "semantic" });
  aged(dir, "부풀리기-대상", 24); // 하루 된 기억

  // 감사 재현: 11분 간격 recall 30회
  for (let i = 0; i < 30; i++) {
    waited(dir, "부풀리기-대상", 11);
    new MemoryStore(new Vault(dir)).search("오스카");
  }
  const n = strengthOf(dir, "부풀리기-대상");
  // 하루 된 기억의 필요 간격은 α·24h/1 = 2.4시간이므로 11분 주기는 전부 막힌다.
  // 이것이 의도된 결과다 — 벼락치기는 저장강도를 올리지 못한다.
  check("종전 1→31 이던 부풀리기가 완전 차단", n === 1, `strength=${n}`);
  console.log(`    저장강도 실측: 1 → ${n} (종전 31)`);

  // 다만 영구 잠금은 아니다 — 요구되는 간격만큼 실제로 기다리면 열린다
  waited(dir, "부풀리기-대상", 3 * 60);
  new MemoryStore(new Vault(dir)).search("오스카");
  check("필요 간격(2.4h)을 채우면 정상 강화 — 영구 잠금 아님", strengthOf(dir, "부풀리기-대상") > 1, `strength=${strengthOf(dir, "부풀리기-대상")}`);
}

// ── 2. 필요 간격이 n 에 따라 실제로 늘어난다
console.log("2) 간격이 강도에 따라 확대");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "간격 확대 확인", content: "퀘벡 로미오 본문.", type: "semantic" });
  aged(dir, "간격-확대-확인", 240); // 10일 된 기억 → α·240h/n = 24h/n

  // n=1: 필요 간격 24시간 → 1시간 대기로는 안 열린다
  waited(dir, "간격-확대-확인", 60);
  new MemoryStore(new Vault(dir)).search("퀘벡");
  check("n=1·1시간 대기로는 게이트가 안 열림", strengthOf(dir, "간격-확대-확인") === 1, `strength=${strengthOf(dir, "간격-확대-확인")}`);

  // 25시간 대기 → 열린다
  waited(dir, "간격-확대-확인", 25 * 60);
  new MemoryStore(new Vault(dir)).search("퀘벡");
  const after = strengthOf(dir, "간격-확대-확인");
  check("충분히 기다리면 열림", after > 1, `strength=${after}`);
}

// ── 3. 신생 기억에는 기본 창(10분)이 그대로 적용된다 (하한 보장)
console.log("3) 신생 기억은 기본 창 유지");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "신생 간격", content: "시에라 본문.", type: "semantic" });
  // 갓 만든 기억 → α·나이/n 이 0 에 가까우므로 기본 10분 창이 하한으로 작동
  waited(dir, "신생-간격", 11);
  new MemoryStore(new Vault(dir)).search("시에라");
  check("11분 대기로 강화됨 (기본 창 하한)", strengthOf(dir, "신생-간격") > 1, `strength=${strengthOf(dir, "신생-간격")}`);
}

// ── 4. α=0 이면 종전 고정 창 동작
console.log("4) BIGBRAIN_SPACING_ALPHA=0 로 종전 동작 복원");
{
  const prev = process.env.BIGBRAIN_SPACING_ALPHA;
  process.env.BIGBRAIN_SPACING_ALPHA = "0";
  try {
    const { MemoryStore: Fresh } = await import(`${distUrl("store.js")}?alpha=0`);
    const dir = freshDir();
    const s = new Fresh(new Vault(dir));
    s.remember({ title: "알파 제로", content: "탱고 본문.", type: "semantic" });
    aged(dir, "알파-제로", 240);
    for (let i = 0; i < 5; i++) {
      waited(dir, "알파-제로", 11);
      new Fresh(new Vault(dir)).search("탱고");
    }
    const n = strengthOf(dir, "알파-제로");
    check("α=0 이면 11분 주기로 매번 강화 (종전 동작)", n >= 5, `strength=${n}`);
  } finally {
    if (prev === undefined) delete process.env.BIGBRAIN_SPACING_ALPHA;
    else process.env.BIGBRAIN_SPACING_ALPHA = prev;
  }
}

// ── 5. 정상적인 간격 둔 사용은 계속 강화된다 (P3 취지 보존)
console.log("5) 정상 사용은 정상 강화");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "정상 사용", content: "위스키 본문.", type: "semantic" });
  // 하루에 한 번 쓰는 패턴을 5일치 모사 (나이도 함께 늘린다)
  for (let day = 1; day <= 5; day++) {
    aged(dir, "정상-사용", day * 24);
    waited(dir, "정상-사용", 24 * 60);
    new MemoryStore(new Vault(dir)).search("위스키");
  }
  const n = strengthOf(dir, "정상-사용");
  check("매일 쓰면 꾸준히 강화됨", n >= 4, `strength=${n}`);
}

// ── 6. RIF 로 억제된 경쟁자는 강화되지 않는다 (T18/C5)
console.log("6) 억제된 경쟁자 강화 제외 (C5)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "타입스크립트 strict 모드 선호", description: "코드 리뷰에서 strict true 를 요구함", content: "본문 A.", type: "preference" });
  s.remember({ title: "타입스크립트 strict 모드 선호함", description: "코드 리뷰에서 strict true 를 요구함", content: "본문 B.", type: "preference" });
  for (const slug of ["타입스크립트-strict-모드-선호", "타입스크립트-strict-모드-선호함"]) {
    aged(dir, slug, 24);
    waited(dir, slug, 5 * 60);
  }
  const before = ["타입스크립트-strict-모드-선호", "타입스크립트-strict-모드-선호함"].map((x) => strengthOf(dir, x));

  const q = new MemoryStore(new Vault(dir));
  const r = q.search("타입스크립트 strict");
  const inhibited = r.filter((x) => x.inhibited).map((x) => x.record.slug);
  check("근접 중복 한쪽이 RIF 로 억제됨(전제 확인)", inhibited.length === 1, inhibited.join(","));

  const after = ["타입스크립트-strict-모드-선호", "타입스크립트-strict-모드-선호함"].map((x) => strengthOf(dir, x));
  const winner = r.find((x) => !x.inhibited).record.slug;
  const loser = inhibited[0];
  check("승자는 강화됨", strengthOf(dir, winner) > before[0], `${before} → ${after}`);
  check("억제된 경쟁자는 강화되지 않음 (종전 동률 적립)", strengthOf(dir, loser) === 1, `loser=${strengthOf(dir, loser)}`);
}

// ── 7. 연상 이웃은 강화되지 않는다 (T18/C5)
console.log("7) 연상 이웃 강화 제외 (C5)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "허브 노트", description: "중심 문서", content: "빅터 본문.", type: "semantic" });
  s.remember({ title: "이웃 노트", description: "연결된 문서", content: "무관 본문.", type: "semantic" });
  s.link("허브-노트", "이웃-노트", "연결");
  for (const slug of ["허브-노트", "이웃-노트"]) {
    aged(dir, slug, 24);
    waited(dir, slug, 5 * 60);
  }

  const r = new MemoryStore(new Vault(dir)).search("빅터");
  check("연상으로 이웃이 딸려옴(전제 확인)", r.some((x) => x.snippet.startsWith("(연상")), r.map((x) => x.record.slug).join(","));
  check("허브는 강화됨", strengthOf(dir, "허브-노트") > 1, `hub=${strengthOf(dir, "허브-노트")}`);
  check("연상 이웃은 강화되지 않음 (종전 +0.5)", strengthOf(dir, "이웃-노트") === 1, `neighbor=${strengthOf(dir, "이웃-노트")}`);
}

// ── 8. revise 가 간격 게이트를 우회하지 않는다 (T18/C6)
console.log("8) revise 간격 게이트 준수 (C6)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  const rec = s.remember({ title: "연속 교정 대상", description: "설명", content: "1차 본문.", type: "semantic" }).record;
  aged(dir, rec.slug, 240); // 10일 된 기억 → 필요 간격 24시간

  const s2 = new MemoryStore(new Vault(dir));
  s2.revise(rec.slug, { reason: "1차", content: "2차 본문." });
  s2.revise(rec.slug, { reason: "2차", content: "3차 본문." });
  check("몇 초 안 연속 revise 로 부풀지 않음 (종전 1→3)", strengthOf(dir, rec.slug) <= 2, `strength=${strengthOf(dir, rec.slug)}`);
  check("교정 내용 자체는 반영됨", fs.readFileSync(memPath(dir, rec.slug), "utf-8").includes("3차 본문"));

  // 순수 메타데이터 편집은 강화 대상이 아니다
  const beforeMeta = strengthOf(dir, rec.slug);
  waited(dir, rec.slug, 48 * 60); // 간격은 충분히 벌린다
  s2.revise(rec.slug, { reason: "태그만 변경", tags: ["새태그"] });
  check("태그만 바꾸는 편집은 강화하지 않음", strengthOf(dir, rec.slug) === beforeMeta, `${beforeMeta} → ${strengthOf(dir, rec.slug)}`);
}

// ── 9. reflect 가 "확신도 높아 제외된" 건수를 노출한다 (T18/C6)
console.log("9) 확신도 게이트로 제외된 건수 노출 (C6)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  for (let i = 0; i < 10; i++) {
    s.remember({ title: `줄루 기억 ${i}`, description: `설명 ${i}`, content: `본문 ${i}.`, type: "semantic", confidence: 0.9 });
  }
  // created 뿐 아니라 last_reinforced 도 되감아야 실제로 "방치된" 상태가 된다
  // (T12 이후 활성은 마지막 강화 시점을 반영하므로, created 만 옮기면 활성이 높게 나온다)
  for (let i = 0; i < 10; i++) {
    aged(dir, `줄루-기억-${i}`, 8760);
    waited(dir, `줄루-기억-${i}`, 8760 * 60);
  }

  const rep = new MemoryStore(new Vault(dir)).reflect();
  check("망각 후보는 0건 (확신도 0.9)", rep.forgetCandidates.length === 0);
  check("제외된 건수가 노출됨", rep.trustedButFaded > 0, `trustedButFaded=${rep.trustedButFaded}`);
}

// ── 10. 고정 시계로 read 직후 recall 게이트를 재현한다
console.log("10) 고정 시계 read → recall 게이트 재현");
{
  const dir = freshDir();
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const s = new MemoryStore(new Vault(dir), undefined, () => now);
  const rec = s.remember({ title: "고정 시계 기억", content: "엑스레이 본문.", type: "semantic" }).record;
  now += 24 * 3_600_000;
  s.read(rec.slug);
  const afterRead = s.resolve(rec.slug).record.storageStrength;
  s.search("엑스레이");
  const afterRecall = s.resolve(rec.slug).record.storageStrength;
  check("test_spacing_clock_reproduces_read_then_recall_gate", afterRecall === afterRead, `${afterRead} → ${afterRecall}`);
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT14/T18 간격·강화 정밀화 회귀 테스트 통과 ✔");
