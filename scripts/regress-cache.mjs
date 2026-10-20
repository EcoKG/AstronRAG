// T38 회귀 테스트 — 볼트 읽기 캐시.
//
// 고정하는 문제:
//   loadAll 이 질의마다 볼트 전체를 읽어 YAML 파싱했다. 950건 규모 실측에서
//   질의당 수백 ms~수 초의 상수 비용 — RIF O(K²) 를 고쳐도 이것이 남는다.
//
// 캐시가 지켜야 하는 계약 (어기면 T3/A2/A4 계열 사고가 재발한다):
//   1. 다른 프로세스의 쓰기가 즉시 보인다 (writeFileAtomic 은 매번 새 inode)
//   2. 외부 제자리 편집(Obsidian)이 보인다 (mtime/size)
//   3. 반환본은 클론이다 — 호출부가 변이해도 캐시·다음 읽기가 오염되지 않는다
//   4. 실패한 파싱은 캐시되지 않는다 (gray-matter A2 세탁 벡터의 재발 금지)
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
const cleanups = /** @type {string[]} */ (Array());
function freshDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-cache-"));
  cleanups.push(d);
  return d;
}

// ── 1. 캐시 히트가 정확한 내용을 돌려준다
console.log("1) 반복 읽기 일관성");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  const rec = s.remember({ title: "캐시 대상", content: "본문 내용입니다.", type: "semantic", tags: ["캐시"] }).record;

  const v = new Vault(dir);
  const first = v.read(rec.slug);
  const second = v.read(rec.slug); // 캐시 히트 경로
  check("두 번째 읽기도 같은 내용", JSON.stringify(second) === JSON.stringify(first));
  check("본문 보존", second.body.includes("본문 내용입니다"));
  check("태그 보존", second.tags.includes("캐시"));
}

// ── 2. 클론 격리 — 반환본 변이가 캐시를 오염시키지 않는다
//
// reinforce/revise/remember 는 받은 레코드를 변이한 뒤 write 한다. 캐시 원본을
// 그대로 돌려주면 아직 디스크에 쓰지 않은 변이가 다음 읽기에 유령처럼 비친다.
//
// **모든 필드를 동적으로 순회**한다 — cloneRecord 는 "원시값 + 문자열 배열" 전제의
// 수동 클론이라, 미래에 중첩 필드가 추가되고 클론에서 빠지면 얕은 복사가 조용히
// 새는데, 필드를 하나하나 나열하는 테스트는 그 필드를 모른다. 순회는 안다.
function cache_returns_isolated_records() {
  console.log("cache_returns_isolated_records");
  console.log("2) 클론 격리 (전 필드 동적 순회)");
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  const rec = s.remember({
    title: "격리 확인",
    description: "설명",
    content: "원본. 링크도 하나: 없음.",
    type: "semantic",
    tags: ["태그1"],
  }).record;

  const v = new Vault(dir);
  const pristine = JSON.stringify(v.read(rec.slug)); // 파스 직후의 기준값 (이 읽기가 캐시를 적재)
  const a = v.read(rec.slug); // 캐시 히트 반환본

  // 반환본의 모든 필드를 재귀 변이한다
  const contaminate = (obj) => {
    for (const [k, val] of Object.entries(obj)) {
      if (Array.isArray(val)) val.push("오염-항목");
      else if (val && typeof val === "object") contaminate(val);
      else if (typeof val === "string") obj[k] = "오염된-문자열";
      else if (typeof val === "number") obj[k] = -12345;
      else if (typeof val === "boolean") obj[k] = !val;
    }
  };
  contaminate(a);

  const b = v.read(rec.slug); // 다시 캐시 히트 — a 의 변이가 하나라도 비치면 실패
  check("어떤 필드의 변이도 다음 읽기에 안 비침", JSON.stringify(b) === pristine,
    JSON.stringify(b) === pristine ? "" : `diff: ${JSON.stringify(b).slice(0, 200)}`);
  check("다른 Vault 인스턴스도 원본 유지", JSON.stringify(new Vault(dir).read(rec.slug)) === pristine);
}
cache_returns_isolated_records();

// ── 3. 다른 프로세스의 원자적 쓰기가 즉시 보인다 (T3 재읽기 계약 보존)
console.log("3) 타 프로세스 쓰기 감지");
{
  const dir = freshDir();
  const a = new MemoryStore(new Vault(dir));
  const rec = a.remember({ title: "공유 기억", content: "1세대.", type: "semantic" }).record;
  check("A 가 1세대를 읽음", a.resolve(rec.slug)?.record?.body.includes("1세대"));

  // 다른 프로세스(=별도 스토어)가 revise — writeFileAtomic 경유, 새 inode
  const past = new Date(Date.now() - 3600_000 * 24 * 400).toISOString();
  const fp = path.join(dir, "memories", `${rec.slug}.md`);
  fs.writeFileSync(fp, fs.readFileSync(fp, "utf-8").replace(/last_reinforced: .*/, `last_reinforced: '${past}'`), "utf-8");
  const b = new MemoryStore(new Vault(dir));
  b.revise(rec.slug, { reason: "교정", content: "2세대 본문." });

  const seen = a.resolve(rec.slug);
  check("A 의 캐시가 B 의 교정을 즉시 봄", seen?.record?.body.includes("2세대"), seen?.record?.body);
}

// ── 4. 외부 제자리 편집(Obsidian 스타일) 감지
console.log("4) 제자리 편집 감지");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  // description 을 명시한다 — 생략하면 content 첫 줄이 frontmatter description 으로도
  // 들어가, 아래 replace(첫 일치만)가 본문이 아니라 frontmatter 를 바꿔 테스트가 헛돈다
  const rec = s.remember({ title: "손편집 대상", description: "설명", content: "편집 전.", type: "semantic" }).record;
  const v = new Vault(dir);
  check("편집 전 내용", v.read(rec.slug).body.includes("편집 전"));

  // Obsidian 처럼 같은 파일에 직접 덮어쓴다 (inode 유지, mtime/size 변화)
  const fp = path.join(dir, "memories", `${rec.slug}.md`);
  fs.writeFileSync(fp, fs.readFileSync(fp, "utf-8").replace("편집 전.", "편집 후 — 사용자가 고침."), "utf-8");
  check("제자리 편집이 즉시 보임", v.read(rec.slug).body.includes("편집 후"), v.read(rec.slug).body);
}

// ── 5. 삭제·재생성 감지
console.log("5) 삭제·재생성");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  const rec = s.remember({ title: "지웠다 다시", description: "설명", content: "구세대.", type: "semantic" }).record;
  const v = new Vault(dir);
  v.read(rec.slug); // 캐시 적재

  const fp = path.join(dir, "memories", `${rec.slug}.md`);
  const original = fs.readFileSync(fp, "utf-8");
  fs.unlinkSync(fp);
  check("삭제 후 null", v.read(rec.slug) === null);

  fs.writeFileSync(fp, original.replace("구세대.", "신세대."), "utf-8");
  check("같은 이름으로 재생성해도 새 내용", v.read(rec.slug)?.body.includes("신세대"));
}

// ── 6. forget(아카이브 이동) 후에도 정확
console.log("6) 아카이브 이동");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  const rec = s.remember({ title: "이동 대상", content: "본문.", type: "semantic" }).record;
  s.read(rec.slug); // 캐시 적재 (활성 경로)
  s.forget(rec.slug, "이동 확인");

  check("활성 경로에서는 null", new Vault(dir).read(rec.slug) === null);
  const v2 = new Vault(dir);
  check("아카이브 경로에서 읽힘", v2.read(rec.slug, true)?.title === "이동 대상");
  check("같은 스토어의 resolve 도 정확", s.resolve(rec.slug)?.archived === true);
}

// ── 7. 실패한 파싱은 캐시되지 않는다 (A2 재발 금지)
console.log("7) 손상 파일 비캐시");
{
  const dir = freshDir();
  const s = new MemoryStore(new Vault(dir));
  const rec = s.remember({ title: "곧 깨질 기억", content: "본문.", type: "semantic" }).record;
  const v = new Vault(dir);
  v.read(rec.slug); // 정상 캐시 적재

  // 절단 파일로 교체 → 격리되고 null
  const fp = path.join(dir, "memories", `${rec.slug}.md`);
  fs.writeFileSync(fp, "---\nid: mem-x\ntitle: 절단", "utf-8"); // 닫는 --- 없음
  check("절단 파일은 null + 격리", v.read(rec.slug) === null);
  check("격리소로 이동됨", fs.readdirSync(path.join(dir, "quarantine")).length === 1);

  // 정상 파일을 같은 이름으로 복구하면 다시 읽힌다 (실패가 캐시에 눌어붙지 않음)
  const s2 = new MemoryStore(new Vault(dir));
  const rec2 = s2.remember({ title: "곧 깨질 기억", content: "복구본.", type: "semantic" }).record;
  check("복구본이 읽힘", v.read(rec2.slug)?.body.includes("복구본"), rec2.slug);
}

// ── 8. 성능 — 두 번째 loadAll 이 파싱을 건너뛴다
console.log("8) 성능");
{
  const dir = freshDir();
  const seed = new MemoryStore(new Vault(dir));
  for (let i = 0; i < 300; i++) {
    seed.remember({ title: `대량 기억 ${i}`, content: `본문 ${i} — 캐시 성능 측정용으로 길이를 조금 늘린다.`, type: "semantic" });
  }
  const s = new MemoryStore(new Vault(dir));
  const t0 = Date.now();
  const first = s.loadAll(true);
  const coldMs = Date.now() - t0;
  const t1 = Date.now();
  const second = s.loadAll(true);
  const warmMs = Date.now() - t1;
  console.log(`    콜드 ${coldMs}ms / 웜 ${warmMs}ms (300건)`);
  check("건수 동일", first.length === 300 && second.length === 300, `${first.length}/${second.length}`);
  check("웜 읽기가 유의미하게 빠름", warmMs < Math.max(1, coldMs / 3), `cold=${coldMs} warm=${warmMs}`);
  check("내용 동일", JSON.stringify(second.map((m) => m.slug).sort()) === JSON.stringify(first.map((m) => m.slug).sort()));
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT38 읽기 캐시 회귀 테스트 통과 ✔");
