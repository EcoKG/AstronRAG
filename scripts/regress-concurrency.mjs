// T3/T4 회귀 테스트 — 동시 접근이 조용히 데이터를 되돌리거나 잃지 않는지.
//
// 고정하는 버그:
//   A4 recall/read 의 강화 write-back 이 loadAll 스냅샷 전체를 재직렬화해서,
//      그 창 안에 착지한 다른 프로세스의 revise 를 되돌리고(무흔적),
//      forget 된 기억을 memories/ 에 부활시키고(split-brain),
//      2프로세스 300회 recall 시 강화의 84~99.5% 를 잃었다.
//   A5 makeSlug 의 exists() 와 write 사이 TOCTOU 로 동시 동일 제목 remember 시
//      한쪽 기억이 무흔적 소실됐다.
//
// 라이브 볼트는 건드리지 않는다 — 전부 os.tmpdir() 임시 볼트.

import { spawn } from "node:child_process";
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
const { FileStore } = await import(distUrl("stores/file-store.js"));
const { SqliteStore } = await import(distUrl("stores/sqlite-store.js"));

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name} ${detail}`);
  }
}

const cleanups = /** @type {string[]} */ (Array());
const testTmp = path.resolve(process.env.ASTRONRAG_TEST_TMPDIR ?? os.tmpdir());
fs.mkdirSync(testTmp, { recursive: true });
function freshDir() {
  const d = fs.mkdtempSync(path.join(testTmp, "bbm-race-"));
  cleanups.push(d);
  return d;
}
const memPath = (dir, slug) => path.join(dir, "memories", `${slug}.md`);
const arcPath = (dir, slug) => path.join(dir, "archive", `${slug}.md`);

/** last_reinforced 를 과거로 되감아 간격 게이트를 연다 (강화가 실제로 기록되게) */
function openGate(dir, slug) {
  const fp = memPath(dir, slug);
  if (!fs.existsSync(fp)) return;
  const past = new Date(Date.now() - 3600_000).toISOString();
  fs.writeFileSync(fp, fs.readFileSync(fp, "utf-8").replace(/last_reinforced: .*/, `last_reinforced: '${past}'`), "utf-8");
}
/** 파일에서 access_count 를 직접 읽는다 (store.read 의 부수효과 없이) */
function diskAccessCount(dir, slug) {
  const fp = fs.existsSync(memPath(dir, slug)) ? memPath(dir, slug) : arcPath(dir, slug);
  return Number(/access_count: (\d+)/.exec(fs.readFileSync(fp, "utf-8"))?.[1] ?? -1);
}

function storedAccessCount(kind, dir, slug) {
  if (kind === "file") return diskAccessCount(dir, slug);
  const store = new SqliteStore(dir);
  try {
    return store.read(slug)?.accessCount ?? -1;
  } finally {
    store.close();
  }
}

/**
 * 경쟁 창을 결정적으로 재현한다.
 * A 가 레코드를 읽은 **직후·강화 기록 전에** B 의 변이를 착지시킨다.
 * (search 의 loadAll 스냅샷 → 다른 프로세스 변이 → 강화 write-back 과 동일 구조)
 */
function raceOnce(dir, slug, mutate) {
  // 간격 게이트를 연다. T11 이후 게이트가 닫혀 있으면 reinforce 가 아예 쓰지 않으므로
  // 경쟁 자체가 성립하지 않아 테스트가 공허해진다 — 실제로 write-back 이 일어나는
  // 위험한 경로를 검증해야 A4 회귀를 잡을 수 있다.
  openGate(dir, slug);
  const vaultA = new Vault(dir);
  const storeA = new MemoryStore(vaultA);
  const origFind = vaultA.find.bind(vaultA);
  let fired = false;
  vaultA.find = (s) => {
    const r = origFind(s);
    if (!fired) {
      fired = true;
      mutate(); // ← 창 안에 경쟁 프로세스가 착지
    }
    return r;
  };
  storeA.read(slug); // resolve(낡은 스냅샷) → reinforce(강화 기록)
  return fired;
}

async function env_new_names_preserve_concurrent_writes() {
  console.log("env_new_names_preserve_concurrent_writes");
  // ── 1. 경쟁 revise 가 강화 write-back 에 덮이지 않는다 (A4)
  console.log("1) 동시 revise 보존 (A4)");
  {
    const dir = freshDir();
    const seed = new MemoryStore(new Vault(dir));
    const rec = seed.remember({
      title: "경쟁 대상",
      content: "원본 본문 ORIGINAL.",
      type: "semantic",
      confidence: 0.8,
    }).record;

    const storeB = new MemoryStore(new Vault(dir));
    const fired = raceOnce(dir, rec.slug, () =>
      storeB.revise(rec.slug, { reason: "경쟁 프로세스 교정", content: "교정 본문 REVISED.", confidence: 0.95 }),
    );
    check("경쟁 창이 실제로 열렸음(전제 확인)", fired);

    const after = fs.readFileSync(memPath(dir, rec.slug), "utf-8");
    check("B 의 본문 교정이 보존됨", after.includes("REVISED"), after.slice(0, 200));
    check("B 의 확신도 교정이 보존됨", /confidence: 0\.95/.test(after));
    check("B 의 이력이 보존됨", after.includes("revised"));
    check("A 의 강화도 함께 반영됨(접근수 증가)", /access_count: [1-9]/.test(after));
  }

  // ── 2. 경쟁 forget 이 부활하지 않는다 (A4 split-brain)
  console.log("2) 동시 forget 유지 — 부활 없음 (A4)");
  {
    const dir = freshDir();
    const seed = new MemoryStore(new Vault(dir));
    const rec = seed.remember({ title: "망각 대상", content: "폐기될 기억.", type: "semantic" }).record;

    const storeB = new MemoryStore(new Vault(dir));
    raceOnce(dir, rec.slug, () => storeB.forget(rec.slug, "경쟁 프로세스가 폐기"));

    check("memories/ 에 부활하지 않음", !fs.existsSync(memPath(dir, rec.slug)));
    check("archive/ 에 그대로 있음", fs.existsSync(arcPath(dir, rec.slug)));
    const arc = fs.readFileSync(arcPath(dir, rec.slug), "utf-8");
    check("상태가 archived 유지", /status: archived/.test(arc));
    check("망각 사유(이력) 보존", arc.includes("forgotten"));

    const s = new MemoryStore(new Vault(dir));
    check("활성 목록에 나타나지 않음", s.list().length === 0, `len=${s.list().length}`);
  }

  // ── 3. 강화 write-back 실패가 회상을 죽이지 않는다 (T2 에서 발견)
  console.log("3) 강화 실패는 best-effort — 회상은 계속된다");
  {
    const dir = freshDir();
    const backend = new FileStore(dir);
    const now = Date.parse("2026-01-02T00:00:00.000Z");
    const seed = new MemoryStore(backend, undefined, () => now - 3600_000);
    const { record } = seed.remember({ title: "베스트에포트", content: "오스카 파파 회상되어야 한다.", type: "semantic" });

    const origRename = fs.renameSync;
    const origError = console.error;
    let warnings = "";
    /** @type {any[] | null} */
    let results = null;
    let readOk = null;
    try {
      fs.renameSync = () => {
        throw new Error("주입된 쓰기 실패");
      };
      console.error = (...parts) => { warnings += `${parts.join(" ")}\n`; };
      const s = new MemoryStore(backend, undefined, () => now);
      results = s.search("오스카");
      readOk = s.read(record.slug);
    } catch (err) {
      check("회상이 예외로 죽지 않음", false, String(err?.message ?? err));
    } finally {
      fs.renameSync = origRename;
      console.error = origError;
    }
    check("쓰기 실패에도 search 가 결과를 반환", Number(Object(results).length) === 1, `len=${Object(results).length}`);
    check("쓰기 실패에도 read_memory 가 동작", readOk !== null);
    check("test_concurrency_failure_uses_file_store_usage_contract", !warnings.includes("이벤트 기록 실패"));
    const unapplied = new FileStore(dir).readUsageEvents().filter((event) => event.tool === "reinforcement_unapplied");
    check("test_failed_reinforcement_persists_unapplied_event", unapplied.length === 2
      && unapplied.every((event) => event.slug === record.slug && event.ok === false && event.reason === "exception_swallowed"), JSON.stringify(unapplied));
  }

  {
    const dir = freshDir();
    const vault = new Vault(dir);
    const originalError = console.error;
    let warnings = "";
    console.error = (...parts) => { warnings += `${parts.join(" ")}\n`; };
    const captureError = console.error;
    try {
      fs.writeFileSync(memPath(dir, "truncated"), "---\ntitle: truncated\n", "utf8");
      const truncated = vault.read("truncated");
      console.error = originalError;
      check("test_vault_missing_closing_delimiter_reports_truncation", truncated === null
        && warnings.includes("truncated — 닫는 frontmatter 구분자(---) 없음 — 쓰기 중 절단 의심 →")
        && !fs.existsSync(memPath(dir, "truncated")), warnings);
      for (const [slug, raw] of [["empty", ""], ["invalid", "---\ntitle: [\n---\nbody"]]) {
        warnings = "";
        fs.writeFileSync(memPath(dir, slug), raw, "utf8");
        console.error = captureError;
        const parsed = vault.read(slug);
        console.error = originalError;
        check("test_vault_other_parse_error_preserves_reason", parsed === null
          && warnings.includes(`${slug} — frontmatter 파싱 실패:`) && !warnings.includes("절단 의심"), warnings);
      }
    } finally {
      console.error = originalError;
    }
  }

  // ── 4. 2프로세스 동시 강화 — 소실률 (A4)
  console.log("4) 2프로세스 동시 recall — 강화 소실률 (A4)");
  {
    const dir = freshDir();
    const kind = process.env.ASTRONRAG_STORE === "file" ? "file" : "sqlite";
    const backend = kind === "file" ? new Vault(dir) : new SqliteStore(dir);
    const seed = new MemoryStore(backend);
    const rec = seed.remember({ title: "경합 카운터", content: "퀘벡 로미오 경합 대상.", type: "semantic" }).record;
    if (kind === "sqlite") backend.close();
    const baseline = storedAccessCount(kind, dir, rec.slug);

    const N = 300;
    const child = path.join(dir, "child.mjs");
    fs.writeFileSync(
      child,
      `import { ${kind === "sqlite" ? "SqliteStore" : "FileStore"} } from ${JSON.stringify(distUrl(`stores/${kind === "sqlite" ? "sqlite" : "file"}-store.js`))};
  import { MemoryStore } from ${JSON.stringify(distUrl("store.js"))};
  const backend = new ${kind === "sqlite" ? "SqliteStore" : "FileStore"}(process.argv[2]);
  const s = new MemoryStore(backend);
  process.once("message", () => {
    try {
      let noResult = 0;
      for (let i = 0; i < ${N}; i++) if (s.search("퀘벡").length === 0) noResult++;
      backend.appendUsageEvent({ tool: "concurrency_reinforcement_summary", ok: noResult === 0, reason: noResult === 0 ? "applied" : "no_result", count: noResult });
    } finally {
      backend.close?.();
      process.disconnect();
    }
  });
  process.send("ready");
  `,
      "utf-8",
    );

    const t0 = Date.now();
    const childEnv = {
      ...process.env,
      ASTRONRAG_SPACING_MS: "0",
      ASTRONRAG_SPACING_ALPHA: "0",
      ASTRONRAG_FLUSH_EVERY_ACCESS: "1",
    };
    const processes = /** @type {import("node:child_process").ChildProcess[]} */ (Array());
    let ready = 0;
    const kids = await Promise.all([0, 1].map(() => new Promise((resolve) => {
      const childProcess = spawn(process.execPath, [child, dir], { env: childEnv, timeout: 30000,
        stdio: ["ignore", "ignore", "pipe", "ipc"] });
      processes.push(childProcess);
      let stderr = "";
      childProcess.stderr?.on("data", (chunk) => { stderr += chunk; });
      childProcess.once("error", (error) => { stderr += String(error); });
      childProcess.once("message", (message) => {
        if (message === "ready" && ++ready === 2) {
          for (const worker of processes) worker.send("start", (error) => { if (error) worker.kill(); });
        }
      });
      childProcess.once("close", (status) => resolve({ status, stderr }));
    })));
    const elapsed = Date.now() - t0;
    check("자식 프로세스 2개 정상 종료", kids.every((k) => Object(k).status === 0), kids.map((k) => Object(k).stderr?.slice(0, 200)).join(" | "));
    check("두 자식이 시작 장벽에서 준비됨", ready === 2, `ready=${ready}`);

    const final = storedAccessCount(kind, dir, rec.slug);
    const expected = baseline + 2 * N;
    const lost = expected - final;
    const lossRate = (lost / (2 * N)) * 100;
    const failureEvents = kind === "sqlite" ? new SqliteStore(dir) : null;
    const reasons = failureEvents
      ? failureEvents.readUsageEvents().filter((event) => event.tool === "reinforcement_unapplied" || event.tool === "concurrency_reinforcement_summary")
      : [];
    failureEvents?.close();
    const unapplied = reasons.filter((event) => event.tool === "reinforcement_unapplied").length
      + reasons.reduce((sum, event) => sum + (event.reason === "no_result" ? Number(event.count ?? 0) : 0), 0);
    const reasonCounts = reasons.reduce((counts, event) => {
      const reason = String(event.reason ?? "other");
      counts[reason] = (counts[reason] ?? 0) + (event.tool === "concurrency_reinforcement_summary" ? Number(event.count ?? 0) : 1);
      return counts;
    }, {});
    if (kind === "sqlite" && lost > unapplied) reasonCounts.gate_not_flushed = lost - unapplied;
    // FileStore는 프로세스 간 잠금이 없어 동시 강화 일부가 소실될 수 있다.
    const fileLossLimit = 30;
    console.log(`    ${kind} 기대 ${expected} / 실측 ${final} / 소실 ${lost} (${lossRate.toFixed(1)}%, ${elapsed}ms)`);
    if (kind === "sqlite") console.log(`    미반영 ${unapplied} / 사유 ${JSON.stringify(reasonCounts)}`);
    check(kind === "sqlite" ? "test_sqlite_concurrent_reinforcement_has_zero_loss" : "test_file_reinforcement_loss_under_concurrent_workers",
      kind === "sqlite" ? lost === 0 : lossRate >= 0 && lossRate < fileLossLimit, `lost=${lost}/${2 * N}, fileLimit=${fileLossLimit}%`);
    if (kind === "sqlite") check("SQLite 강화 미반영 카운트 0", unapplied === 0, JSON.stringify(reasonCounts));
    check("저장소가 손상되지 않음", final >= 0);
  }

  console.log("4-1) SQLite 간격 게이트 원자 판정");
  {
    const dir = freshDir();
    const backend = new SqliteStore(dir);
    const seed = new MemoryStore(backend);
    const rec = seed.remember({ title: "간격 게이트", content: "시에라 탱고 원자 강화 대상.", type: "semantic" }).record;
    backend.updateRecord(rec.slug, (current) => ({
      ...current,
      storageStrength: 2,
      lastReinforced: "2000-01-01T00:00:00.000Z",
    }));
    backend.close();

    const child = path.join(dir, "spacing-child.mjs");
    fs.writeFileSync(child, `import fs from "node:fs";
  import path from "node:path";
  import { SqliteStore } from ${JSON.stringify(distUrl("stores/sqlite-store.js"))};
  import { MemoryStore } from ${JSON.stringify(distUrl("store.js"))};
  const dir = process.argv[2];
  const worker = process.argv[3];
  const backend = new SqliteStore(dir);
  const original = backend.updateRecord.bind(backend);
  backend.updateRecord = (slug, update) => {
    fs.writeFileSync(path.join(dir, "ready-" + worker), "ready");
    const deadline = Date.now() + 10000;
    while ((!fs.existsSync(path.join(dir, "ready-0")) || !fs.existsSync(path.join(dir, "ready-1"))) && Date.now() < deadline) {}
    return original(slug, update);
  };
  new MemoryStore(backend).search("시에라 탱고", { active: true });
  backend.close();
  `, "utf-8");
    const outcomes = await Promise.all([0, 1].map((worker) => new Promise((resolve) => {
      const childProcess = spawn(process.execPath, [child, dir, String(worker)], { env: { ...process.env, ASTRONRAG_SPACING_MS: "600000" } });
      let stderr = "";
      childProcess.stderr.on("data", (chunk) => { stderr += chunk; });
      childProcess.on("close", (status) => resolve({ status, stderr }));
    })));
    const resultStore = new SqliteStore(dir);
    const result = resultStore.read(rec.slug);
    resultStore.close();
    check("test_sqlite_spacing_gate_is_atomic_across_processes", outcomes.every((outcome) => Object(outcome).status === 0) && result?.storageStrength === 3, `strength=${result?.storageStrength} outcomes=${JSON.stringify(outcomes)}`);
  }

  // ── 5. 동시 동일 제목 remember — 무흔적 소실 없음 (A5)
  console.log("5) 동시 동일 제목 remember (A5)");
  {
    const dir = freshDir();
    const vaultA = new Vault(dir);
    const storeA = new MemoryStore(vaultA);
    const storeB = new MemoryStore(new Vault(dir));

    // A 가 slug 후보를 정한 직후·파일 생성 전에 B 가 같은 제목으로 완주하도록 창을 연다
    const origMakeSlug = vaultA.makeSlug.bind(vaultA);
    let fired = false;
    /** @type {any} */
    let bRec = null;
    vaultA.makeSlug = (title) => {
      const s = origMakeSlug(title);
      if (!fired) {
        fired = true;
        bRec = storeB.remember({ title, content: "B 의 본문 MARKER-BBB.", type: "semantic" }).record;
      }
      return s;
    };
    const aRec = storeA.remember({ title: "동시성 데모 제목", content: "A 의 본문 MARKER-AAA.", type: "semantic" }).record;

    check("경쟁 창이 실제로 열렸음(전제 확인)", fired);
    check("두 기억이 서로 다른 slug 를 받음", aRec.slug !== Object(bRec).slug, `a=${aRec.slug} b=${Object(bRec).slug}`);

    const files = fs.readdirSync(path.join(dir, "memories")).filter((f) => f.endsWith(".md"));
    check("파일 2개 모두 존재", files.length === 2, files.join(","));
    check("임시 파일 잔재 없음", fs.readdirSync(path.join(dir, "memories")).every((f) => !f.includes(".tmp-")));
    const all = files.map((f) => fs.readFileSync(path.join(dir, "memories", f), "utf-8"));
    check("A 의 본문 생존", all.some((t) => t.includes("MARKER-AAA")));
    check("B 의 본문 생존", all.some((t) => t.includes("MARKER-BBB")));

    const s = new MemoryStore(new Vault(dir));
    check("A 를 id 로 조회 가능", s.resolve(aRec.id)?.record?.id === aRec.id);
    check("B 를 id 로 조회 가능", s.resolve(Object(bRec).id)?.record?.id === Object(bRec).id);
    check("A 를 반환된 slug 로 조회 가능", s.resolve(aRec.slug)?.record?.id === aRec.id);
    check("B 를 반환된 slug 로 조회 가능", s.resolve(Object(bRec).slug)?.record?.id === Object(bRec).id);
  }

  // ── 6. slug 충돌 시에도 supersede 역참조가 실제 파일을 가리킨다
  console.log("6) slug 충돌 + supersede 정합성");
  {
    const dir = freshDir();
    const vaultA = new Vault(dir);
    const storeA = new MemoryStore(vaultA);
    const storeB = new MemoryStore(new Vault(dir));

    const old = storeA.remember({ title: "구 지식", content: "낡은 사실.", type: "semantic" }).record;

    const origMakeSlug = vaultA.makeSlug.bind(vaultA);
    let fired = false;
    vaultA.makeSlug = (title) => {
      const s = origMakeSlug(title);
      if (!fired) {
        fired = true;
        storeB.remember({ title, content: "B 가 선점.", type: "semantic" });
      }
      return s;
    };
    const neo = storeA.remember({
      title: "새 지식",
      content: "갱신된 사실.",
      type: "semantic",
      supersedes: old.slug,
    }).record;

    check("충돌로 접미가 붙었음(전제 확인)", neo.slug !== "새-지식", `slug=${neo.slug}`);
    const oldAfter = fs.readFileSync(memPath(dir, old.slug), "utf-8");
    const m = /superseded_by: (\S+)/.exec(oldAfter);
    check("구 기억에 superseded_by 기록됨", !!m, oldAfter.slice(0, 200));
    check("superseded_by 가 최종 slug 와 일치", m?.[1] === neo.slug, `by=${m?.[1]} final=${neo.slug}`);
    check("superseded_by 가 실제 존재하는 파일을 가리킴", fs.existsSync(memPath(dir, m?.[1] ?? "")));
  }

  // ── 7. SQLite 실제 병렬 다중 프로세스 쓰기
  console.log("7) SQLite 실제 병렬 다중 프로세스 쓰기");
  {
    const dir = freshDir();
    new SqliteStore(dir).close();
    const childCode = `
  import { SqliteStore } from ${JSON.stringify(distUrl("stores/sqlite-store.js"))};
  const [dir, worker] = process.argv.slice(1);
  const store = new SqliteStore(dir);
  for (let n = 0; n < 20; n++) {
    const now = "2026-01-02T03:04:05.000Z";
    store.createNew({ id: "mem-" + worker + "-" + n, slug: "worker-" + worker + "-" + n, title: "worker", description: "worker", type: "semantic", tags: [], confidence: 0.8, storageStrength: 1, status: "active", created: now, updated: now, lastAccessed: now, lastReinforced: now, accessCount: 0, links: [], history: [], body: "worker" });
  }
  store.close();
  `;
    /** @type {{ code: number | null, stderr: string }[]} */
    const outcomes = await Promise.all(Array.from({ length: 4 }, (_, worker) => new Promise((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", childCode, dir, String(worker)]);
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (code) => resolve({ code, stderr }));
    })));
    const store = new SqliteStore(dir);
    check("test_sqlite_multi_process_writes_without_loss_or_busy", outcomes.every((outcome) => Object(outcome).code === 0 && !/SQLITE_BUSY/.test(Object(outcome).stderr)) && store.listSlugs(true).length === 80, JSON.stringify(outcomes));
    check("test_sqlite_integrity_after_concurrent_writes", store.integrityCheck() === "ok", store.integrityCheck());
    store.close();
  }
}
try {
  await env_new_names_preserve_concurrent_writes();
} finally {
  for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT3/T4 동시성 회귀 테스트 통과 ✔");
