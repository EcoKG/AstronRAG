// T20 회귀 테스트 — 네이티브 메모리 이관 스크립트.
//
// 고정하는 격차(감사 E5):
//   네이티브(user/feedback/project/reference)와 BBM(episodic/semantic/procedural/preference)의
//   타입 체계가 1:1 이 아니고 매핑 규칙·임포트 스크립트가 없어, 수작업 이관 시 타입이
//   임의 배정돼 type 필터 회상의 정밀도가 깨진다. vault.ts 는 미지 타입을 무경고로
//   semantic 으로 강등하므로 잘못 들어가도 드러나지 않는다.
//
// 라이브 볼트·라이브 네이티브 메모리 모두 건드리지 않는다 — 양쪽 다 임시 디렉터리를 주입한다.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const script = path.join(here, "import-native.mjs");
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
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-imp-"));
  cleanups.push(base);
  const projects = path.join(base, "projects");
  const vault = path.join(base, "vault");
  const memDir = path.join(projects, "G--Development-MyApp", "memory");
  fs.mkdirSync(memDir, { recursive: true });

  const note = (file, fm, body) => fs.writeFileSync(path.join(memDir, file), `---\n${fm}\n---\n\n${body}\n`, "utf-8");
  // 네이티브 4종 타입 + 인덱스 파일
  note("user-pref.md", "name: user-pref\ndescription: 사용자는 간결한 설명을 선호\nmetadata:\n  type: user", "사용자는 장황한 설명을 싫어한다.");
  note(
    "feedback-howto.md",
    "name: feedback-howto\ndescription: 커밋 전 반드시 테스트\nmetadata:\n  type: feedback",
    "커밋 전에 테스트를 돌린다.\n\n**How to apply:** 매 커밋 전 npm test 를 실행할 것.",
  );
  note("feedback-taste.md", "name: feedback-taste\ndescription: 짧은 답변 선호\nmetadata:\n  type: feedback", "사용자는 짧은 답변을 좋아한다.");
  note("project-fact.md", "name: project-fact\ndescription: 포트 구성\nmetadata:\n  type: project", "웹 서버는 8080 포트를 쓴다.");
  note("project-event.md", "name: project-event\ndescription: 마이그레이션 결정\nmetadata:\n  type: project", "2026-03-01 에 SQLite 로 옮기기로 결정했다.");
  note("ref-doc.md", "name: ref-doc\ndescription: 빌드 절차 참조\nmetadata:\n  type: reference", "빌드는 npm run build 로 한다.");
  fs.writeFileSync(path.join(memDir, "MEMORY.md"), "# Memory Index\n\n- 인덱스는 이관 대상이 아니다\n", "utf-8");
  // 프로젝트명 역매핑용 설정 — 사용자의 실제 ~/.claude.json 을 읽지 않도록 격리한다.
  // run() 이 HOME/USERPROFILE 을 base 로 덮으므로 이 파일이 ~/.claude.json 역할을 한다.
  fs.writeFileSync(path.join(base, ".claude.json"), JSON.stringify({ projects: { "G:\\Development\\MyApp": {} } }), "utf-8");
  return { projects, vault };
}
function run(projects, vault, apply, extra = /** @type {string[]} */ (Array())) {
  const args = [script, "--projects-dir", projects, "--vault", vault, ...extra];
  if (apply) args.push("--apply");
  // vault 는 <base>/vault 이므로 base 가 곧 가짜 홈이다
  const home = path.dirname(vault);
  return spawnSync(process.execPath, args, {
    encoding: "utf-8",
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}
const slugs = (vault) => new MemoryStore(new Vault(vault)).loadAll(true).map((m) => m.slug).sort();

// ── 1. 미리보기 모드는 아무것도 쓰지 않는다
console.log("1) 기본은 미리보기 (안전 기본값)");
{
  const { projects, vault } = fixture();
  const r = run(projects, vault, false);
  check("정상 종료", r.status === 0, r.stderr?.slice(0, 200));
  check("미리보기 안내 출력", /미리보기/.test(r.stdout), r.stdout.slice(0, 200));
  check("이관 예정 6건 (MEMORY.md 제외)", /이관 예정 6건/.test(r.stdout), r.stdout.slice(-300));
  check("볼트에 아무것도 안 씀", !fs.existsSync(path.join(vault, "memories")) || slugs(vault).length === 0);
}

// ── 2. --apply 로 실제 이관 + 타입 매핑
console.log("2) 타입 매핑 (E5 규칙)");
{
  const { projects, vault } = fixture();
  const r = run(projects, vault, true);
  check("정상 종료", r.status === 0, r.stderr?.slice(0, 300));
  const recs = new MemoryStore(new Vault(vault)).loadAll(true);
  const by = Object.fromEntries(recs.map((m) => [m.slug, m]));
  check("6건 이관됨 (MEMORY.md 는 제외)", recs.length === 6, slugs(vault).join(","));
  check("user → preference", by["user-pref"]?.type === "preference", by["user-pref"]?.type);
  check("feedback + 실행지침 → procedural", by["feedback-howto"]?.type === "procedural", by["feedback-howto"]?.type);
  check("feedback + 취향 → preference", by["feedback-taste"]?.type === "preference", by["feedback-taste"]?.type);
  check("project + 지속적 사실 → semantic", by["project-fact"]?.type === "semantic", by["project-fact"]?.type);
  check("project + 시점/사건 → episodic", by["project-event"]?.type === "episodic", by["project-event"]?.type);
  check("reference → procedural", by["ref-doc"]?.type === "procedural", by["ref-doc"]?.type);
  check("매핑 근거가 출력됨", /→ preference  \(/.test(r.stdout), r.stdout.slice(0, 400));
}

// ── 3. 메타데이터 보존 (T8 스코핑 연동 포함)
console.log("3) 메타데이터 보존");
{
  const { projects, vault } = fixture();
  run(projects, vault, true);
  const m = new MemoryStore(new Vault(vault)).loadAll(true).find((x) => x.slug === "user-pref");
  // 네이티브 MEMORY.md 에 사람이 읽는 제목이 없으면 원본 name 으로 폴백한다
  check("인덱스에 제목이 없으면 원본 name 폴백", m?.title === "user-pref", m?.title);
  check("설명 보존", m?.description === "사용자는 간결한 설명을 선호", m?.description);
  check("본문 보존", m?.body.includes("장황한 설명을 싫어한다"));
  // 스코프는 뭉개진 슬러그가 아니라 역매핑으로 복원한 실제 디렉터리명이다.
  // `ASTRONRAG_PROJECT` 에 사람이 손으로 쓸 수 있는 값이어야 하기 때문이다.
  check("project 스코프 = 역매핑된 프로젝트명", m?.project === "MyApp", m?.project);
  check("source 에 원본 경로 기록", m?.source === "native:G--Development-MyApp/user-pref.md", m?.source);
  check("native-import 태그", m?.tags.includes("native-import"), m?.tags.join(","));
}

// ── 4. 멱등성 — 두 번 실행해도 중복되지 않는다
console.log("4) 멱등 재실행");
{
  const { projects, vault } = fixture();
  run(projects, vault, true);
  const first = slugs(vault);
  const r2 = run(projects, vault, true);
  const second = slugs(vault);
  check("두 번째 실행도 정상 종료", r2.status === 0, r2.stderr?.slice(0, 200));
  check("건수 불변", first.length === second.length, `${first.length} → ${second.length}`);
  check("동일 슬러그 집합", JSON.stringify(first) === JSON.stringify(second));
  check("건너뜀으로 보고", /건너뜀 6건/.test(r2.stdout), r2.stdout.slice(-200));
}

// ── 5. 기존 볼트를 오염시키지 않는다
console.log("5) 기존 기억 보존");
{
  const { projects, vault } = fixture();
  const pre = new MemoryStore(new Vault(vault));
  pre.remember({ title: "기존 기억", content: "이관 전부터 있던 기억.", type: "semantic" });
  run(projects, vault, true);
  const recs = new MemoryStore(new Vault(vault)).loadAll(true);
  check("기존 기억 생존", recs.some((m) => m.slug === "기존-기억"));
  check("총 7건 (기존 1 + 이관 6)", recs.length === 7, `len=${recs.length}`);
}

// ── 6. 이상 입력 처리
console.log("6) 이상 입력");
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-imp-bad-"));
  cleanups.push(base);
  const memDir = path.join(base, "projects", "proj", "memory");
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, "empty-body.md"), "---\nname: empty-body\nmetadata:\n  type: user\n---\n\n", "utf-8");
  fs.writeFileSync(path.join(memDir, "no-type.md"), "---\nname: no-type\ndescription: 타입 없음\n---\n\n타입 키가 없는 노트.\n", "utf-8");
  const vault = path.join(base, "vault");
  const r = run(path.join(base, "projects"), vault, true);
  const recs = new MemoryStore(new Vault(vault)).loadAll(true);
  check("본문 빈 노트는 건너뜀", !recs.some((m) => m.slug === "empty-body"), slugs(vault).join(","));
  check("타입 없는 노트는 semantic 기본값", recs.find((m) => m.slug === "no-type")?.type === "semantic");
  check("기본값 사용을 근거로 출력", /알 수 없는 타입.*기본값/.test(r.stdout), r.stdout.slice(0, 500));
  check("실패가 있으면 종료코드 1", r.status === 1, `status=${r.status}`);
}

// ── 7. 대상이 없을 때
console.log("7) 대상 없음");
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-imp-none-"));
  cleanups.push(base);
  const r = run(path.join(base, "projects"), path.join(base, "vault"), false);
  check("정상 종료", r.status === 0);
  check("안내 출력", /이관할 파일이 없습니다/.test(r.stdout), r.stdout.slice(0, 200));
}

// ── 8. 제목 복원과 링크 재작성 (T28 / 감사 N3)
//
// 노트의 `name:` 은 슬러그이고, 사람이 읽는 제목은 **네이티브 MEMORY.md 인덱스에만**
// 있다. 슬러그를 제목으로 들여오면 BBM 주입 채널이 그대로 보여주므로 가독성이 떨어진다.
// 그런데 BBM 은 slug 를 title 에서 파생하므로, 제목을 바꾸면 노트끼리 걸어둔
// `[[원본name]]` 이 전부 허공을 가리킨다 — 그래서 저장 후 실제 슬러그로 치환해야 한다.
console.log("8) 제목 복원 + 링크 재작성");
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-imp-title-"));
  cleanups.push(base);
  const projects = path.join(base, "projects");
  const vault = path.join(base, "vault");
  const memDir = path.join(projects, "G--Development-MyApp", "memory");
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(base, ".claude.json"), JSON.stringify({ projects: { "G:\\Development\\MyApp": {} } }), "utf-8");

  const note = (file, fm, body) => fs.writeFileSync(path.join(memDir, file), `---\n${fm}\n---\n\n${body}\n`, "utf-8");
  note(
    "sqlite-crash.md",
    "name: sqlite-crash\ndescription: 한글 경로 DB 크래시\nmetadata:\n  type: project",
    "한글 경로 DB 파일은 프로세스가 죽는다. 관련: [[rmsync-crash]]",
  );
  note("rmsync-crash.md", "name: rmsync-crash\ndescription: rmSync 크래시\nmetadata:\n  type: project", "삭제는 unlinkSync 를 쓴다.");
  note("no-title-here.md", "name: no-title-here\ndescription: 인덱스에 없는 노트\nmetadata:\n  type: project", "인덱스에 항목이 없다.");
  // 인덱스에는 사람이 읽는 제목이 있다 (세 번째 노트는 일부러 빠뜨림)
  fs.writeFileSync(
    path.join(memDir, "MEMORY.md"),
    "# Memory Index\n\n- [SQLite 비ASCII 경로 크래시](sqlite-crash.md) — 한글 경로 DB는 abort\n- [fs.rmSync 비ASCII 크래시](rmsync-crash.md) — 하드 크래시\n",
    "utf-8",
  );

  const prev = run(projects, vault, false);
  check("미리보기가 복원된 제목을 보여줌", /제목: SQLite 비ASCII 경로 크래시/.test(prev.stdout), prev.stdout.slice(0, 600));
  check("미리보기가 원본 name 도 함께 표시", /원본 name: sqlite-crash/.test(prev.stdout), prev.stdout.slice(0, 600));
  check("미리보기가 역매핑 근거를 표시", /project=MyApp  \(.*역매핑\)/.test(prev.stdout), prev.stdout.slice(0, 600));

  const r = run(projects, vault, true);
  check("정상 종료", r.status === 0, r.stderr?.slice(0, 300));
  const recs = new MemoryStore(new Vault(vault)).loadAll(true);
  const byTitle = Object.fromEntries(recs.map((m) => [m.title, m]));
  check("인덱스의 사람이 읽는 제목으로 저장", !!byTitle["SQLite 비ASCII 경로 크래시"], recs.map((m) => m.title).join(" / "));
  check("인덱스에 없는 노트는 원본 name 유지", !!byTitle["no-title-here"], recs.map((m) => m.title).join(" / "));

  // ★ 패치 전 실패: 제목만 바뀌고 본문의 [[rmsync-crash]] 는 그대로라 링크가 깨진다
  const src = byTitle["SQLite 비ASCII 경로 크래시"];
  const target = byTitle["fs.rmSync 비ASCII 크래시"];
  check("링크가 새 슬러그로 재작성됨", src?.body.includes(`[[${target?.slug}]]`), src?.body);
  check("옛 슬러그 참조가 남지 않음", !src?.body.includes("[[rmsync-crash]]"), src?.body);
  check("재작성 결과를 보고", /링크 재작성: 슬러그 변경 \d+건/.test(r.stdout), r.stdout.slice(-500));
  check("깨진 링크 0건으로 확인", /깨진 링크 0건/.test(r.stdout), r.stdout.slice(-500));
  check("이력에 재작성 사유 기록", src?.history.some((h) => /위키링크를 새 슬러그로 재작성/.test(h)), JSON.stringify(src?.history));

  // 재실행해도 멱등이어야 한다 (source 기준 스킵)
  const r2 = run(projects, vault, true);
  check("재실행 멱등", /건너뜀 3건/.test(r2.stdout), r2.stdout.slice(-300));
  check("재실행 후에도 건수 불변", new MemoryStore(new Vault(vault)).loadAll(true).length === recs.length);
}

// ── 9. --project-map 으로 역매핑을 덮어쓴다 (T29 / 감사 N4)
console.log("9) --project-map 수동 지정");
{
  const { projects, vault } = fixture();
  const r = run(projects, vault, true, ["--project-map", "G--Development-MyApp=우리앱"]);
  check("정상 종료", r.status === 0, r.stderr?.slice(0, 300));
  const m = new MemoryStore(new Vault(vault)).loadAll(true).find((x) => x.slug === "user-pref");
  check("지정한 이름이 역매핑을 이김", m?.project === "우리앱", m?.project);
  check("근거를 --project-map 으로 표시", /--project-map 지정/.test(r.stdout), r.stdout.slice(0, 500));

  // 역매핑도 실패하고 지정도 없으면 슬러그를 유지한다(조용한 손실 금지)
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bbm-imp-nomap-"));
  cleanups.push(base);
  const p2 = path.join(base, "projects");
  const v2 = path.join(base, "vault");
  const d2 = path.join(p2, "Z--Unknown-Project", "memory");
  fs.mkdirSync(d2, { recursive: true });
  fs.writeFileSync(path.join(base, ".claude.json"), JSON.stringify({ projects: {} }), "utf-8");
  fs.writeFileSync(path.join(d2, "a.md"), "---\nname: a\ndescription: d\nmetadata:\n  type: project\n---\n\n본문\n", "utf-8");
  const r3 = run(p2, v2, true);
  const m3 = new MemoryStore(new Vault(v2)).loadAll(true)[0];
  check("역매핑 실패 시 슬러그 유지", m3?.project === "Z--Unknown-Project", m3?.project);
  check("실패 사실을 근거로 출력", /역매핑 실패/.test(r3.stdout), r3.stdout.slice(0, 400));
}

for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n실패: ${failures}건`);
  process.exit(1);
}
console.log("\nT20/T28/T29 네이티브 이관 회귀 테스트 통과 ✔");
