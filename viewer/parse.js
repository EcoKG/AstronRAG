// 볼트 마크다운을 기억 레코드로 해석하고 본문을 안전한 HTML 로 렌더하는 순수 함수 모음(브라우저·Node vm 공용).
// @ts-nocheck
(function () {
	"use strict";

	const TYPES = ["episodic", "semantic", "procedural", "preference"];
	const STATUSES = ["active", "superseded", "archived"];

	/** HTML 특수문자를 엔티티로 바꾼다. */
	function esc(s) {
		return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
	}

	/** esc 로 만든 엔티티를 원래 문자로 되돌린다. */
	function unesc(s) {
		return s.replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[e]));
	}

	// ── YAML frontmatter (볼트가 쓰는 부분집합) ─────────────────────────────────
	const indentOf = (l) => l.length - l.trimStart().length;
	const isBlank = (l) => l.trim() === "";

	/** YAML 큰따옴표 문자열의 이스케이프를 푼다. */
	function unescapeDouble(s) {
		const simple = { "0": "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b", " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\x85", _: "\xa0", L: "\u2028", P: "\u2029" };
		return s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/g, (m, e) => {
			if (e.length > 1) return String.fromCodePoint(parseInt(e.slice(1), 16));
			return e in simple ? simple[e] : m;
		});
	}

	/** 쉼표로 구분된 flow 시퀀스 항목을 따옴표를 존중하며 나눈다. */
	function splitFlow(s) {
		const out = [];
		let cur = "", q = "";
		for (let i = 0; i < s.length; i++) {
			const c = s[i];
			if (q) {
				cur += c;
				if (c === "\\" && q === '"') { cur += s[++i] || ""; continue; }
				if (c === q) {
					if (q === "'" && s[i + 1] === "'") { cur += s[++i]; continue; }
					q = "";
				}
			} else if (c === "'" || c === '"') { q = c; cur += c; }
			else if (c === ",") { out.push(cur); cur = ""; }
			else cur += c;
		}
		if (cur.trim()) out.push(cur);
		return out.map((x) => x.trim()).filter((x) => x !== "");
	}

	/** 한 줄짜리 YAML 스칼라를 JS 값으로 바꾼다(타임스탬프는 ISO 문자열). */
	function parseScalar(raw) {
		const s = raw.trim();
		if (s === "" || s === "~" || s === "null" || s === "Null" || s === "NULL") return null;
		if (s[0] === "'") return s.slice(1, s.endsWith("'") && s.length > 1 ? -1 : undefined).replace(/''/g, "'");
		if (s[0] === '"') return unescapeDouble(s.slice(1, s.endsWith('"') && s.length > 1 ? -1 : undefined));
		if (s[0] === "[" && s.endsWith("]")) return splitFlow(s.slice(1, -1)).map(parseScalar);
		const v = s.replace(/\s+#.*$/, "");
		if (/^(true|True|TRUE)$/.test(v)) return true;
		if (/^(false|False|FALSE)$/.test(v)) return false;
		if (/^[-+]?(\d[\d_]*\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v)) return Number(v.replace(/_/g, ""));
		const ts = /^(\d{4}-\d\d?-\d\d?)(?:[Tt ]+(\d\d?:\d\d:\d\d(?:\.\d+)?)\s*(Z|[-+]\d\d?(?::?\d\d)?)?)?$/.exec(v);
		if (ts) {
			const [, day, time, zone] = ts;
			const [y, mo, d] = day.split("-");
			let iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
			if (time) {
				const z = !zone ? "Z" : zone === "Z" ? "Z" : zone.replace(/^([-+])(\d)(?!\d)/, "$10$2").replace(/^([-+]\d\d)(\d\d)$/, "$1:$2").replace(/^([-+]\d\d)$/, "$1:00");
				iso += "T" + time.padStart(8, "0") + z;
			}
			const dt = new Date(iso);
			if (!Number.isNaN(dt.getTime())) return dt.toISOString();
		}
		return v;
	}

	/** `|`·`>` 블록 스칼라 본문을 들여쓰기·접기·chomping 규칙대로 조립한다. */
	function blockScalar(header, lines) {
		const folded = header[0] === ">";
		const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip";
		let end = lines.length;
		while (end > 0 && isBlank(lines[end - 1])) end--;
		const trailing = lines.length - end;
		const body = lines.slice(0, end);
		const first = body.find((l) => !isBlank(l));
		if (first === undefined) return chomp === "keep" ? "\n".repeat(trailing) : "";
		const ind = indentOf(first);
		const content = body.map((l) => (isBlank(l) ? "" : l.slice(Math.min(ind, indentOf(l)))));
		let text;
		if (!folded) text = content.join("\n");
		else {
			text = "";
			let started = false, prevMore = false, blanks = 0;
			for (const l of content) {
				if (l === "") { blanks++; continue; }
				const more = /^\s/.test(l);
				if (!started) text = "\n".repeat(blanks) + l;
				else if (!more && !prevMore) text += (blanks ? "\n".repeat(blanks) : " ") + l;
				else text += "\n".repeat(blanks + 1) + l;
				started = true; prevMore = more; blanks = 0;
			}
		}
		if (chomp === "strip") return text;
		if (chomp === "keep") return text + "\n".repeat(trailing + 1);
		return text + "\n";
	}

	/** 키 뒤의 값(같은 줄 나머지 + 딸린 줄)을 해석한다. */
	function parseValue(rest, child) {
		const r = rest.trim();
		if (/^[|>][-+0-9]*(\s+#.*)?$/.test(r)) return blockScalar(r, child);
		const nonBlank = child.filter((l) => !isBlank(l));
		if (r === "") {
			if (!nonBlank.length) return null;
			if (/^-(\s|$)/.test(nonBlank[0].trimStart())) return parseSeq(child);
			return parseScalar(nonBlank.map((l) => l.trim()).join(" "));
		}
		if (!nonBlank.length) return parseScalar(r);
		return parseScalar([r, ...nonBlank.map((l) => l.trim())].join(" "));
	}

	/** 블록 시퀀스(`- 항목`)를 배열로 바꾼다. 항목 안의 블록 스칼라도 다룬다. */
	function parseSeq(lines) {
		const first = lines.find((l) => !isBlank(l));
		const ind = indentOf(first);
		const out = [];
		let i = 0;
		while (i < lines.length) {
			const l = lines[i];
			if (isBlank(l) || indentOf(l) !== ind || !/^-(\s|$)/.test(l.trimStart())) { i++; continue; }
			const rest = l.trimStart().slice(1);
			i++;
			const child = [];
			while (i < lines.length && (isBlank(lines[i]) || indentOf(lines[i]) > ind)) child.push(lines[i++]);
			out.push(parseValue(rest, child));
		}
		return out;
	}

	/** 최상위 `key: value` 매핑으로 된 frontmatter 를 객체로 바꾼다. */
	function parseYaml(src) {
		const lines = src.split("\n");
		const out = {};
		let i = 0;
		while (i < lines.length) {
			const m = /^([A-Za-z_][\w-]*)\s*:(?:\s(.*))?$/.exec(lines[i]);
			i++;
			if (!m) continue;
			const child = [];
			while (i < lines.length && (isBlank(lines[i]) || /^\s/.test(lines[i]) || /^-(\s|$)/.test(lines[i]))) child.push(lines[i++]);
			out[m[1]] = parseValue(m[2] || "", child);
		}
		return out;
	}

	/** 원문을 frontmatter 객체와 본문으로 나눈다. 닫는 구분자가 없으면 null. */
	function splitFrontmatter(text) {
		const src = String(text).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
		if (!/^---[ \t]*\n/.test(src)) return { data: {}, body: src };
		const m = /^---[ \t]*\n([\s\S]*?\n)?---[ \t]*(?:\n|$)([\s\S]*)$/.exec(src);
		if (!m) return null;
		return { data: parseYaml(m[1] || ""), body: m[2] };
	}

	// ── 레코드 정규화 (src/vault.ts fromFrontmatter 와 같은 기본값) ─────────────
	/** frontmatter(또는 JSON 레코드)를 뷰어 레코드로 정규화한다. */
	function normalize(data, slug, archived) {
		const g = (a, b) => (data[a] !== undefined && data[a] !== null ? data[a] : data[b]);
		const str = (v, d) => (typeof v === "string" ? v : d === undefined ? "" : d);
		const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
		const arr = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined).map(String) : []);
		const now = new Date().toISOString();
		const created = str(data.created, now);
		let status = STATUSES.includes(data.status) ? data.status : "active";
		if (archived && status === "active") status = "archived";
		const body = str(data.body);
		return {
			id: str(data.id, "mem-" + slug),
			slug,
			title: str(data.title, slug),
			description: str(data.description),
			type: TYPES.includes(data.type) ? data.type : "semantic",
			tags: arr(data.tags),
			confidence: Math.min(1, Math.max(0, num(data.confidence, 0.7))),
			storage_strength: Math.max(1, num(g("storage_strength", "storageStrength"), Math.max(1, num(g("access_count", "accessCount"), 1)))),
			status,
			archived: !!archived,
			created,
			updated: str(data.updated, now),
			last_accessed: str(g("last_accessed", "lastAccessed"), now),
			last_reinforced: str(g("last_reinforced", "lastReinforced"), created),
			access_count: num(g("access_count", "accessCount"), 0),
			source: str(data.source) || undefined,
			project: str(data.project) || undefined,
			links: arr(data.links),
			derived_from: arr(g("derived_from", "derivedFrom")),
			supersedes: str(data.supersedes) || undefined,
			superseded_by: str(g("superseded_by", "supersededBy")) || undefined,
			archive_reason: str(g("archive_reason", "archiveReason")) || undefined,
			history: arr(data.history),
			body,
			wikilinks: bodyWikilinks(body),
		};
	}

	/** 볼트 파일 하나(이름·원문)를 레코드로 해석한다. 읽을 수 없으면 null. */
	function parseMemory(name, text, archived) {
		const slug = String(name).split("/").pop().replace(/\.md$/i, "");
		if (!slug || !String(text).trim()) return null;
		const fm = splitFrontmatter(text);
		if (!fm) return null;
		return normalize(Object.assign({}, fm.data, { body: fm.body.trim() }), slug, archived);
	}

	/** 본문의 [[위키링크]] 대상 slug 목록(코드 블록·인라인 코드 제외, src/store.ts 와 같은 규칙). */
	function bodyWikilinks(body) {
		const prose = String(body)
			.replace(/```[\s\S]*?```/g, " ")
			.replace(/~~~[\s\S]*?~~~/g, " ")
			.replace(/`[^`\n]*`/g, " ");
		const out = [];
		for (const mt of prose.matchAll(/\[\[([^\]|#]+)/g)) {
			const t = mt[1].trim().replace(/^memories\//, "");
			if (t !== "") out.push(t);
		}
		return out;
	}

	// ── 경량 마크다운 렌더러 ───────────────────────────────────────────────────
	/** 이스케이프된 한 줄의 인라인 문법을 HTML 로 바꾼다. */
	function inline(text, hasSlug) {
		return text.split(/(`[^`]+`)/).map((part, k) => {
			if (k % 2) return "<code>" + part.slice(1, -1) + "</code>";
			const keep = [];
			const hold = (html) => "\u0000" + (keep.push(html) - 1) + "\u0000";
			let s = part.replace(/\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (m, target, frag, alias) => {
				const slug = target.trim().replace(/^memories\//, "");
				const label = (alias || target + (frag || "")).trim();
				if (hasSlug && !hasSlug(unesc(slug))) return hold(`<span class="missing" title="볼트에 없음">[[${label}]]</span>`);
				return hold(`<a href="#" data-slug="${slug}">${label}</a>`);
			});
			s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) =>
				/^(https?:|mailto:)/i.test(url) ? hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`) : m);
			s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
			return s.replace(/\u0000(\d+)\u0000/g, (m, n) => keep[+n]);
		}).join("");
	}

	/** 이스케이프된 줄 배열을 블록 HTML 로 바꾼다(블록 사이 개행 없음 — pre-wrap 컨테이너용). */
	function blocks(lines, hasSlug) {
		const html = [];
		const listRe = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
		const startsBlock = (l) => /^(```|~~~)/.test(l) || /^#{1,6}\s/.test(l) || /^&gt;/.test(l) || listRe.test(l) || /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l);
		let i = 0;
		while (i < lines.length) {
			const l = lines[i];
			let m;
			if (isBlank(l)) { i++; continue; }
			if ((m = /^(```|~~~)/.exec(l))) {
				const buf = [];
				i++;
				while (i < lines.length && !lines[i].startsWith(m[1])) buf.push(lines[i++]);
				i++;
				html.push("<pre><code>" + buf.join("\n") + "</code></pre>");
			} else if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l))) {
				const h = Math.min(6, m[1].length + 2);
				html.push(`<h${h}>${inline(m[2], hasSlug)}</h${h}>`);
				i++;
			} else if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) {
				html.push("<hr>");
				i++;
			} else if (/^&gt;/.test(l)) {
				const buf = [];
				while (i < lines.length && /^&gt;/.test(lines[i])) buf.push(lines[i++].replace(/^&gt;\s?/, ""));
				html.push("<blockquote>" + blocks(buf, hasSlug) + "</blockquote>");
			} else if ((m = listRe.exec(l))) {
				const ordered = /\d/.test(m[1]);
				const items = [];
				while (i < lines.length) {
					const li = listRe.exec(lines[i]);
					if (li && /\d/.test(li[1]) === ordered) items.push(li[2]);
					else if (li) break;
					else if (!isBlank(lines[i]) && /^\s+/.test(lines[i]) && items.length) items[items.length - 1] += " " + lines[i].trim();
					else break;
					i++;
				}
				const tag = ordered ? "ol" : "ul";
				html.push(`<${tag}>` + items.map((x) => "<li>" + inline(x, hasSlug) + "</li>").join("") + `</${tag}>`);
			} else {
				const buf = [];
				while (i < lines.length && !isBlank(lines[i]) && (buf.length === 0 || !startsBlock(lines[i]))) buf.push(lines[i++]);
				html.push("<p>" + inline(buf.join("\n"), hasSlug) + "</p>");
			}
		}
		return html.join("");
	}

	/** 마크다운 본문을 HTML 로 렌더한다. 원문 HTML 은 모두 이스케이프한다. hasSlug(slug) 가 false 면 위키링크를 missing 으로 표시한다. */
	function renderMarkdown(body, hasSlug) {
		return blocks(esc(String(body).replace(/\r\n?/g, "\n")).split("\n"), hasSlug);
	}

	globalThis.BigBrainParse = { TYPES, STATUSES, esc, parseYaml, parseMemory, normalize, bodyWikilinks, renderMarkdown };
})();
