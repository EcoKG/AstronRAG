#!/usr/bin/env node
// Claude Code 네이티브 프로젝트 메모리를 AstronRAG 볼트로 이관한다.
//
// 네이티브는 프로젝트별로 저장소가 갈리고(~/.claude/projects/<슬러그>/memory/*.md)
// 분류 체계도 다르다(user/feedback/project/reference vs episodic/semantic/procedural/preference).
// 수작업 이관은 타입이 임의로 배정돼 type 필터 회상의 정밀도를 깎으므로, 매핑 규칙을
// 고정하고 멱등하게 만든다.
//
// 사용법:
//   node scripts/import-native.mjs                 # 미리보기 (아무것도 쓰지 않음)
//   node scripts/import-native.mjs --apply         # 실제 이관
//   node scripts/import-native.mjs --apply --vault D:/vault --projects-dir /경로
//
// 안전 기본값: --apply 없이는 **쓰지 않는다**. 무엇이 어떤 타입으로 들어갈지 먼저 보여준다.
// 멱등: 같은 원본 파일에서 온 기억이 이미 있으면(source 일치) 건너뛴다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { readEnv } from "./lib/env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const APPLY = process.argv.includes("--apply");
const HOME = process.env.USERPROFILE || process.env.HOME || "";
const PROJECTS_DIR = arg("--projects-dir", path.join(HOME, ".claude", "projects"));
const VAULT = arg("--vault", readEnv("ASTRONRAG_VAULT", "BIGBRAIN_VAULT") || path.join(repo, "vault"));
/** `--config <경로>` — 프로젝트명 역매핑에 쓸 ~/.claude.json (테스트 주입용) */
const CONFIG = arg("--config", path.join(HOME, ".claude.json"));

/** `--project-map <슬러그>=<이름>` (반복 가능) — 역매핑을 사람이 덮어쓴다 */
const PROJECT_MAP = (() => {
  const map = new Map();
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== "--project-map" || !process.argv[i + 1]) continue;
    const eq = process.argv[i + 1].indexOf("=");
    if (eq > 0) map.set(process.argv[i + 1].slice(0, eq), process.argv[i + 1].slice(eq + 1));
  }
  return map;
})();

/**
 * 네이티브 프로젝트 슬러그 → 사람이 읽는 프로젝트명.
 *
 * 슬러그는 실제 경로에서 영숫자가 아닌 문자를 전부 `-` 로 바꾼 것이라
 * (`D:\AstronRAG` → `D--AstronRAG`) 문자열만으로는 되돌릴 수 없다.
 * 하이픈이 경로 구분자이자 이름 문자를 겸하기 때문이다 —
 * `E--Project-Go-reversproxy` 가 `Project-Go-reversproxy` 인지 `reversproxy` 인지
 * 알 방법이 없고, 한글 디렉터리는 통째로 `-------` 로 뭉개져 정보가 아예 없다.
 *
 * 대신 **역매핑**한다: `~/.claude.json` 의 `projects` 키는 실제 절대경로이므로,
 * 같은 규칙으로 뭉갠 값이 슬러그와 일치하는 경로를 찾으면 basename 이 진짜 이름이다.
 * 실측(이 머신 10개 프로젝트): 9개가 정확 복원되고 공백·한글 이름까지 살아난다
 * (`공유폴더 에브리띵`, `Discord CLI bot`). 여러 경로가 걸리는 경우는 `D:\x` 와
 * `D:/x` 처럼 표기만 다른 같은 디렉터리라 basename 이 하나로 모인다 — 실측 10/10.
 * basename 이 갈리면 모호하므로 포기하고 슬러그를 그대로 쓴다.
 */
function buildProjectNameResolver(configPath) {
  let keys = Object.keys({});
  try {
    keys = Object.keys(JSON.parse(fs.readFileSync(configPath, "utf-8"))?.projects ?? {});
  } catch {
    /* 설정을 못 읽으면 역매핑 없이 슬러그를 그대로 쓴다 */
  }
  const mangle = (p) => p.replace(/[^A-Za-z0-9]/g, "-");
  const bySlug = new Map();
  for (const k of keys) {
    const base = path.basename(k.replace(/[\\/]+$/, ""));
    if (!base) continue;
    const s = mangle(k);
    if (!bySlug.has(s)) bySlug.set(s, new Set());
    bySlug.get(s).add(base);
  }
  return (slug) => {
    if (PROJECT_MAP.has(slug)) return { name: PROJECT_MAP.get(slug), how: "--project-map 지정" };
    const bases = bySlug.get(slug);
    if (bases?.size === 1) return { name: [...bases][0], how: "~/.claude.json 경로 역매핑" };
    if (bases && bases.size > 1) {
      return { name: slug, how: `모호함(basename ${bases.size}종) — 슬러그 유지, --project-map 로 지정 가능` };
    }
    return { name: slug, how: "역매핑 실패 — 슬러그 유지, --project-map 로 지정 가능" };
  };
}
const resolveProjectName = buildProjectNameResolver(CONFIG);

/**
 * 네이티브 `MEMORY.md` 에서 `- [사람이 읽는 제목](파일.md)` 을 파싱해 파일명→제목 맵을 만든다.
 *
 * 왜 필요한가 — 노트의 `name:` 필드는 **슬러그**(`toast-notify-deliverable`)이고,
 * 사람이 읽는 제목(`ToastNotify deliverable`)은 인덱스에만 있다. 제목을 슬러그로
 * 들여오면 BBM 의 주입 채널이 그대로 보여주므로 인덱스 가독성이 통째로 떨어진다.
 */
function nativeTitles(memDir) {
  const map = new Map();
  try {
    const md = fs.readFileSync(path.join(memDir, "MEMORY.md"), "utf-8");
    for (const m of md.matchAll(/^\s*[-*]\s*\[([^\]]+)\]\(([^)]+\.md)\)/gm)) {
      map.set(path.basename(m[2].trim()), m[1].trim());
    }
  } catch {
    /* 인덱스가 없거나 형식이 다르면 폴백(fm.name) 을 쓴다 */
  }
  return map;
}

/**
 * 네이티브 타입 → BBM 타입 매핑.
 * 두 체계가 1:1 이 아니라서 일부는 본문을 보고 갈라야 한다 — 판단 근거를 항상 출력해
 * 사람이 확인·정정할 수 있게 한다.
 */
function mapType(nativeType, body, name) {
  const t = (nativeType || "").toLowerCase();
  if (t === "user") return { type: "preference", why: "user = 사용자 정체·선호" };
  if (t === "feedback") {
    // "How to apply:" / "적용" 같은 실행 지침이 있으면 절차, 아니면 취향
    return /how to apply|적용 방법|적용:|하도록|할 것/i.test(body)
      ? { type: "procedural", why: "feedback + 실행 지침 문구" }
      : { type: "preference", why: "feedback + 취향 서술" };
  }
  if (t === "project") {
    // 특정 시점의 사건·결정이면 일화, 지속적 사실·구조면 의미
    return /\d{4}-\d{2}-\d{2}|했다|였다|결정했|하기로/.test(body)
      ? { type: "episodic", why: "project + 시점/사건 표현" }
      : { type: "semantic", why: "project + 지속적 사실" };
  }
  if (t === "reference") return { type: "procedural", why: "reference = 참조 절차·자료" };
  return { type: "semantic", why: `알 수 없는 타입(${nativeType || "없음"}) → 기본값` };
}

/** ~/.claude/projects/<슬러그>/memory/*.md 를 수집 (인덱스 MEMORY.md 제외) */
function collect(projectsDir) {
  const out = /** @type {Array<{ project: string; file: string }>} */ (Array());
  if (!fs.existsSync(projectsDir)) return out;
  for (const proj of fs.readdirSync(projectsDir)) {
    const memDir = path.join(projectsDir, proj, "memory");
    if (!fs.existsSync(memDir)) continue;
    for (const f of fs.readdirSync(memDir)) {
      if (!f.endsWith(".md") || f === "MEMORY.md") continue;
      out.push({ project: proj, file: path.join(memDir, f) });
    }
  }
  return out;
}

const found = collect(PROJECTS_DIR);
console.log(`네이티브 메모리 스캔: ${PROJECTS_DIR}`);
console.log(`  대상 ${found.length}건 / 볼트 ${VAULT}`);
console.log(APPLY ? "  모드: 실제 이관(--apply)\n" : "  모드: 미리보기 — 아무것도 쓰지 않습니다. 실제 이관은 --apply\n");

if (found.length === 0) {
  console.log("이관할 파일이 없습니다.");
  process.exit(0);
}

const { Vault } = await import(`file://${path.join(repo, "dist", "vault.js").replace(/\\/g, "/")}`);
const { MemoryStore } = await import(`file://${path.join(repo, "dist", "store.js").replace(/\\/g, "/")}`);
const store = new MemoryStore(new Vault(VAULT));

// 멱등성: 이미 같은 원본에서 온 기억이 있으면 건너뛴다
const existingSources = new Set(
  store
    .loadAll(true)
    .map((m) => m.source)
    .filter(Boolean),
);

let imported = 0;
let skipped = 0;
let failed = 0;

/** 프로젝트별 `파일명 → 사람이 읽는 제목` (네이티브 MEMORY.md 에서 복원) */
const titlesByProject = new Map();
for (const { project, file } of found) {
  if (!titlesByProject.has(project)) titlesByProject.set(project, nativeTitles(path.dirname(file)));
}
/** `원본 name → 실제 확정된 slug`. 링크 재작성 패스가 쓴다. */
const renamed = new Map();

for (const { project, file } of found) {
  const rel = path.basename(file);
  let parsed;
  try {
    parsed = matter(fs.readFileSync(file, "utf-8"), {});
  } catch (err) {
    console.log(`  ✘ ${project}/${rel} — frontmatter 파싱 실패: ${err.message}`);
    failed++;
    continue;
  }
  const fm = parsed.data ?? {};
  const body = (parsed.content ?? "").trim();
  const name = String(fm.name || rel.replace(/\.md$/, ""));
  const source = `native:${project}/${rel}`;

  if (existingSources.has(source)) {
    console.log(`  · ${project}/${rel} — 이미 이관됨(건너뜀)`);
    skipped++;
    continue;
  }
  if (!body) {
    console.log(`  ✘ ${project}/${rel} — 본문이 비어 있음(건너뜀)`);
    failed++;
    continue;
  }

  const nativeType = fm.metadata?.type ?? fm.type;
  const { type, why } = mapType(nativeType, body, name);
  const description = String(fm.description || body.split("\n")[0].slice(0, 120));
  // 사람이 읽는 제목은 인덱스에만 있다 — 없으면 슬러그(name) 로 폴백
  const title = titlesByProject.get(project)?.get(rel) ?? name;
  const { name: projectName, how: projectHow } = resolveProjectName(project);

  console.log(`  + ${project}/${rel}`);
  console.log(`      제목: ${title}${title === name ? "" : `   (원본 name: ${name})`}`);
  console.log(`      타입: ${nativeType || "(없음)"} → ${type}  (${why})`);
  console.log(`      스코프: project=${projectName}  (${projectHow})`);

  if (!APPLY) {
    imported++;
    continue;
  }
  try {
    const { record, similar } = store.remember({
      title,
      description,
      content: body,
      type,
      project: projectName,
      source,
      tags: ["native-import"],
    });
    // 제목을 바꾸면 slug 도 바뀐다 — 노트끼리 걸어둔 [[원본name]] 이 깨지므로
    // 전부 저장한 뒤 후처리로 치환한다(아래 링크 재작성 패스).
    renamed.set(name, record.slug);
    if (similar.length > 0) {
      console.log(`      ⚠ 유사 기억 ${similar.length}건: ${similar.map((m) => m.slug).join(", ")} — 나중에 consolidate 로 정리 권장`);
    }
    if (record.slug !== name) console.log(`      슬러그: ${record.slug}`);
    imported++;
  } catch (err) {
    console.log(`      ✘ 저장 실패: ${err.message}`);
    failed++;
  }
}

// ── 링크 재작성 패스
//
// 네이티브 노트는 서로를 `[[<name>]]`(= 슬러그)로 가리킨다. 제목을 사람이 읽는 형태로
// 복원하면 BBM 의 slug 는 제목에서 파생되므로 그 참조가 전부 허공을 가리키게 된다.
// 예측이 아니라 **실제로 확정된 slug** 로 치환한다 — 동명 충돌로 `-2` 가 붙어도 정확하다.
// 전부 저장한 뒤에 도는 이유도 그것이다(앞 노트가 뒤 노트를 가리킬 수 있다).
if (APPLY && renamed.size > 0) {
  const changed = [...renamed].filter(([from, to]) => from !== to);
  if (changed.length > 0) {
    let rewritten = 0;
    for (const m of store.loadAll().filter((x) => x.tags?.includes("native-import"))) {
      let body = m.body;
      for (const [from, to] of changed) {
        body = body.replaceAll(`[[${from}]]`, `[[${to}]]`).replaceAll(`[[memories/${from}]]`, `[[${to}]]`);
      }
      if (body === m.body) continue;
      try {
        store.revise(m.slug, { content: body, reason: "이관 시 위키링크를 새 슬러그로 재작성" });
        rewritten++;
      } catch (err) {
        console.log(`  ✘ 링크 재작성 실패: ${m.slug} — ${err.message}`);
        failed++;
      }
    }
    console.log("");
    console.log(`링크 재작성: 슬러그 변경 ${changed.length}건 → 본문 ${rewritten}건 갱신`);
    const dangling = store.reflect().danglingLinks;
    if (dangling.length > 0) {
      console.log(`  ⚠ 아직 깨진 링크 ${dangling.length}건: ${dangling.map((d) => `${d.slug}→${d.targets.join(",")}`).join(" / ")}`);
      console.log(`     (원본에 없던 대상을 가리키던 링크일 수 있습니다 — reflect 의 broken_links 로 확인하세요)`);
    } else {
      console.log(`  깨진 링크 0건 — 전부 해소됐습니다.`);
    }
  }
}

console.log("");
console.log(APPLY ? `이관 ${imported}건 / 건너뜀 ${skipped}건 / 실패 ${failed}건` : `이관 예정 ${imported}건 / 건너뜀 ${skipped}건 / 실패 ${failed}건`);
if (!APPLY && imported > 0) console.log("실제로 이관하려면 --apply 를 붙여 다시 실행하세요.");
if (APPLY && imported > 0) {
  console.log("");
  console.log("이관 후 권장: 원본을 지우지 말고 아카이브해 두고,");
  console.log("네이티브 memory/MEMORY.md 는 'recall 로 조회' 안내로 바꿔 브리지로 남기세요(README 참조).");
}
process.exit(failed > 0 ? 1 : 0);
