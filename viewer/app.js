// 기억 목록·검색·필터·상세를 그리는 읽기 전용 뷰어 UI(3D 없이도 동작하며 3D 모듈은 on() 으로 구독한다).
// @ts-nocheck
(function () {
	"use strict";

	const P = window.AstronRAGParse;
	const { TYPES, STATUSES, esc } = P;
	const $ = (id) => document.getElementById(id);
	const TYPE_KO = { episodic: "일화", semantic: "의미", procedural: "절차", preference: "선호" };

	// ── 기저활성 (src/store.ts 근사) ──────────────────────────────────────────
	const HOUR = 36e5, DECAY_D = 0.5;
	const RETRIEVAL_THRESHOLD = -0.7 - Math.log(1 / (1 - 0.5));
	const HARD_RETRIEVAL = 0.5 - Math.log(1 / (1 - 0.5));
	/** ACT-R 하이브리드 근사로 기저활성 B 를 구한다. */
	function activation(m, now) {
		const n = Math.max(1, m.storage_strength || 1);
		const age = now - Date.parse(m.created), since = now - Date.parse(m.last_reinforced || m.created);
		const L = Math.max(isFinite(age) ? age : 6e4, 6e4) / HOUR;
		const raw = isFinite(since) ? Math.min(since, age) : age;
		const tLast = Math.max(isFinite(raw) ? raw : 6e4, 6e4) / HOUR;
		const tail = ((n - 1) * L ** -DECAY_D) / (1 - DECAY_D);
		return Math.log(tail + tLast ** -DECAY_D);
	}
	const sigma = (B) => 1 / (1 + Math.exp(-(B - RETRIEVAL_THRESHOLD)));

	const state = { types: new Set(TYPES), statuses: new Set(STATUSES), project: "__all", selected: null, hover: null, recall: null, source: "none", sourceLabel: "", fileCount: 0, broken: 0, projects: [] };
	const app = { state, nodes: [], edges: [], bySlug: new Map(), adj: new Map(), listeners: [], activation, sigma, RETRIEVAL_THRESHOLD };

	/** 3D 등 구독자에게 변경을 알린다(build·filter·select·recall). */
	function emit(ev) {
		for (const fn of app.listeners) {
			try { fn(ev); } catch (e) { console.warn("[viewer] listener", e); }
		}
	}
	app.on = (fn) => { app.listeners.push(fn); };

	/** 레코드로 노드·관계 그래프를 만들고 화면 전체를 다시 그린다. */
	function build(records, now = Date.now()) {
		const bySlug = new Map();
		records.forEach((r) => bySlug.set(r.slug, r));
		const nodes = [...bySlug.values()].map((r, i) => {
			const B = activation(r, now);
			return { i, r, B, s: sigma(B), visible: true, dim: 1 };
		});
		app.nodes = nodes;
		app.bySlug = new Map(nodes.map((n) => [n.r.slug, n]));
		app.adj = new Map(nodes.map((n) => [n, []]));
		app.edges = [];
		const seen = new Set();
		let broken = 0;
		const addEdge = (a, b, kind) => {
			const key = kind === "link" ? [a.i, b.i].sort().join("-") + kind : a.i + ">" + b.i + kind;
			if (a === b || seen.has(key)) return;
			seen.add(key);
			const e = { a, b, kind };
			app.edges.push(e);
			app.adj.get(a).push({ n: b, e });
			app.adj.get(b).push({ n: a, e });
		};
		for (const n of nodes) {
			for (const l of new Set([...n.r.links, ...(n.r.wikilinks || [])])) { const t = app.bySlug.get(l); t ? addEdge(n, t, "link") : broken++; }
			for (const d of n.r.derived_from) { const t = app.bySlug.get(d); if (t) addEdge(t, n, "derived"); }
			if (n.r.supersedes) { const t = app.bySlug.get(n.r.supersedes); if (t) addEdge(n, t, "supersedes"); }
			if (n.r.superseded_by) { const t = app.bySlug.get(n.r.superseded_by); if (t) addEdge(t, n, "supersedes"); }
		}
		state.broken = broken;
		state.projects = [...new Set(nodes.map((n) => n.r.project).filter(Boolean))].sort();
		state.selected = null; state.hover = null; state.recall = null;
		$("q").value = "";
		computeVisibility();
		refreshUI();
		emit("build");
	}

	/** 필터(type·status·project)로 노드 표시 여부를 정한다. */
	function computeVisibility() {
		for (const n of app.nodes) {
			n.visible = state.types.has(n.r.type) && state.statuses.has(n.r.status) &&
				(state.project === "__all" || (state.project === "__global" ? !n.r.project : n.r.project === state.project));
		}
	}

	/** 필터가 바뀐 뒤 검색 결과·목록·구독자를 갱신한다. */
	function applyFilters() {
		computeVisibility();
		if (state.recall) runSearch(state.recall.query, false);
		refreshUI();
		emit("filter");
	}

	// ── 검색 ────────────────────────────────────────────────────────────────
	/** 공백 구분 단어를 모두 포함하는 기억을 title·description·tags·본문에서 찾는다. */
	function runSearch(query, notify = true) {
		const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
		if (!terms.length) return clearSearch();
		const scored = [];
		for (const n of app.nodes) {
			if (!n.visible) continue;
			const hay = [[n.r.title, 3], [n.r.description, 2], [n.r.tags.join(" "), 2], [n.r.body, 1]].map(([t, w]) => [String(t).toLowerCase(), w]);
			let score = 0, all = true;
			for (const t of terms) {
				const hit = hay.reduce((s, [text, w]) => s + (text.includes(t) ? w : 0), 0);
				if (!hit) { all = false; break; }
				score += hit;
			}
			if (all) scored.push({ n, score });
		}
		scored.sort((a, b) => b.score - a.score || String(b.n.r.updated).localeCompare(String(a.n.r.updated)));
		state.recall = { query, direct: scored, total: scored.length, lit: scored.map((d) => d.n) };
		if (!notify) return;
		state.selected = null;
		renderResults(); renderInspector();
		if (scored.length && innerHeight < 1000) $("legend").open = false;
		emit("recall");
	}
	function clearSearch() {
		state.recall = null;
		renderResults();
		emit("recall");
	}

	// ── UI ──────────────────────────────────────────────────────────────────
	function fmt(x, d = 2) { return Number.isFinite(x) ? x.toFixed(d) : "—"; }
	function daysSince(iso) { const t = Date.parse(iso); return Number.isFinite(t) ? (Date.now() - t) / 864e5 : NaN; }
	const day = (iso) => (/^\d{4}-\d\d-\d\d/.test(String(iso)) ? String(iso).slice(0, 10) : "—");

	function refreshUI() {
		const nodes = app.nodes;
		const active = nodes.filter((n) => n.r.status === "active");
		const avg = active.length ? active.reduce((s, n) => s + n.s, 0) / active.length : 0;
		const live = state.source === "data" || state.source === "vault";
		$("stats").innerHTML = `<span class="src ${live ? "" : "sample"}">${esc(state.sourceLabel)}</span>
			<span>기억 <b class="mono">${nodes.length}</b></span><span>시냅스 <b class="mono">${app.edges.length}</b></span>
			<span>평균 σ <b class="mono">${fmt(avg)}</b></span>${state.broken ? `<span>끊긴 링크 <b class="mono">${state.broken}</b></span>` : ""}`;
		const tc = $("typeChips"); tc.innerHTML = "";
		TYPES.forEach((t) => {
			const b = document.createElement("button"); b.type = "button"; b.className = "chip";
			b.setAttribute("aria-pressed", state.types.has(t));
			b.innerHTML = `<span class="dot" style="background:var(--${t})"></span>${t}<span class="n">${nodes.filter((n) => n.r.type === t).length}</span>`;
			b.title = TYPE_KO[t] + " 기억 표시/숨김";
			b.onclick = () => { state.types.has(t) ? state.types.delete(t) : state.types.add(t); applyFilters(); };
			tc.append(b);
		});
		const sc = $("statusChips"); sc.innerHTML = "";
		STATUSES.forEach((s) => {
			const b = document.createElement("button"); b.type = "button"; b.className = "chip";
			b.setAttribute("aria-pressed", state.statuses.has(s));
			b.innerHTML = `<span class="dot" style="background:${s === "active" ? "var(--signal)" : "var(--dormant)"}"></span>${s}<span class="n">${nodes.filter((n) => n.r.status === s).length}</span>`;
			b.onclick = () => { state.statuses.has(s) ? state.statuses.delete(s) : state.statuses.add(s); applyFilters(); };
			sc.append(b);
		});
		const sel = $("proj"); const cur = state.project;
		sel.innerHTML = `<option value="__all">전체</option><option value="__global">전역 기억만</option>` + state.projects.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
		sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "__all";
		if (sel.value !== cur) { state.project = sel.value; computeVisibility(); }
		renderResults(); renderInspector();
	}

	/** #results 에 검색 결과 또는 필터를 통과한 전체 목록을 그린다. */
	function renderResults() {
		const ol = $("results"); const rc = state.recall;
		const row = (n) => {
			const r = n.r;
			const meta = [r.project || "전역", ...r.tags.map((t) => "#" + t)].join(" · ");
			const tip = `${r.type} · ${r.status} · project ${r.project || "전역"} · confidence ${fmt(r.confidence)} · updated ${day(r.updated)}${r.tags.length ? " · tags " + r.tags.join(", ") : ""}`;
			return `<li><button type="button" data-slug="${esc(r.slug)}" title="${esc(tip)}"><span class="dot" style="background:${r.status === "active" ? `var(--${r.type})` : "var(--dormant)"}"></span><span class="t">${esc(r.title)} <span class="via">${esc(meta)}</span></span><span class="s">${fmt(r.confidence)} · ${day(r.updated)}</span></button></li>`;
		};
		if (rc) {
			if (!rc.direct.length) { ol.innerHTML = `<li><p class="note">"${esc(rc.query)}"에 맞는 기억이 없습니다. 다른 표현으로 다시 질의해 보십시오.</p></li>`; return; }
			ol.innerHTML = `<li class="note" style="padding:4px">"${esc(rc.query)}" 검색 ${rc.total}건 · 관련도순</li>` + rc.direct.map((d) => row(d.n)).join("");
			return;
		}
		const list = app.nodes.filter((n) => n.visible).sort((a, b) => String(b.r.updated).localeCompare(String(a.r.updated)));
		if (!app.nodes.length) { ol.innerHTML = ""; return; }
		if (!list.length) { ol.innerHTML = `<li><p class="note">필터에 맞는 기억이 없습니다.</p></li>`; return; }
		ol.innerHTML = `<li class="note" style="padding:4px">전체 ${app.nodes.length}건 중 ${list.length}건 · updated 최신순</li>` + list.map(row).join("");
	}

	/** 관계 종류를 사람이 읽는 라벨로 바꾼다. */
	function relKind(n, e) {
		if (e.kind === "link") return "link";
		if (e.kind === "derived") return e.a === n ? "근거 → 파생" : "파생 ← 근거";
		return e.a === n ? "supersedes" : "superseded_by";
	}

	function renderInspector() {
		const box = $("insBody"), n = state.selected;
		$("inspector").classList.toggle("idle-mobile", !n && innerWidth <= 760);
		if (!n) {
			const top = app.nodes.filter((x) => x.r.status === "active").sort((a, b) => b.s - a.s).slice(0, 5);
			const weak = app.nodes.filter((x) => x.r.status === "active" && daysSince(x.r.last_reinforced) > 3).sort((a, b) => a.B - b.B).slice(0, 4);
			const li = (x) => `<li><button type="button" data-slug="${esc(x.r.slug)}"><span class="dot" style="background:var(--${x.r.type})"></span>${esc(x.r.title)}<span class="k">σ ${fmt(x.s)}</span></button></li>`;
			box.innerHTML = `<div class="empty-ins sec"><span class="label">inspector</span><h2>기억을 선택하십시오</h2>
				<p class="desc" style="margin:0">목록이나 노드를 클릭하면 frontmatter 전체와 연결된 기억이 여기에 표시됩니다. 위 검색창은 title·description·tags·본문에서 모든 단어를 포함하는 기억을 찾습니다.</p></div>
				<div class="sec"><span class="label">가장 활성이 높은 기억</span><ul class="nlist">${top.map(li).join("")}</ul></div>
				<div class="sec"><span class="label">떠올리기 어려워진 기억</span><ul class="nlist">${weak.map(li).join("")}</ul></div>`;
			return;
		}
		const r = n.r, age = daysSince(r.created), upd = daysSince(r.updated);
		const flags = [];
		if (upd > 30) flags.push(`<div class="flag"><b>STALE_HINT</b>${Math.floor(upd)}일 동안 갱신되지 않았습니다. 현재 코드와 대조한 뒤 사용하십시오.</div>`);
		if (r.status === "active" && n.B < RETRIEVAL_THRESHOLD) flags.push(`<div class="flag"><b>BELOW THRESHOLD</b>기저활성이 인출 임계(−1.39) 아래입니다. 능동 회상 시 +0.5 보너스 대상입니다.</div>`);
		else if (r.status === "active" && n.B < HARD_RETRIEVAL) flags.push(`<div class="flag"><b>HARD TO RECALL</b>활성이 낮아 회상 시 바람직한 어려움 보너스를 받습니다.</div>`);
		if (r.confidence < 0.5) flags.push(`<div class="flag"><b>LOW CONFIDENCE</b>확신도 ${fmt(r.confidence)}. revise로 검증하거나 낮은 신뢰로 취급하십시오.</div>`);
		if (r.archive_reason) flags.push(`<div class="flag"><b>ARCHIVED</b>${esc(r.archive_reason)}</div>`);
		const rels = app.adj.get(n);
		const rel = rels.map(({ n: m, e }) => `<li><button type="button" data-slug="${esc(m.r.slug)}"><span class="dot" style="background:${m.r.status === "active" ? `var(--${m.r.type})` : "var(--dormant)"}"></span>${esc(m.r.title)}<span class="k">${relKind(n, e)}</span></button></li>`).join("");
		const wanted = [
			...[...new Set([...r.links, ...(r.wikilinks || [])])].map((s) => [s, "link"]),
			...r.derived_from.map((s) => [s, "derived_from"]),
			...(r.supersedes ? [[r.supersedes, "supersedes"]] : []),
			...(r.superseded_by ? [[r.superseded_by, "superseded_by"]] : []),
		];
		const missing = wanted.filter(([s]) => !app.bySlug.has(s)).map(([s, k]) => `<li><span class="missing">[[${esc(s)}]] · ${k} · 볼트에 없음</span></li>`).join("");
		const hasSlug = (s) => app.bySlug.has(s);
		box.innerHTML = `
			<div class="ins-top"><span class="type-tag" style="color:var(--${r.type})"><span class="dot" style="background:var(--${r.type})"></span>${r.type}</span>
				<span style="display:flex;gap:8px;align-items:center"><span class="status-tag">${r.status}</span><button type="button" class="close" id="insClose" aria-label="선택 해제">닫기</button></span></div>
			<div><h2>${esc(r.title)}</h2>${r.description ? `<p class="desc">${esc(r.description)}</p>` : ""}<div class="slug">${esc(r.slug)}${r.project ? " · project: " + esc(r.project) : " · 전역"} · updated ${day(r.updated)}</div></div>
			<dl class="metrics">
				<div><dt class="label">confidence</dt><dd>${fmt(r.confidence)}</dd><div class="bar"><i style="width:${r.confidence * 100}%"></i></div></div>
				<div><dt class="label">retrieval <span style="text-transform:none">σ</span></dt><dd>${fmt(n.s)}</dd><div class="bar"><i style="width:${n.s * 100}%"></i></div></div>
				<div><dt class="label">activation B</dt><dd>${fmt(n.B)}</dd></div>
				<div><dt class="label">storage_strength</dt><dd>${fmt(r.storage_strength, 0)}</dd></div>
				<div><dt class="label">access_count</dt><dd>${r.access_count}</dd></div>
				<div><dt class="label">age_days</dt><dd>${fmt(age, age < 1 ? 2 : 0)} <small>강화 ${fmt(daysSince(r.last_reinforced), 0)}일 전</small></dd></div>
			</dl>
			${flags.length ? `<div class="flags">${flags.join("")}</div>` : ""}
			${r.tags.length ? `<div class="sec"><span class="label">tags</span><div class="tags">${r.tags.map((t) => `<span>${esc(t)}</span>`).join("")}</div></div>` : ""}
			<div class="sec"><span class="label">연관 기억 · ${rels.length}</span>${rel || missing ? `<ul class="nlist">${rel}${missing}</ul>` : `<p class="note">연결 없음. reflect에서 orphans_without_links로 잡히는 기억입니다.</p>`}</div>
			${r.body ? `<div class="sec"><span class="label">본문</span><div class="body">${P.renderMarkdown(r.body, hasSlug)}</div></div>` : ""}
			${r.history.length ? `<div class="sec"><span class="label">history</span><ul class="hist">${r.history.map((h) => `<li>${esc(h)}</li>`).join("")}</ul></div>` : ""}
			${r.source ? `<div class="sec"><span class="label">source</span><span class="slug">${esc(r.source)}</span></div>` : ""}`;
		$("insClose").onclick = () => select(null);
	}

	/** 노드(또는 slug)를 선택해 상세를 연다. null 이면 선택을 해제한다. */
	function select(target) {
		const n = typeof target === "string" ? app.bySlug.get(target) : target;
		if (typeof target === "string" && !n) return;
		state.selected = n || null;
		renderInspector();
		if (n) $("inspector").querySelector(".scroll").scrollTop = 0;
		emit("select");
	}
	app.select = select;

	// ── 이벤트 연결 ─────────────────────────────────────────────────────────
	$("results").addEventListener("click", (e) => { const b = e.target.closest("button[data-slug]"); if (b) select(b.dataset.slug); });
	$("insBody").addEventListener("click", (e) => {
		const b = e.target.closest("button[data-slug], a[data-slug]");
		if (!b) return;
		e.preventDefault();
		select(b.dataset.slug);
	});
	$("recallForm").addEventListener("submit", (e) => { e.preventDefault(); const q = $("q").value.trim(); q ? runSearch(q) : clearSearch(); });
	$("q").addEventListener("input", (e) => { if (!e.target.value.trim() && state.recall) clearSearch(); });
	$("proj").addEventListener("change", (e) => { state.project = e.target.value; applyFilters(); });
	addEventListener("keydown", (e) => {
		if (e.key === "/" && document.activeElement !== $("q")) { e.preventDefault(); $("q").focus(); }
		if (e.key === "Escape") { select(null); if (state.recall) { $("q").value = ""; clearSearch(); } }
	});

	// ── 데이터 공급 ─────────────────────────────────────────────────────────
	/** 폴더 선택·드롭으로 받은 파일 중 볼트 기억 파일만 같은 파서로 읽는다. */
	async function readFiles(files) {
		const recs = []; let skipped = 0;
		for (const f of files) {
			const path = String(f.webkitRelativePath || f.relPath || f.name).replace(/\\/g, "/");
			const parts = path.split("/");
			const dir = parts.length > 1 ? parts[parts.length - 2] : "";
			if (/\.json$/i.test(path)) {
				try {
					const j = JSON.parse(await f.text());
					const list = Array.isArray(j) ? j : j.memories || (j.results && j.results.map((r) => r.record || r)) || [];
					list.forEach((r) => { const s = r && (r.slug || r.id); if (s) recs.push(P.normalize(r, String(s), false)); });
				} catch { skipped++; }
				continue;
			}
			if (!/\.md$/i.test(path) || /^MEMORY\.md$/i.test(parts[parts.length - 1]) || (dir && dir !== "memories" && dir !== "archive")) { skipped++; continue; }
			const r = P.parseMemory(path, await f.text(), dir === "archive");
			r ? recs.push(r) : skipped++;
		}
		return { recs, skipped };
	}

	async function loadFiles(list) {
		const files = [...list]; if (!files.length) return;
		const { recs, skipped } = await readFiles(files);
		if (!recs.length) { $("loadNote").textContent = `읽을 수 있는 기억이 없습니다. 볼트 폴더(memories/·archive/ 가 든 폴더)나 memories/*.md 파일인지 확인하십시오. 건너뛴 파일 ${skipped}개.`; return; }
		const root = String(files[0].webkitRelativePath || files[0].relPath || "").split("/")[0];
		state.source = "vault"; state.fileCount = recs.length;
		state.sourceLabel = `폴더 · ${root || "파일"} · 파일 ${recs.length}`;
		$("loadNote").textContent = `기억 ${recs.length}건을 불러왔습니다${skipped ? `, ${skipped}개 파일은 건너뛰었습니다(MEMORY.md, revisions, quarantine 등)` : ""}. 파일은 이 브라우저 밖으로 나가지 않습니다.`;
		build(recs);
	}

	$("btnFolder").onclick = () => $("fileFolder").click();
	$("btnFiles").onclick = () => $("fileFiles").click();
	$("btnSample").onclick = () => {
		state.source = "sample"; state.fileCount = 0; state.sourceLabel = "샘플 볼트";
		$("loadNote").textContent = "샘플 볼트를 표시하고 있습니다. 슬러그와 필드는 AstronRAG 볼트 형식과 같습니다.";
		build(window.buildSample(Date.now()).map((r) => P.normalize(r, r.slug, false)));
	};
	$("fileFolder").addEventListener("change", (e) => { loadFiles(e.target.files); e.target.value = ""; });
	$("fileFiles").addEventListener("change", (e) => { loadFiles(e.target.files); e.target.value = ""; });
	let dragDepth = 0;
	addEventListener("dragenter", (e) => { if ([...((e.dataTransfer && e.dataTransfer.types) || [])].includes("Files")) { dragDepth++; $("drop").hidden = false; } });
	addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("drop").hidden = true; } });
	addEventListener("dragover", (e) => e.preventDefault());
	addEventListener("drop", async (e) => {
		e.preventDefault(); dragDepth = 0; $("drop").hidden = true;
		const items = [...(e.dataTransfer.items || [])].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
		if (!items.length) return loadFiles(e.dataTransfer.files);
		const out = [];
		const walk = (entry, path) => new Promise((res) => {
			if (entry.isFile) entry.file((f) => { f.relPath = path + f.name; out.push(f); res(); }, res);
			else if (entry.isDirectory) {
				const rd = entry.createReader(); const all = [];
				const more = () => rd.readEntries(async (ents) => { if (!ents.length) { for (const c of all) await walk(c, path + entry.name + "/"); res(); } else { all.push(...ents); more(); } }, res);
				more();
			} else res();
		});
		for (const it of items) await walk(it, "");
		loadFiles(out);
	});

	/** data.js 가 있으면 그 원문을, 없으면 빈 볼트로 시작한다. */
	function boot() {
		if (innerWidth <= 760 || innerHeight < 700) $("legend").open = false;
		const data = window.ASTRONRAG_DATA;
		if (data && Array.isArray(data.files)) {
			const recs = data.files.map((f) => P.parseMemory(f.name, f.text, !!f.archived)).filter(Boolean);
			state.source = "data"; state.fileCount = recs.length;
			state.sourceLabel = `data.js · ${data.source || "vault"} · ${day(data.generatedAt)}`;
			$("loadNote").textContent = `data.js 에서 기억 ${recs.length}건을 읽었습니다(${data.generatedAt || "생성 시각 모름"} 기준). 다른 볼트는 폴더를 열어 바꿀 수 있습니다.`;
			build(recs);
			return;
		}
		state.source = "none"; state.sourceLabel = "data.js 없음";
		$("loadNote").textContent = "viewer/data.js 가 없습니다. npm run viewer:export 로 만들거나, 볼트 폴더 열기로 memories/·archive/ 가 든 볼트 폴더를 고르십시오. 파일은 브라우저 안에서만 읽습니다.";
		build([]);
	}

	window.AstronRAG = app;
	boot();
})();
