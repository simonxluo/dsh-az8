// dsh-az8 — Client half: 右侧停靠面板（运行 / 资产 / 设置）+ 设置页区块。
// 数据源是 Host 面板路由（GET state/credits，POST set-settings），媒体走 /_dsh/dsh-az8/media。
// 展示结构参考 dsh-comfyui 的三页签（其队列页签 ↔ 本面板「运行」，其资产页签 ↔ 「资产」）。
window.__ModuleLoader__.load({ id: "dsh-az8", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";

const React = require("react");
const { useState, useEffect, useCallback, useRef } = React;
const h = React.createElement;

const STATE_ROUTE = "_dsh/dsh-az8/state";
const CREDITS_ROUTE = "_dsh/dsh-az8/credits";
const DOCK_ID = "dsh-az8-dock";
const DOCK_KIND = "az8.generation";

// ---------------------------------------------------------------------------
// i18n（跟随 harness 界面语言；locale 是可选服务）
// ---------------------------------------------------------------------------

var UI_LANG = "zh";
function serviceOf(ctx, name) {
	try { return typeof ctx.get === "function" ? ctx.get(name) : undefined; } catch (e) { return undefined; }
}
function subscribeLocale(ctx) {
	const service = serviceOf(ctx, "locale");
	if (!service || typeof service.getSnapshot !== "function") return () => {};
	const tag = String(service.getSnapshot().active ?? "").toLowerCase();
	UI_LANG = tag.indexOf("zh") === 0 ? "zh" : "en";
	if (typeof service.subscribe !== "function") return () => {};
	return service.subscribe(() => {
		const next = String(service.getSnapshot().active ?? "").toLowerCase();
		UI_LANG = next.indexOf("zh") === 0 ? "zh" : "en";
		forceUpdate();
	});
}
var listeners = [];
function forceUpdate() { for (const fn of listeners) { try { fn(); } catch (e) {} } }

const UI = {
	"nav.title": { zh: "AZ8 生成", en: "AZ8 Generation" },
	"dock.title": { zh: "AZ8", en: "AZ8" },
	"subtitle": { zh: "对话内生成图片/视频；运行、资产与设置。", en: "Generate in chat; runs, assets and settings." },
	"tab.runs": { zh: "运行", en: "Runs" },
	"tab.assets": { zh: "资产", en: "Assets" },
	"tab.settings": { zh: "设置", en: "Settings" },
	"action.refresh": { zh: "刷新", en: "Refresh" },
	"action.save": { zh: "保存", en: "Save" },
	"action.saved": { zh: "已保存", en: "Saved" },
	"action.open": { zh: "打开", en: "Open" },
	"empty.runs": { zh: "还没有生成记录。对话里说“用 AZ8 画一张…”即可。", en: "No runs yet. Ask in chat to generate." },
	"empty.assets": { zh: "还没有产物。生成成功后会自动落到这里。", en: "No assets yet." },
	"error.load": { zh: "加载失败：", en: "Load failed: " },
	"f.defaultProject": { zh: "默认项目", en: "Default project" },
	"f.maxAutoCredits": { zh: "报价闸门（credits）", en: "Quote gate (credits)" },
	"f.waitTimeout": { zh: "等待窗口（秒）", en: "Wait window (s)" },
	"f.panelPoll": { zh: "面板刷新（秒）", en: "Panel poll (s)" },
	"f.none": { zh: "（未设置，每次生成需指定）", en: "(not set)" },
	"credits.balance": { zh: "credits", en: "credits" },
};
function t(key) {
	const entry = UI[key];
	return entry === undefined ? key : (entry[UI_LANG] ?? entry.zh);
}
function relTime(iso) {
	if (!iso) return "";
	const ms = Date.now() - new Date(iso).getTime();
	if (!Number.isFinite(ms)) return "";
	const s = Math.round(ms / 1000);
	if (s < 60) return UI_LANG === "zh" ? `${s} 秒前` : `${s}s ago`;
	if (s < 3600) return UI_LANG === "zh" ? `${Math.round(s / 60)} 分钟前` : `${Math.round(s / 60)}m ago`;
	if (s < 86400) return UI_LANG === "zh" ? `${Math.round(s / 3600)} 小时前` : `${Math.round(s / 3600)}h ago`;
	return new Date(iso).toLocaleDateString();
}
function fmtBytes(n) {
	if (!Number.isFinite(n) || n <= 0) return "";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
const STATUS_META = {
	succeeded: { color: "#34c759", zh: "成功", en: "done" },
	failed: { color: "#ff453a", zh: "失败", en: "failed" },
	running: { color: "#0a84ff", zh: "生成中", en: "running" },
	starting: { color: "#0a84ff", zh: "启动中", en: "starting" },
	planning: { color: "#8e8e93", zh: "规划中", en: "planning" },
	resolving: { color: "#8e8e93", zh: "准备中", en: "resolving" },
	downloading: { color: "#0a84ff", zh: "下载中", en: "downloading" },
	awaiting_confirm: { color: "#ff9f0a", zh: "待确认报价", en: "awaiting confirm" },
	"needs-choice": { color: "#ff9f0a", zh: "待选模型", en: "needs choice" },
	indeterminate: { color: "#ff9f0a", zh: "结果不确定", en: "indeterminate" },
};

// ---------------------------------------------------------------------------
// 数据获取
// ---------------------------------------------------------------------------

async function fetchJson(url, options) {
	const response = await fetch(url, options);
	const json = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(json.error ?? `HTTP ${response.status}`);
	return json;
}

// ---------------------------------------------------------------------------
// 面板
// ---------------------------------------------------------------------------

function Badge({ status }) {
	const meta = STATUS_META[status] ?? { color: "#8e8e93", zh: status, en: status };
	return h("span", {
		style: {
			display: "inline-block", padding: "1px 8px", borderRadius: 10, fontSize: 11,
			color: meta.color, background: meta.color + "22", border: `1px solid ${meta.color}55`,
			whiteSpace: "nowrap",
		},
	}, UI_LANG === "zh" ? meta.zh : meta.en);
}

function RunRow({ run }) {
	const credits = [];
	if (run.creditsEstimated != null) credits.push(`≈${run.creditsEstimated}`);
	if (run.creditsActual != null) credits.push(`=${run.creditsActual}`);
	return h("div", {
		style: { padding: "8px 10px", borderBottom: "1px solid rgba(127,127,127,.2)", fontSize: 12 },
	},
		h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
			h(Badge, { status: run.status }),
			h("span", { style: { fontWeight: 600 } }, `${run.target ?? ""} · ${run.id}`),
			h("span", { style: { marginLeft: "auto", opacity: 0.65, fontSize: 11 } }, relTime(run.startedAt || run.endedAt)),
		),
		h("div", { style: { opacity: 0.75, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
			`${run.projectName || run.projectId || ""}${run.definitionName ? ` · ${run.definitionName}` : ""}${credits.length ? ` · ${credits.join(" ")} cr` : ""}`),
		run.prompt ? h("div", { style: { opacity: 0.55, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, run.prompt) : null,
		run.error ? h("div", { style: { color: "#ff6961", marginTop: 3, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, run.error.message) : null,
	);
}

function RunsTab({ runs }) {
	if (!runs || runs.length === 0) return h("div", { style: { padding: 20, opacity: 0.6, fontSize: 12, textAlign: "center" } }, t("empty.runs"));
	return h("div", null, runs.map((run) => h(RunRow, { key: run.id, run })));
}

function AssetCard({ asset, onOpen }) {
	const common = {
		style: {
			width: "100%", aspectRatio: "1 / 1", objectFit: "cover", borderRadius: 8,
			background: "rgba(127,127,127,.12)", cursor: asset.kind === "image" ? "zoom-in" : "default",
			display: "block",
		},
	};
	return h("div", { style: { breakInside: "avoid", marginBottom: 10 } },
		asset.kind === "image"
			? h("img", { ...common, src: asset.url, loading: "lazy", onClick: () => onOpen(asset) })
			: asset.kind === "video"
				? h("video", { ...common, style: { ...common.style, objectFit: "contain" }, src: asset.url, controls: true, preload: "metadata" })
				: asset.kind === "audio"
					? h("div", { style: { ...common.style, display: "grid", placeItems: "center" } }, h("audio", { controls: true, src: asset.url, style: { width: "90%" } }))
					: h("a", { href: asset.url, target: "_blank", style: { ...common.style, display: "grid", placeItems: "center", textDecoration: "none" } }, asset.filename),
		h("div", { style: { fontSize: 11, opacity: 0.6, marginTop: 4, display: "flex", justifyContent: "space-between" } },
			h("span", null, `${asset.kind} · ${asset.runId ?? ""}`),
			h("span", null, fmtBytes(asset.bytes)),
		),
	);
}

function AssetsTab({ assets, onOpen }) {
	if (!assets || assets.length === 0) return h("div", { style: { padding: 20, opacity: 0.6, fontSize: 12, textAlign: "center" } }, t("empty.assets"));
	return h("div", { style: { columnCount: 2, columnGap: 10, padding: 10 } },
		assets.map((asset) => h(AssetCard, { key: asset.id, asset, onOpen })),
	);
}

function Field({ label, children }) {
	return h("label", { style: { display: "block", marginBottom: 12, fontSize: 12 } },
		h("div", { style: { opacity: 0.75, marginBottom: 4 } }, label),
		children,
	);
}
const inputStyle = {
	width: "100%", padding: "6px 8px", borderRadius: 8, fontSize: 12,
	border: "1px solid rgba(127,127,127,.4)", background: "rgba(127,127,127,.08)", color: "inherit",
	boxSizing: "border-box",
};

function SettingsTab({ snapshot, reload }) {
	const [form, setForm] = useState(null);
	const [flash, setFlash] = useState("");
	useEffect(() => {
		const s = snapshot?.settings;
		if (s && form === null) {
			setForm({
				defaultProjectId: s.defaultProjectId ?? "",
				maxAutoCredits: String(s.maxAutoCredits ?? 30),
				waitTimeoutS: String(Math.round((s.waitTimeoutMs ?? 180000) / 1000)),
				panelPollS: String(Math.round((s.panelPollMs ?? 5000) / 1000)),
			});
		}
	}, [snapshot, form]);
	if (form === null) return null;
	const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });
	const save = async () => {
		setFlash("");
		try {
			await fetchJson(STATE_ROUTE, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					action: "set-settings",
					patch: {
						defaultProjectId: form.defaultProjectId,
						maxAutoCredits: Number(form.maxAutoCredits),
						waitTimeoutMs: Number(form.waitTimeoutS) * 1000,
						panelPollMs: Number(form.panelPollS) * 1000,
					},
				}),
			});
			setFlash(t("action.saved"));
			await reload();
		} catch (error) { setFlash(String(error.message ?? error)); }
	};
	return h("div", { style: { padding: 12 } },
		h(Field, { label: t("f.defaultProject") },
			h("select", { style: inputStyle, value: form.defaultProjectId, onChange: set("defaultProjectId") },
				h("option", { value: "" }, t("f.none")),
				(snapshot?.projects ?? []).map((p) => h("option", { key: p.id, value: p.id }, p.name || p.id)),
			),
		),
		h(Field, { label: t("f.maxAutoCredits") + "（超过就停下问人）",
		}, h("input", { style: inputStyle, type: "number", min: 0, value: form.maxAutoCredits, onChange: set("maxAutoCredits") })),
		h(Field, { label: t("f.waitTimeout") }, h("input", { style: inputStyle, type: "number", min: 5, max: 900, value: form.waitTimeoutS, onChange: set("waitTimeoutS") })),
		h(Field, { label: t("f.panelPoll") }, h("input", { style: inputStyle, type: "number", min: 1, max: 60, value: form.panelPollS, onChange: set("panelPollS") })),
		h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
			h("button", { onClick: save, style: { padding: "6px 16px", borderRadius: 8, fontSize: 12, border: "1px solid rgba(127,127,127,.4)", background: "rgba(10,132,255,.15)", color: "inherit", cursor: "pointer" } }, t("action.save")),
			flash ? h("span", { style: { fontSize: 12, opacity: 0.75 } }, flash) : null,
		),
	);
}

function Az8Panel(props, ctx) {
	const [tab, setTab] = useState("runs");
	const [snapshot, setSnapshot] = useState(null);
	const [credits, setCredits] = useState(null);
	const [error, setError] = useState("");
	const [lightbox, setLightbox] = useState(null);
	const [, bump] = useState(0);
	useEffect(() => { listeners.push(bump); return () => { listeners = listeners.filter((fn) => fn !== bump); }; }, []);

	const reload = useCallback(async () => {
		try {
			const json = await fetchJson(`${STATE_ROUTE}?refresh=projects`);
			setSnapshot(json);
			setError("");
		} catch (e) { setError(String(e.message ?? e)); }
	}, []);
	useEffect(() => { reload(); }, [reload]);
	useEffect(() => {
		const pollMs = snapshot?.settings?.panelPollMs ?? 5000;
		const timer = setInterval(reload, Math.min(Math.max(pollMs, 1000), 60000));
		return () => clearInterval(timer);
	}, [reload, snapshot?.settings?.panelPollMs]);
	useEffect(() => {
		let alive = true;
		const load = () => fetchJson(CREDITS_ROUTE).then((json) => { if (alive) setCredits(json); }).catch(() => {});
		load();
		const timer = setInterval(load, 60000);
		return () => { alive = false; clearInterval(timer); };
	}, []);

	const balance = (credits?.credits ?? [])[0];
	const tabs = [["runs", t("tab.runs")], ["assets", t("tab.assets")], ["settings", t("tab.settings")]];
	return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, fontSize: 13 } },
		h("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid rgba(127,127,127,.25)" } },
			h("span", { style: { fontWeight: 700 } }, t("nav.title")),
			balance ? h("span", { style: { fontSize: 11, padding: "1px 8px", borderRadius: 10, background: "rgba(52,199,89,.15)", color: "#34c759" } },
				`${Number(balance.availableCredits ?? 0).toLocaleString()} ${t("credits.balance")}`) : null,
			h("button", {
				onClick: reload, title: t("action.refresh"),
				style: { marginLeft: "auto", border: "none", background: "none", color: "inherit", cursor: "pointer", fontSize: 14, opacity: 0.7 },
			}, "⟳"),
		),
		h("div", { style: { display: "flex", borderBottom: "1px solid rgba(127,127,127,.25)" } },
			tabs.map(([key, label]) => h("button", {
				key,
				onClick: () => setTab(key),
				style: {
					flex: 1, padding: "7px 0", fontSize: 12, cursor: "pointer", color: "inherit",
					border: "none", borderBottom: tab === key ? "2px solid #0a84ff" : "2px solid transparent",
					background: tab === key ? "rgba(10,132,255,.08)" : "none", fontWeight: tab === key ? 600 : 400,
				},
			}, label)),
		),
		error ? h("div", { style: { padding: 8, fontSize: 12, color: "#ff9f0a" } }, t("error.load") + error) : null,
		h("div", { style: { flex: 1, minHeight: 0, overflowY: "auto" } },
			tab === "runs" ? h(RunsTab, { runs: snapshot?.runs })
			: tab === "assets" ? h(AssetsTab, { assets: snapshot?.assets, onOpen: setLightbox })
			: h(SettingsTab, { snapshot, reload }),
		),
		lightbox !== null ? h("div", {
			onClick: () => setLightbox(null),
			style: { position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,.82)", display: "grid", placeItems: "center", cursor: "zoom-out" },
		},
			h("img", { src: lightbox.url, style: { maxWidth: "92vw", maxHeight: "92vh", borderRadius: 8 }, onClick: (e) => e.stopPropagation() }),
		) : null,
	);
}

function SettingsSection(props, ctx) {
	return h("div", { style: { padding: "4px 0" } },
		h("div", { style: { fontSize: 12, opacity: 0.7, marginBottom: 8 } }, t("subtitle")),
		h(Az8Panel, props, ctx),
	);
}

// ---------------------------------------------------------------------------
// 插件装配：右侧停靠页签 + 设置页区块
// ---------------------------------------------------------------------------

function apply(ctx) {
	ctx.effect(() => subscribeLocale(ctx));
	ctx.slots.inject("settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: "dsh-az8",
		order: 48,
		label: () => t("nav.title"),
		inject: () => ({}),
	}, (props) => SettingsSection(props, ctx)));
	ctx.inject(["sidebarRightTabs"], (dock) => {
		const tabsService = serviceOf(dock, "sidebarRightTabs");
		if (tabsService === undefined || typeof tabsService.register !== "function") return;
		dock.effect(() => tabsService.register({
			id: DOCK_ID,
			kind: DOCK_KIND,
			priority: "extension",
			title: () => t("dock.title"),
			guide: [{ id: "az8-guide", order: 10, title: () => t("nav.title"), description: () => t("subtitle") }],
		}));
		dock.slots.inject("sidebar.right.pane.tab", () => dock.slots.register({
			name: "sidebar.right.pane.tab",
			key: DOCK_ID,
		}, (props) => Az8Panel(props, ctx)));
		dock.slots.inject("sidebar.right.pane.tab.title", () => dock.slots.register({
			name: "sidebar.right.pane.tab.title",
			key: DOCK_ID,
		}, () => h("span", null, t("dock.title"))));
	});
}

const inject = ["slots", "locale"];

exports.apply = apply;
exports.inject = inject;

return module.exports;
}});
