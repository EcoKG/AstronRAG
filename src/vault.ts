import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type GrayMatter from "gray-matter";
import { logWarn } from "./log.js";
import type { MemoryRecord, MemoryStatus, MemoryType } from "./types.js";

const requireCjs = createRequire(import.meta.url);
let grayMatter: typeof GrayMatter | undefined;

/** gray-matter 를 처음 파싱·직렬화할 때 불러온다 — 역색인만 읽는 질의·훅 경로가 import 비용(실측 170ms 이상)을 치르지 않게 한다 */
function loadMatter(): typeof GrayMatter {
  return (grayMatter ??= requireCjs("gray-matter") as typeof GrayMatter);
}

/** Windows 예약 장치명 (대소문자 무관) — 파일명 어간으로 쓰면 안 된다 */
const RESERVED_BASENAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const VALID_TYPES: MemoryType[] = ["episodic", "semantic", "procedural", "preference"];
const VALID_STATUS: MemoryStatus[] = ["active", "superseded", "archived"];

/**
 * gray-matter 는 **옵션 없이** 호출되면 파싱 *전에* 원문을 모듈 캐시에 넣는다
 * (node_modules/gray-matter/index.js 의 `if (!options) { ... matter.cache[...] = file }`).
 * 그래서 깨진 파일의 1차 파싱이 예외로 죽어도 캐시에는 빈 file 객체가 남고,
 * 같은 프로세스의 2차 파싱은 그 캐시를 히트해 "빈 frontmatter" 로 조용히 성공한다.
 * 이 레코드가 그대로 디스크에 write 되면 confidence/storage_strength/created/history 가
 * 전부 기본값으로 세탁된다(감사 A2 — 재현 확정).
 *
 * 옵션 객체를 넘기면 캐시 경로 자체를 타지 않으므로 세탁 벡터가 구조적으로 사라진다.
 * (부수 효과: 파일 내용 전체를 키로 쓰는 무제한 캐시의 메모리 누수도 함께 제거)
 */
const MATTER_OPTIONS: Record<string, never> = {};

/**
 * 절단 감지 — 여는 `---` 는 있는데 닫는 `---` 가 없는 파일.
 * gray-matter 는 이 경우 **예외 없이** 파일 전체를 frontmatter 로 보고 body='' 를
 * 돌려주므로(감사 A3), 여기서 막지 않으면 빈 본문이 정상 파일로 고착된다.
 */
function hasClosingDelimiter(raw: string): boolean {
  if (!/^---\r?\n/.test(raw)) return true; // frontmatter 가 없는 파일은 판정 대상 아님
  return /\n---\s*(\r?\n|$)/.test(raw.slice(3));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 원자적 파일 쓰기 — 같은 디렉터리의 임시 파일에 완전히 쓴 뒤 rename 으로 교체한다.
 * rename 은 같은 볼륨 안에서 원자적이므로, 다른 프로세스나 크래시가
 * "반쯤 쓰인 파일" 을 관측하는 창 자체가 사라진다(감사 A3/A8).
 *
 * 기존의 writeFileSync 직접 덮어쓰기는 닫는 `---` 앞에서 잘린 파일을 남길 수 있었고,
 * 그런 파일은 gray-matter 가 예외 없이 body='' 로 읽어 다음 write 가 고착시켰다.
 */
export function writeFileAtomic(fp: string, text: string): void {
  const tmp = `${fp}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    fs.writeFileSync(tmp, text, "utf-8");
    fs.renameSync(tmp, fp);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* 임시 파일 정리 실패는 원 오류를 가리지 않도록 무시 */
    }
    throw err;
  }
}

/**
 * 레코드 클론 — structuredClone 보다 약 30% 빠르다(950건 웜 loadAll 155→108ms 실측).
 * MemoryRecord 가 원시값 + 문자열 배열뿐이라는 전제 위의 최적화다.
 * 중첩 객체 필드를 새로 추가하면 이 함수도 함께 고쳐야 한다 —
 * regress-cache.mjs 2절이 레코드의 **모든 필드를 동적으로 순회**하며 변이 격리를
 * 검사하므로, 빠뜨리면 여기가 아니라 테스트가 먼저 알려준다.
 */
export function cloneRecord(r: MemoryRecord): MemoryRecord {
  return {
    ...r,
    tags: [...r.tags],
    links: [...r.links],
    history: [...r.history],
    derivedFrom: r.derivedFrom ? [...r.derivedFrom] : undefined,
  };
}

/**
 * 이 디렉터리가 **Claude Code 네이티브 메모리 저장소**인지 판별한다.
 *
 * 왜 필요한가 — "네이티브 메모리를 BBM 으로 대체한다" 는 목표에서 사용자가 가장
 * 자연스럽게 취하는 행동이 `BIGBRAIN_VAULT` 를 네이티브 memory 디렉터리로 지정하는
 * 것이다. 그런데 그 경로는 **파괴적**이었다(실측 재현):
 *   1. 네이티브는 평면 구조(`<memory>/*.md`)라 BBM 은 기억을 0건으로 본다
 *   2. `regenerateIndex()` 가 `MEMORY.md` 를 자기 형식으로 **덮어쓴다** —
 *      하필 그 파일이 네이티브가 매 세션 자동 주입하는 인덱스 본체다
 *   3. 경고는 "경로 오타/드라이브 이동 의심" 이라 **오진**이다 (경로는 정확하다)
 *   4. 1회차에 `.bigbrain-vault` 마커가 박히므로 **2회차부터 경고가 사라진다**
 * 이 저장소의 개발 머신에서도 실제로 당했다(2026-07-20, 자동 메모리 인덱스 소실).
 *
 * 판별은 이름이 아니라 **내용**으로 한다: 네이티브 노트는 frontmatter 에
 * `node_type: memory` 와 `originSessionId` 를 갖는다(실측 코퍼스 23/23건).
 * BBM 볼트는 루트에 `.md` 를 MEMORY.md 하나만 두므로 오탐이 구조적으로 없다.
 * 마커 유무를 보지 않는 것이 핵심이다 — 마커는 1회차 사고의 결과물이라,
 * 마커를 신뢰하면 사고가 사고를 은폐한다.
 */
function detectNativeMemoryFiles(root: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(root).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const f of entries) {
    try {
      // 전체 파싱은 낭비다 — frontmatter 머리만 본다
      const head = fs.readFileSync(path.join(root, f), "utf-8").slice(0, 600);
      if (/^---/.test(head) && /^\s*(node_type:\s*memory|originSessionId:)/m.test(head)) found.push(f);
    } catch {
      /* 읽기 실패는 판정 대상 아님 */
    }
  }
  return found.sort();
}

/**
 * 마크다운 볼트(Obsidian 호환)에 대한 저수준 파일 입출력.
 * vault/
 *   memories/  — 활성 기억 (*.md)
 *   archive/   — 망각된 기억 (*.md)
 *   MEMORY.md  — 자동 생성 인덱스
 *   .bbm-index/ — 검색 역색인 캐시 (retriever.ts, 지워도 다음 검색이 다시 만든다)
 */
export class Vault {
  readonly root: string;
  readonly memoriesDir: string;
  readonly archiveDir: string;
  /** 손상 파일 격리소 — 삭제하지 않고 여기로 옮긴다(원본 바이트 보존) */
  readonly quarantineDir: string;
  /**
   * 루트에서 발견된 Claude Code 네이티브 메모리 노트 파일명. 비어 있지 않으면
   * **이 디렉터리는 남의 저장소다** — 인덱스와 마커를 절대 건드리지 않는다.
   * 기동 시 한 번만 판정한다(그 뒤 우리가 만든 파일에 반응하면 안 된다).
   */
  readonly nativeMemoryFiles: string[];

  constructor(root: string, options: { readOnly?: boolean } = {}) {
    this.root = root;
    this.memoriesDir = path.join(root, "memories");
    this.archiveDir = path.join(root, "archive");
    this.quarantineDir = path.join(root, "quarantine");
    // mkdir 보다 **먼저** 판정한다 — 디렉터리를 만들고 나면 판정 근거가 흐려진다
    this.nativeMemoryFiles = detectNativeMemoryFiles(root);
    if (!options.readOnly) {
      fs.mkdirSync(this.memoriesDir, { recursive: true });
      fs.mkdirSync(this.archiveDir, { recursive: true });
    }
  }

  /**
   * 파싱 캐시 (T38) — loadAll 이 질의마다 볼트 전체를 YAML 파싱하던 상수 비용을 없앤다
   * (950건 규모 실측에서 질의당 수백 ms~수 초, RIF 를 고쳐도 이것이 남는다).
   *
   * 키는 파일 경로, 유효성은 (ino, mtimeNs, size) **전부** 일치:
   *   - writeFileAtomic 은 임시 파일 rename 이라 매 쓰기가 새 inode 를 만든다 —
   *     자기 쓰기든 다른 BBM 프로세스의 쓰기든 ino 변화로 반드시 잡힌다.
   *   - Obsidian 등의 제자리 편집은 mtime/size 로 잡힌다 (NTFS·ext4 의 mtime 은
   *     ns 급이라 실질 무결). 알려진 한계: mtime 이 초 단위인 파일시스템(FAT 계열)에서
   *     같은 길이의 제자리 편집이 같은 초 안에 두 번 일어나면 못 본다.
   *   - stat 을 읽기 **전에** 뜬다 — 읽기 후에 뜨면 "옛 내용 + 새 stat" 이 캐시돼
   *     다음 변경까지 낡은 값이 서빙된다. 반대 순서는 최악이 재파싱 1회다.
   *
   * 반환은 항상 구조 클론이다 — reinforce/revise/remember 가 받은 레코드를 변이한 뒤
   * write 하므로, 캐시 원본을 그대로 돌려주면 아직 쓰지 않은 변이가 다음 읽기에 비친다.
   *
   * gray-matter 모듈 캐시(감사 A2)와 다르다: 그쪽은 **예외로 죽은 반쪽 파싱**을 내용
   * 키로 캐시해 세탁 벡터가 됐다. 여기는 성공한 파싱만, 파일 신원 키로 저장하고
   * 실패 경로는 항상 항목을 지운다.
   */
  private readCache = new Map<string, { ino: bigint; mtimeNs: bigint; size: bigint; record: MemoryRecord }>();

  listSlugs(includeArchived = false): { slug: string; archived: boolean }[] {
    const out: { slug: string; archived: boolean }[] = [];
    for (const f of fs.readdirSync(this.memoriesDir)) {
      if (f.endsWith(".md")) out.push({ slug: f.slice(0, -3), archived: false });
    }
    if (includeArchived) {
      for (const f of fs.readdirSync(this.archiveDir)) {
        if (f.endsWith(".md")) out.push({ slug: f.slice(0, -3), archived: true });
      }
    }
    return out;
  }

  filePath(slug: string, archived = false): string {
    return path.join(archived ? this.archiveDir : this.memoriesDir, `${slug}.md`);
  }

  exists(slug: string): boolean {
    return fs.existsSync(this.filePath(slug)) || fs.existsSync(this.filePath(slug, true));
  }

  /**
   * 기억 1건 읽기. 손상 파일은 **예외를 던지지 않고** null 을 반환하고 격리한다 —
   * 파일 1개의 손상이 서버 기동(regenerateIndex→loadAll)이나 전체 회상을
   * 마비시키지 않도록(감사 A1). loadAll/resolve 는 이미 null 을 건너뛴다.
   */
  read(slug: string, archived = false): MemoryRecord | null {
    const fp = this.filePath(slug, archived);
    // stat 하나로 존재 확인과 캐시 유효성 판정을 겸한다 (existsSync 별도 호출 불필요)
    let st: fs.BigIntStats | undefined;
    try {
      st = fs.statSync(fp, { bigint: true, throwIfNoEntry: false });
    } catch {
      st = undefined;
    }
    if (!st) {
      this.readCache.delete(fp);
      return null;
    }
    const hit = this.readCache.get(fp);
    if (hit && hit.ino === st.ino && hit.mtimeNs === st.mtimeNs && hit.size === st.size) {
      return cloneRecord(hit.record);
    }

    let raw: string;
    try {
      raw = fs.readFileSync(fp, "utf-8");
    } catch (err) {
      logWarn(`읽기 실패(건너뜀): ${slug} — ${errText(err)}`);
      this.readCache.delete(fp);
      return null;
    }

    try {
      const { record } = this.parseRawRecord(slug, raw);
      // 캐시에는 클론을 넣는다 — 반환본을 호출부가 변이해도 캐시가 오염되지 않도록
      this.readCache.set(fp, { ino: st.ino, mtimeNs: st.mtimeNs, size: st.size, record: cloneRecord(record) });
      return record;
    } catch (err) {
      this.readCache.delete(fp);
      const reason = !hasClosingDelimiter(raw)
        ? "닫는 frontmatter 구분자(---) 없음 — 쓰기 중 절단 의심"
        : `frontmatter 파싱 실패: ${errText(err)}`;
      this.quarantine(slug, archived, reason);
      return null;
    }
  }

  /** Markdown 원문을 파일 변경 없이 기억 레코드로 파싱한다. */
  parseRawRecord(slug: string, raw: string): { record: MemoryRecord; hasExplicitId: boolean } {
    if (raw.trim() === "") throw new Error("빈 파일");
    if (!hasClosingDelimiter(raw)) throw new Error("닫는 frontmatter 구분자(---) 없음 — 쓰기 중 절단 의심");
    const { data, content } = loadMatter()(raw, MATTER_OPTIONS);
    return {
      record: this.fromFrontmatter(slug, data, content.trim()),
      hasExplicitId: typeof data.id === "string" && data.id.length > 0,
    };
  }

  /**
   * 손상 파일을 quarantine/ 으로 **이동**한다(삭제 아님, 원본 바이트 그대로).
   * 격리에 실패해도 던지지 않는다 — 읽기 경로가 죽으면 A1 이 재발한다.
   */
  private quarantine(slug: string, archived: boolean, reason: string): void {
    const from = this.filePath(slug, archived);
    try {
      fs.mkdirSync(this.quarantineDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const to = path.join(this.quarantineDir, `${slug}.${stamp}.md`);
      fs.renameSync(from, to);
      logWarn(`손상 파일 격리: ${slug} — ${reason} → ${to}`);
    } catch (err) {
      logWarn(`손상 파일 격리 실패(건너뜀): ${slug} — ${reason} / ${errText(err)}`);
    }
  }

  /** slug를 memories/ → archive/ 순으로 찾는다 */
  find(slug: string): { record: MemoryRecord; archived: boolean } | null {
    const active = this.read(slug, false);
    if (active) return { record: active, archived: false };
    const archived = this.read(slug, true);
    if (archived) return { record: archived, archived: true };
    return null;
  }

  write(record: MemoryRecord, archived = false): void {
    const fp = this.filePath(record.slug, archived);
    writeFileAtomic(fp, this.serialize(record));
    // 새 inode 라 어차피 미스지만, 명시적으로 지워 어떤 파일시스템에서도 낡은 항목이 남지 않게 한다
    this.readCache.delete(fp);
  }

  /** 레코드를 frontmatter + 본문 마크다운 문자열로 직렬화 (slug 와 무관 — slug 는 파일명) */
  private serialize(record: MemoryRecord): string {
    const fm: Record<string, unknown> = {
      id: record.id,
      title: record.title,
      description: record.description,
      type: record.type,
      tags: record.tags,
      confidence: record.confidence,
      storage_strength: Number(record.storageStrength.toFixed(3)),
      status: record.status,
      created: record.created,
      updated: record.updated,
      last_accessed: record.lastAccessed,
      last_reinforced: record.lastReinforced,
      access_count: record.accessCount,
      links: record.links,
      history: record.history,
    };
    if (record.source) fm.source = record.source;
    if (record.project) fm.project = record.project;
    if (record.supersedes) fm.supersedes = record.supersedes;
    // 공고화 출처는 frontmatter 에 둔다 — 본문에만 적으면 revise 한 번에 사라져
    // 파생물이 손으로 쓴 단정문과 구별되지 않는다(출처혼동의 인공 버전, P8)
    if (record.derivedFrom && record.derivedFrom.length > 0) fm.derived_from = record.derivedFrom;
    if (record.reviewAfter) fm.review_after = record.reviewAfter;
    if (record.supersededBy) fm.superseded_by = record.supersededBy;
    if (record.archiveReason) fm.archive_reason = record.archiveReason;
    return loadMatter().stringify(`\n${record.body}\n`, fm);
  }

  /**
   * 신규 기억을 **원자적으로 생성**한다. 사용된 최종 slug 를 반환하고 record.slug 도 갱신한다.
   *
   * makeSlug 의 exists() 검사와 write 사이에는 유사기억 탐지를 위한 전체 볼트 재독이 끼어
   * 창이 넓었고, write 가 배타 플래그 없는 writeFileSync 라 두 프로세스가 같은 제목을
   * 동시에 remember 하면 같은 slug 를 배정받아 나중 write 가 앞 기억을 통째로 덮었다
   * (감사 A5 — 양쪽 다 성공 응답을 받는데 파일은 1개, 패자는 무흔적 소실).
   *
   * flag:'wx' 는 "파일이 이미 있으면 실패" 를 OS 수준에서 보장하므로,
   * EEXIST 면 다음 접미(-2, -3 …)로 재시도해 두 기억이 모두 살아남는다.
   */
  createNew(record: MemoryRecord): string {
    const text = this.serialize(record); // 내용은 slug 와 무관하므로 한 번만 만든다
    const base = record.slug;
    for (let n = 1; n < 1000; n++) {
      const slug = n === 1 ? base : `${base}-${n}`;
      // archive/ 에 같은 이름이 있으면 망각된 기억이 되살아난 것처럼 보이므로 건너뛴다
      if (fs.existsSync(this.filePath(slug, true))) continue;
      if (this.tryCreateExclusive(this.filePath(slug, false), text)) {
        record.slug = slug;
        return slug;
      }
    }
    throw new Error(`slug 확보 실패 (1000회 시도): ${base}`);
  }

  /**
   * 대상 경로에 파일을 **원자적으로 생성**한다. 이미 있으면 false (덮어쓰지 않는다).
   * 임시 파일에 내용을 다 쓴 뒤 linkSync 로 거는 이유: rename 은 대상을 덮어쓰므로
   * 배타성을 잃고, 반대로 flag:'wx' 로 대상에 직접 쓰면 "빈 파일 → 내용" 사이의
   * 창에 다른 프로세스가 읽어 절단 파일로 오인(격리)할 수 있다. link 는 대상이
   * 이미 있으면 EEXIST 로 실패하므로 배타성과 내용 완전성을 동시에 만족한다.
   */
  private tryCreateExclusive(fp: string, text: string): boolean {
    const tmp = `${fp}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tmp, text, { encoding: "utf-8", flag: "wx" });
    try {
      fs.linkSync(tmp, fp);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 임시 파일 정리 실패는 무시 */
      }
    }
  }

  /**
   * revise 로 덮어쓰기 **전에** 현재 파일을 스냅샷으로 남긴다 (감사 A7).
   *
   * revise 는 본문을 즉시 덮어쓰고 history 에 reason 한 줄만 남겨서, AI 가 환각으로
   * 옳은 기억을 "정정" 하면 원본 지식이 영구 소실됐다. 서버 instructions 가 중복 발견 시
   * revise 를 권장하므로 파괴적 경로가 기본값이었다.
   *
   * 스냅샷은 archive/revisions/ 에 두되 slug 당 최근 N 세대만 유지한다.
   * listSlugs 는 archive/ 를 재귀 탐색하지 않으므로 기억 목록에 섞이지 않는다.
   */
  snapshotRevision(slug: string, archived: boolean, keep = 3): void {
    const from = this.filePath(slug, archived);
    if (!fs.existsSync(from)) return;
    try {
      const dir = path.join(this.archiveDir, "revisions");
      fs.mkdirSync(dir, { recursive: true });
      // 같은 밀리초에 두 번 교정되면 파일명이 겹쳐 앞 세대를 덮어쓰므로 접미로 회피
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      let target = path.join(dir, `${slug}.${stamp}.md`);
      for (let n = 2; fs.existsSync(target) && n < 100; n++) {
        target = path.join(dir, `${slug}.${stamp}-${n}.md`);
      }
      fs.copyFileSync(from, target);

      // 세대 상한 — 파일명의 타임스탬프가 사전순 = 시간순이라 정렬로 오래된 것부터 제거
      const mine = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(`${slug}.`) && f.endsWith(".md"))
        .sort();
      for (const f of mine.slice(0, Math.max(0, mine.length - keep))) {
        fs.unlinkSync(path.join(dir, f));
      }
    } catch (err) {
      // 스냅샷 실패가 교정 자체를 막지는 않는다 — 경고만 남긴다
      logWarn(`교정 전 스냅샷 실패(계속 진행): ${slug} — ${errText(err)}`);
    }
  }

  /** 활성 기억을 archive/로 이동 */
  moveToArchive(slug: string): void {
    const from = this.filePath(slug, false);
    const to = this.filePath(slug, true);
    if (fs.existsSync(from)) {
      fs.renameSync(from, to);
      this.readCache.delete(from);
      this.readCache.delete(to); // 같은 자리에 이전 세대가 캐시돼 있었을 수 있다
    }
  }

  /**
   * 인덱스는 **내용이 실제로 달라졌을 때만** 쓴다 (감사 B).
   * 예전에는 본문에 생성 시각을 박아 내용이 같아도 매번 바이트가 달라졌고,
   * 서버 기동 시마다 호출되므로 MCP 클라이언트를 켜기만 해도 diff 가 생겼다.
   */
  writeIndex(markdown: string): void {
    // 네이티브 메모리 디렉터리를 볼트로 지정한 경우 — 인덱스도 마커도 건드리지 않는다.
    // 여기서 쓰면 네이티브가 **매 세션 자동 주입하는 인덱스 본체**가 파괴된다.
    // 조용히 건너뛰는 게 아니라, index.ts 가 이 상태를 경고로 크게 알린다.
    if (this.nativeMemoryFiles.length > 0) return;
    const fp = path.join(this.root, "MEMORY.md");
    try {
      if (fs.existsSync(fp) && fs.readFileSync(fp, "utf-8") === markdown) {
        this.markVault();
        return;
      }
    } catch {
      /* 비교 실패 시에는 그냥 쓴다 */
    }
    writeFileAtomic(fp, markdown);
    this.markVault();
  }

  /**
   * 이 디렉터리가 BigBrainMemory 볼트임을 표시한다 (감사 E3).
   * 경로 오타로 엉뚱한 곳을 가리켜도 mkdirSync 가 조용히 빈 볼트를 만들어버려
   * "기억 전무" 가 정상처럼 보였다. 마커가 있으면 "진짜 빈 볼트" 와
   * "잘못된 경로에 새로 생긴 볼트" 를 구분할 수 있다.
   */
  private markVault(): void {
    const marker = path.join(this.root, ".bigbrain-vault");
    try {
      if (!fs.existsSync(marker)) {
        fs.writeFileSync(marker, `BigBrainMemory vault\ncreated: ${new Date().toISOString()}\n`, "utf-8");
      }
    } catch {
      /* 마커는 진단용 편의 기능 — 실패해도 무시 */
    }
  }

  /** 볼트 상태 진단 — 기동 로그와 경고에 쓴다 (E3) */
  inspect(): { memories: number; archived: number; quarantined: number; hasMarker: boolean } {
    const count = (dir: string) => {
      try {
        return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length;
      } catch {
        return 0;
      }
    };
    return {
      memories: count(this.memoriesDir),
      archived: count(this.archiveDir),
      quarantined: count(this.quarantineDir),
      hasMarker: fs.existsSync(path.join(this.root, ".bigbrain-vault")),
    };
  }

  /** 제목에서 Windows/Obsidian 호환 파일명 slug 생성 (한글 등 유니코드 유지) */
  makeSlug(title: string): string {
    let base = title
      .trim()
      .replace(/[\\/:*?"<>|#^[\]{}]/g, "")
      .replace(/\s+/g, "-")
      .toLowerCase()
      .slice(0, 80);
    // 끝의 마침표·공백 제거 — 확장자가 붙어 실해는 없지만 외부 도구가 정규화할 수 있다
    base = base.replace(/[. ]+$/, "");
    if (!base) base = "memory";
    // Windows 예약 장치명 회피 (감사 F3). 현재 Win11+Node22 에서는 con.md 도 정상
    // 생성되지만, 구형 Windows·네트워크 드라이브·백업 도구는 이를 장치로 취급해
    // slug 와 실제 파일명이 어긋날 수 있다. 방어 비용이 0 에 가까우므로 선제 회피한다.
    if (RESERVED_BASENAMES.test(base)) base = `${base}_`;
    let slug = base;
    let n = 2;
    while (this.exists(slug)) {
      slug = `${base}-${n++}`;
    }
    return slug;
  }

  private fromFrontmatter(slug: string, data: Record<string, unknown>, body: string): MemoryRecord {
    // js-yaml 은 **인용부호 없는** 타임스탬프(created: 2025-01-01, 또는 ISO 형태)를
    // Date 인스턴스로 파싱한다. Obsidian 이나 손편집에서 흔한 형태인데,
    // 문자열만 통과시키면 created/updated/lastAccessed/lastReinforced 가 전부
    // 기본값(=지금)으로 리셋돼 오래된 기억의 기저활성이 부풀고(실측 −2.96 → +3.84),
    // 다음 write 가 그 잘못된 값을 고착시켰다(감사 A6).
    const str = (v: unknown, dflt = ""): string => {
      if (typeof v === "string") return v;
      if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
      return dflt;
    };
    const num = (v: unknown, dflt: number): number => (typeof v === "number" && Number.isFinite(v) ? v : dflt);
    const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
    const type = VALID_TYPES.includes(data.type as MemoryType) ? (data.type as MemoryType) : "semantic";
    const status = VALID_STATUS.includes(data.status as MemoryStatus) ? (data.status as MemoryStatus) : "active";
    const now = new Date().toISOString();
    const created = str(data.created, now);
    return {
      id: str(data.id, `mem-${slug}`),
      slug,
      title: str(data.title, slug),
      description: str(data.description),
      type,
      tags: arr(data.tags),
      confidence: Math.min(1, Math.max(0, num(data.confidence, 0.7))),
      // 구버전 노트 호환: storage_strength 없으면 access_count(≥1)로 근사
      storageStrength: Math.max(1, num(data.storage_strength, Math.max(1, num(data.access_count, 1)))),
      status,
      created,
      updated: str(data.updated, now),
      lastAccessed: str(data.last_accessed, now),
      lastReinforced: str(data.last_reinforced, created),
      accessCount: num(data.access_count, 0),
      source: str(data.source) || undefined,
      // 구버전 노트에는 없는 필드 — 없으면 전역 기억으로 취급한다(하위 호환)
      project: str(data.project) || undefined,
      links: arr(data.links),
      derivedFrom: arr(data.derived_from).length > 0 ? arr(data.derived_from) : undefined,
      // 인용부호 없는 날짜는 Date 로 파싱돼 ISO 문자열이 되므로 앞 10자(YYYY-MM-DD)만 쓴다
      reviewAfter: str(data.review_after).slice(0, 10) || undefined,
      supersedes: str(data.supersedes) || undefined,
      supersededBy: str(data.superseded_by) || undefined,
      archiveReason: str(data.archive_reason) || undefined,
      history: arr(data.history),
      body,
    };
  }
}
