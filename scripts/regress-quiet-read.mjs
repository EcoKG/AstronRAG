// T11 회귀 테스트 — 조회가 디스크를 건드리지 않는지.
//
// 고정하는 버그(감사 B):
//   간격 게이트가 닫혀 있어도 reinforce 가 accessCount/lastAccessed 갱신을 위해
//   무조건 vault.write 를 호출해, recall 1회로 히트+연상 최대 8개 파일이 재기록됐다.
//   MEMORY.md 는 본문에 생성 시각을 박아 내용이 같아도 매번 달라졌고, 서버 기동마다
//   재생성되므로 MCP 클라이언트를 켜기만 해도 diff 가 생겼다.
//   → git working tree 오염, Obsidian 동시 편집 충돌, 백업 스냅샷 소음.
//
// 라이브 볼트는 건드리지 않는다 — 전부 os.tmpdir() 임시 볼트.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
const testTmp = path.resolve(process.env.BBM_TEST_TMPDIR ?? os.tmpdir());
fs.mkdirSync(testTmp, { recursive: true });
function seeded() {
  const dir = fs.mkdtempSync(path.join(testTmp, "bbm-quiet-"));
  cleanups.push(dir);
  const s = new MemoryStore(new Vault(dir));
  const a = s.remember({ title: "조용한 기억 A", content: "탱고 앰버 본문.", type: "semantic" }).record;
  const b = s.remember({ title: "조용한 기억 B", content: "탱고 브라보 본문.", type: "semantic" }).record;
  s.link(a.slug, b.slug, "연상 확인용");
  return { dir, store: s, a, b };
}
/** 볼트 전체의 파일별 (크기, mtimeMs, 내용해시 대용) 스냅샷 */
function snap(dir) {
  const out = {};
  for (const sub of ["memories", "archive"]) {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".md"))) {
      const fp = path.join(d, f);
      out[`${sub}/${f}`] = { text: fs.readFileSync(fp, "utf-8"), mtime: fs.statSync(fp).mtimeMs };
    }
  }
  const idx = path.join(dir, "MEMORY.md");
  if (fs.existsSync(idx)) out["MEMORY.md"] = { text: fs.readFileSync(idx, "utf-8"), mtime: fs.statSync(idx).mtimeMs };
  return out;
}
function changed(before, after) {
  return Object.keys({ ...before, ...after }).filter(
    (k) => before[k]?.text !== after[k]?.text || before[k]?.mtime !== after[k]?.mtime,
  );
}

// ── 1. 간격 게이트가 닫힌 조회는 디스크를 건드리지 않는다
console.log("1) 게이트 내 조회 — 파일 무변경 (B)");
{
  const { dir, store, a } = seeded();
  const before = snap(dir);
  store.search("탱고"); // 직접 히트 2건 + 연상
  store.search("탱고");
  store.read(a.slug);
  const after = snap(dir);
  const diff = changed(before, after);
  check("조회 3회 후 변경된 파일 0개", diff.length === 0, diff.join(","));
}

// ── 2. 게이트가 열리면 정상적으로 기록된다 (기능 보존)
console.log("2) 게이트 통과 시에는 기록됨");
{
  const { dir, store, a } = seeded();
  const fp = path.join(dir, "memories", `${a.slug}.md`);
  // lastReinforced 를 과거로 되감아 게이트를 연다
  const past = new Date(Date.now() - 3600_000).toISOString();
  fs.writeFileSync(fp, fs.readFileSync(fp, "utf-8").replace(/last_reinforced: .*/, `last_reinforced: '${past}'`), "utf-8");

  const s = new MemoryStore(new Vault(dir));
  const beforeText = fs.readFileSync(fp, "utf-8");
  s.search("앰버");
  const afterText = fs.readFileSync(fp, "utf-8");
  check("저장강도가 올라 파일이 갱신됨", afterText !== beforeText);
  check("storage_strength 증가", /storage_strength: [2-9]/.test(afterText), afterText.match(/storage_strength: .*/)?.[0]);
  check("access_count 도 함께 반영", /access_count: [1-9]/.test(afterText), afterText.match(/access_count: .*/)?.[0]);
}

// ── 3. 환경변수로 종전 동작(매 접근 기록)을 되살릴 수 있다
console.log("3) BIGBRAIN_FLUSH_EVERY_ACCESS 로 종전 동작 복원");
{
  const prev = process.env.BIGBRAIN_FLUSH_EVERY_ACCESS;
  process.env.BIGBRAIN_FLUSH_EVERY_ACCESS = "1";
  try {
    // 모듈 상수는 로드 시점에 고정되므로 캐시를 우회해 새로 import 한다
    const { MemoryStore: Fresh } = await import(`${distUrl("store.js")}?flush=1`);
    const { dir } = seeded();
    const s = new Fresh(new Vault(dir));
    const before = snap(dir);
    s.search("탱고");
    const diff = changed(before, snap(dir));
    check("플래그를 켜면 조회가 파일을 기록함", diff.length > 0, `changed=${diff.length}`);
  } finally {
    if (prev === undefined) delete process.env.BIGBRAIN_FLUSH_EVERY_ACCESS;
    else process.env.BIGBRAIN_FLUSH_EVERY_ACCESS = prev;
  }
}

// ── 4. MEMORY.md 는 내용이 같으면 다시 쓰지 않는다
console.log("4) MEMORY.md 무변경 시 재작성 없음");
{
  const { dir } = seeded();
  const idx = path.join(dir, "MEMORY.md");
  const before = { text: fs.readFileSync(idx, "utf-8"), mtime: fs.statSync(idx).mtimeMs };
  check("인덱스에 생성 시각이 박혀 있지 않음", !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(before.text), before.text.slice(0, 120));

  // 서버 기동을 여러 번 모사
  for (let i = 0; i < 3; i++) new MemoryStore(new Vault(dir)).regenerateIndex();
  const after = { text: fs.readFileSync(idx, "utf-8"), mtime: fs.statSync(idx).mtimeMs };
  check("재생성 3회 후에도 내용 동일", after.text === before.text);
  check("mtime 도 그대로 (쓰기 자체가 생략됨)", after.mtime === before.mtime, `${before.mtime} → ${after.mtime}`);
}

// ── 5. 내용이 실제로 바뀌면 인덱스는 갱신된다 (기능 보존)
console.log("5) 기억이 늘면 인덱스는 갱신됨");
{
  const { dir, store } = seeded();
  const idx = path.join(dir, "MEMORY.md");
  const before = fs.readFileSync(idx, "utf-8");
  store.remember({ title: "새로 추가된 기억", content: "찰리 신규.", type: "semantic" });
  const after = fs.readFileSync(idx, "utf-8");
  check("새 기억이 인덱스에 반영됨", after !== before && after.includes("새로 추가된 기억"));
}

console.log("6) node:sqlite 경고 stdout 분리");
{
  const child = spawnSync(process.execPath, ["-e", "import('node:sqlite').then(()=>console.log('sqlite-ok'))"], { encoding: "utf8" });
  check("test_node_sqlite_warning_never_uses_stdout", child.status === 0 && child.stdout === "sqlite-ok\n" && !child.stdout.includes("ExperimentalWarning"), JSON.stringify({ stdout: child.stdout, stderr: child.stderr }));
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT11 조용한 조회 회귀 테스트 통과 ✔");
