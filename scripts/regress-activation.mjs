// T12 회귀 테스트 — 기저활성의 최근성 반영.
//
// 고정하는 버그(감사 C1):
//   활성 계산이 now − created 에만 의존해, created 와 n 이 같으면
//   "어제 강화한 기억" 과 "1년 방치한 기억" 의 활성이 완전히 동일했다(둘 다 −2.2364).
//   그 결과 어제 5회 쓴 핵심 기억(키워드 9점)이 몇 초 전 저장한 잡메모(키워드 6점)에
//   5.75 vs 7.68 로 밀렸고, reflect 는 방금 접근한 기억도 weakened 로 오분류했다.
//   도구 설명의 "frequency+recency" 중 recency 는 미구현이었다.
//
// 라이브 볼트는 건드리지 않는다 — 전부 os.tmpdir() 임시 볼트.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 시험 기본값을 사용자 환경 설정과 격리한다.
for (const key of Object.keys(process.env)) {
  if (/^(?:ASTRONRAG_|BIGBRAIN_|BBM_)/.test(key) && !key.startsWith("ASTRONRAG_TEST_")) delete process.env[key];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
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
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

const cleanups = /** @type {string[]} */ (Array());
function freshDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-act-"));
  cleanups.push(d);
  return d;
}
const memPath = (dir, slug) => path.join(dir, "memories", `${slug}.md`);

/** frontmatter 를 직접 조정해 원하는 나이·강도·마지막강화 상태를 만든다 */
function shape(dir, slug, { agoHours, strength, reinforcedAgoHours }) {
  const fp = memPath(dir, slug);
  const iso = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
  let t = fs.readFileSync(fp, "utf-8");
  t = t.replace(/created: .*/, `created: '${iso(agoHours)}'`);
  t = t.replace(/updated: .*/, `updated: '${iso(reinforcedAgoHours)}'`);
  t = t.replace(/last_reinforced: .*/, `last_reinforced: '${iso(reinforcedAgoHours)}'`);
  t = t.replace(/storage_strength: .*/, `storage_strength: ${strength}`);
  fs.writeFileSync(fp, t, "utf-8");
}

const YEAR_H = 8760;

// ── 1. 감사 실측 시나리오 — 최근성이 활성에 반영된다
console.log("1) 최근 강화 vs 장기 방치 (C1 핵심)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "최근 강화 기억", content: "알파 델타 자주 쓰는 기억.", type: "semantic" });
  s.remember({ title: "장기 방치 기억", content: "알파 에코 안 쓰는 기억.", type: "semantic" });
  // 둘 다 1년 전 생성 · n=5 · 마지막 강화만 다르게 (어제 vs 1년 전)
  shape(dir, "최근-강화-기억", { agoHours: YEAR_H, strength: 5, reinforcedAgoHours: 24 });
  shape(dir, "장기-방치-기억", { agoHours: YEAR_H, strength: 5, reinforcedAgoHours: YEAR_H });

  const r = new MemoryStore(new Vault(dir)).search("알파");
  const fresh = r.find((x) => x.record.slug === "최근-강화-기억");
  const stale = r.find((x) => x.record.slug === "장기-방치-기억");
  check("두 기억 모두 회상됨(전제 확인)", !!fresh && !!stale);
  check("활성이 더 이상 동일하지 않음", fresh.activation !== stale.activation, `${fresh?.activation} vs ${stale?.activation}`);
  check("최근 강화 쪽 활성이 더 높음", fresh.activation > stale.activation, `${fresh?.activation} vs ${stale?.activation}`);
  check("감사 산출값 −1.24 근사", near(fresh.activation, -1.24, 0.03), `act=${fresh?.activation}`);
  check("감사 산출값 −2.34 근사", near(stale.activation, -2.34, 0.03), `act=${stale?.activation}`);
  check("격차가 정확식 방향(약 1.1)과 일치", near(fresh.activation - stale.activation, 1.1, 0.05), `Δ=${fresh?.activation - stale?.activation}`);
  check("최근 강화 쪽이 순위도 위", r.indexOf(fresh) < r.indexOf(stale));
}

// ── 2. 자주 쓰는 구기억이 방금 저장한 잡메모에 밀리지 않는다
console.log("2) 랭킹 역전 해소 (C1 실사용 영향)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  // 핵심 기억: 제목·설명·본문에 모두 키워드 → 키워드 점수 우위
  s.remember({ title: "브라보 배포 절차", description: "브라보 배포 방법", content: "브라보 배포 브라보 절차 상세.", type: "procedural" });
  // 잡메모: 본문에만 스침
  s.remember({ title: "오늘 메모", description: "잡생각", content: "브라보 관련 잡메모.", type: "episodic" });
  shape(dir, "브라보-배포-절차", { agoHours: 30 * 24, strength: 5, reinforcedAgoHours: 24 });

  const r = new MemoryStore(new Vault(dir)).search("브라보");
  const core = r.find((x) => x.record.slug === "브라보-배포-절차");
  const junk = r.find((x) => x.record.slug === "오늘-메모");
  check("둘 다 회상됨(전제 확인)", !!core && !!junk);
  check("어제 쓴 핵심 기억이 방금 만든 잡메모보다 상위", core.score > junk.score, `core=${core?.score} junk=${junk?.score}`);
}

// ── 3. reflect 가 최근 강화된 기억을 weakened 로 오분류하지 않는다
console.log("3) reflect 오분류 해소");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "어제 쓴 기억", content: "폭스트롯 최근 사용.", type: "semantic" });
  s.remember({ title: "진짜 방치 기억", content: "골프 오래 방치.", type: "semantic" });
  shape(dir, "어제-쓴-기억", { agoHours: YEAR_H, strength: 6, reinforcedAgoHours: 20 });
  shape(dir, "진짜-방치-기억", { agoHours: YEAR_H, strength: 6, reinforcedAgoHours: YEAR_H });

  const s2 = new MemoryStore(new Vault(dir));
  const weak = s2.reflect().weakened.map((w) => w.slug);
  check("어제 쓴 기억은 weakened 아님", !weak.includes("어제-쓴-기억"), weak.join(","));
  // 분류기 자체(방치 기억 탐지)는 8절에서 실볼트 크기로 검증한다 —
  // 여기서는 C1 고유 성질만 본다: 최근성이 활성 순서를 만든다.
  const acts = Object.fromEntries(s2.search("폭스트롯").concat(s2.search("골프")).map((r) => [r.record.slug, r.activation]));
  check("어제 쓴 기억의 활성이 방치 기억보다 높음", acts["어제-쓴-기억"] > acts["진짜-방치-기억"], JSON.stringify(acts));
}

// ── 4. P4 '바람직한 어려움' 보너스가 최근 강화 기억에는 안 붙는다 (C4 자동 해소)
console.log("4) 어려움 보너스 오발동 해소 (C4)");
{
  function deltaAfterSearch(shapeOpts) {
    const dir = freshDir();
    const s = new MemoryStore(new Vault(dir));
    s.remember({ title: "호텔 보너스 대상", content: "호텔 인디아 본문.", type: "semantic" });
    shape(dir, "호텔-보너스-대상", shapeOpts);
    const beforeMatch = /storage_strength: ([\d.]+)/.exec(fs.readFileSync(memPath(dir, "호텔-보너스-대상"), "utf-8"));
    if (beforeMatch === null) throw new Error("검색 전 storage_strength 필드 없음");
    const before = Number(beforeMatch[1]);
    new MemoryStore(new Vault(dir)).search("호텔");
    const afterMatch = /storage_strength: ([\d.]+)/.exec(fs.readFileSync(memPath(dir, "호텔-보너스-대상"), "utf-8"));
    if (afterMatch === null) throw new Error("검색 후 storage_strength 필드 없음");
    const after = Number(afterMatch[1]);
    return after - before;
  }
  // 핵심: 마지막 강화가 최근이면 활성이 높아 "어렵게 찾은 회상" 이 아니다.
  // 종전에는 감쇠 시계가 created 고정이라 최근성이 판정에 전혀 반영되지 않았다(C4).
  // 두 시나리오 모두 확장 간격 게이트(T14)는 열려 있도록 잡았다 — 그래야 delta 를 관측할 수 있다.
  const recent = deltaAfterSearch({ agoHours: 24, strength: 10, reinforcedAgoHours: 20 / 60 });
  const stale = deltaAfterSearch({ agoHours: YEAR_H, strength: 5, reinforcedAgoHours: YEAR_H });
  check("최근 강화 기억은 delta 1 (보너스 미발동)", recent === 1, `delta=${recent}`);
  check("장기 방치 기억은 delta 1.5 (보너스 발동)", stale === 1.5, `delta=${stale}`);
  check("최근성에 따라 판정이 갈림 (C4 해소)", recent !== stale, `${recent} vs ${stale}`);
}

// ── 5. n=1 은 정확식과 일치한다
console.log("5) n=1 정확식 일치");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "줄리엣 신규", content: "줄리엣 갓 만든 기억.", type: "semantic" });
  shape(dir, "줄리엣-신규", { agoHours: 100, strength: 1, reinforcedAgoHours: 100 });
  const r = new MemoryStore(new Vault(dir)).search("줄리엣");
  const exact = -0.5 * Math.log(100); // B = ln(t^-0.5) = -0.5 ln t
  check("n=1 활성이 정확식 −0.5·ln(t) 와 일치", near(r[0].activation, exact, 0.01), `got=${r[0]?.activation} exact=${exact.toFixed(4)}`);
}

// ── 6. 강화하면 활성이 즉시 올라간다 (기능 보존)
console.log("6) 강화 → 활성 상승");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  s.remember({ title: "킬로 상승 확인", content: "킬로 본문.", type: "semantic" });
  shape(dir, "킬로-상승-확인", { agoHours: YEAR_H, strength: 3, reinforcedAgoHours: YEAR_H });
  const before = new MemoryStore(new Vault(dir)).search("킬로")[0].activation;
  // 위 search 가 간격 게이트를 통과해 강화했으므로 lastReinforced 가 방금으로 갱신됨
  const after = new MemoryStore(new Vault(dir)).search("킬로")[0].activation;
  check("강화 직후 활성이 상승", after > before, `${before} → ${after}`);
}

// ── 7. 신생 볼트가 통째로 weakened 로 뜨지 않는다 (T13/C2)
console.log("7) 신생 볼트 weakened 노이즈 해소 (C2)");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  for (let i = 0; i < 3; i++) s.remember({ title: `신생 기억 ${i}`, content: `리마 ${i} 본문.`, type: "semantic" });
  // 감사 재현 조건: 저장만 하고 17h / 24h / 3일 지난 상태
  shape(dir, "신생-기억-0", { agoHours: 17, strength: 1, reinforcedAgoHours: 17 });
  shape(dir, "신생-기억-1", { agoHours: 24, strength: 1, reinforcedAgoHours: 24 });
  shape(dir, "신생-기억-2", { agoHours: 72, strength: 1, reinforcedAgoHours: 72 });

  const rep = new MemoryStore(new Vault(dir)).reflect();
  check("종전 3/3 전원 등재 → 이제 0건", rep.weakened.length === 0, rep.weakened.map((w) => w.slug).join(","));
  check("망각 후보도 0건", rep.forgetCandidates.length === 0);
  check("카운트는 정상 집계", rep.counts.total === 3);
}

// ── 8. 진짜 방치된 기억은 여전히 잡는다 (기능 보존)
console.log("8) 장기 방치는 계속 탐지");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  for (let i = 0; i < 10; i++) s.remember({ title: `마이크 기억 ${i}`, content: `마이크 ${i} 본문.`, type: "semantic" });
  // 8건은 최근 강화, 2건만 1년 방치
  for (let i = 0; i < 8; i++) shape(dir, `마이크-기억-${i}`, { agoHours: YEAR_H, strength: 4, reinforcedAgoHours: 2 });
  shape(dir, "마이크-기억-8", { agoHours: YEAR_H, strength: 1, reinforcedAgoHours: YEAR_H });
  shape(dir, "마이크-기억-9", { agoHours: YEAR_H, strength: 1, reinforcedAgoHours: YEAR_H });

  const rep = new MemoryStore(new Vault(dir)).reflect();
  const weak = rep.weakened.map((w) => w.slug);
  check("방치된 2건이 weakened 로 잡힘", weak.includes("마이크-기억-8") && weak.includes("마이크-기억-9"), weak.join(","));
  check("최근 쓰는 8건은 제외", !weak.some((w) => /마이크-기억-[0-7]$/.test(w)), weak.join(","));
  check("하위 20% 상한(=2건) 준수", rep.weakened.length <= 2, `len=${rep.weakened.length}`);
  check("활성 낮은 순 정렬", rep.weakened.every((w, i, a) => i === 0 || a[i - 1].activation <= w.activation));
}

// ── 9. 유예기간·분위 환경변수
console.log("9) 임계 환경변수 조정");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  for (let i = 0; i < 5; i++) s.remember({ title: `노벰버 ${i}`, content: `노벰버 ${i} 본문.`, type: "semantic" });
  for (let i = 0; i < 5; i++) shape(dir, `노벰버-${i}`, { agoHours: 20, strength: 1, reinforcedAgoHours: 20 });

  const prevG = process.env.ASTRONRAG_WEAKENED_GRACE_H;
  const prevR = process.env.ASTRONRAG_WEAKENED_RATIO;
  try {
    process.env.ASTRONRAG_WEAKENED_GRACE_H = "0";
    process.env.ASTRONRAG_WEAKENED_RATIO = "1";
    const { MemoryStore: Fresh } = await import(`${distUrl("store.js")}?t13=1`);
    const rep = new Fresh(new Vault(dir)).reflect();
    check("유예 0 + 분위 1 이면 종전처럼 전원 등재", rep.weakened.length === 5, `len=${rep.weakened.length}`);
  } finally {
    if (prevG === undefined) delete process.env.ASTRONRAG_WEAKENED_GRACE_H;
    else process.env.ASTRONRAG_WEAKENED_GRACE_H = prevG;
    if (prevR === undefined) delete process.env.ASTRONRAG_WEAKENED_RATIO;
    else process.env.ASTRONRAG_WEAKENED_RATIO = prevR;
  }
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT12/T13 활성·임계 회귀 테스트 통과 ✔");
