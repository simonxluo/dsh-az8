// dsh-az8 — Client half: 右侧停靠面板（运行 / 资产 / 设置）+ 设置页区块。
// UI 语言：Apple 工作台风 —— 毛玻璃卡片、iOS 分段控件、系统色、自动明暗、
// 骨架屏、灯箱预览。数据源是 Host 面板路由（GET state/credits，POST set-settings），
// 媒体走 /_dsh/dsh-az8/media。
window.__ModuleLoader__.load({ id: "dsh-az8", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";

const React = require("react");
const { useState, useEffect, useCallback, useRef, useMemo } = React;
const h = React.createElement;

const BASE = "/_dsh/dsh-az8"; // 绝对路径：对话 markdown 与面板共用同一组路由
const STATE_ROUTE = `${BASE}/state`;
const CREDITS_ROUTE = `${BASE}/credits`;
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
	const apply2 = () => {
		const tag = String(service.getSnapshot().active ?? "").toLowerCase();
		UI_LANG = tag.indexOf("zh") === 0 ? "zh" : "en";
		forceUpdate();
	};
	apply2();
	if (typeof service.subscribe !== "function") return () => {};
	return service.subscribe(apply2);
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
	"action.saved": { zh: "已保存 ✓", en: "Saved ✓" },
	"empty.runs": { zh: "还没有生成记录", en: "No runs yet" },
	"empty.runs.hint": { zh: "对话里说“用 AZ8 画一张…”即可", en: "Ask in chat to generate" },
	"empty.assets": { zh: "还没有产物", en: "No assets yet" },
	"empty.assets.hint": { zh: "生成成功后会自动落到这里", en: "Downloads land here" },
	"error.load": { zh: "加载失败：", en: "Load failed: " },
	"f.defaultProject": { zh: "默认项目", en: "Default project" },
	"f.maxAutoCredits": { zh: "报价闸门", en: "Quote gate" },
	"f.maxAutoCredits.unit": { zh: "credits，超过就停下问人", en: "credits, then ask" },
	"f.waitTimeout": { zh: "等待窗口", en: "Wait window" },
	"f.panelPoll": { zh: "面板刷新", en: "Panel poll" },
	"f.seconds": { zh: "秒", en: "s" },
	"f.none": { zh: "未设置（每次生成需指定）", en: "Not set" },
	"credits.balance": { zh: "credits", en: "credits" },
	"hint.clickImage": { zh: "点击图片查看大图", en: "Click image to enlarge" },
	"detail.back": { zh: "返回", en: "Back" },
	"detail.result": { zh: "产物", en: "Output" },
	"detail.flow": { zh: "流程", en: "Flow" },
	"detail.workflow": { zh: "工作流", en: "Workflow" },
	"detail.config": { zh: "参数", en: "Config" },
	"detail.prompt": { zh: "提示词", en: "Prompt" },
	"detail.inputs": { zh: "引用", en: "References" },
	"detail.inter": { zh: "中间产物", en: "Intermediates" },
	"detail.raw": { zh: "原始数据", en: "Raw data" },
	"detail.model": { zh: "模型", en: "Model" },
	"detail.version": { zh: "版本", en: "Version" },
	"detail.capability": { zh: "能力", en: "Capability" },
	"detail.estimate": { zh: "报价", en: "Quote" },
	"detail.actual": { zh: "实耗", en: "Actual" },
	"detail.factsError": { zh: "Run 事实暂时取不到：", en: "Run facts unavailable: " },
	"detail.fromRun": { zh: "来自", en: "from" },
	"step.target": { zh: "创建目标", en: "Create target" },
	"step.plan": { zh: "规划报价", en: "Plan & quote" },
	"step.submit": { zh: "提交生成", en: "Submit" },
	"step.run": { zh: "工作流运行", en: "Workflow run" },
	"step.assets": { zh: "产物入库", en: "Save output" },
	"note.single-step": { zh: "单步工作流：这次只有最终产物，没有中间产物。", en: "Single-step workflow: only the final output, no intermediates." },
	"note.no-assets": { zh: "Run 成功，但产物没有下载到本地。", en: "Run succeeded, but nothing was downloaded." },
	"note.indeterminate": { zh: "结果不确定：不要重试同一意图，先核对事实。", en: "Unclear result: reconcile the facts before retrying." },
	"note.unaffordable": { zh: "余额不足：确认也跑不了，先充值或换更便宜的模型。", en: "Insufficient credits: confirming won't help." },
	"note.awaiting-confirm": { zh: "等你确认报价后才会提交。", en: "Waiting for your OK on the quote." },
	"note.unfinished": { zh: "云端已跑完，本机还没收尾。", en: "Finished in the cloud, not finalized locally." },
	"note.not-planned": { zh: "没走到规划这一步就失败了。", en: "Failed before planning." },
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
	if (s < 60) return UI_LANG === "zh" ? "刚刚" : "now";
	if (s < 3600) return UI_LANG === "zh" ? `${Math.round(s / 60)} 分钟前` : `${Math.round(s / 60)}m ago`;
	if (s < 86400) return UI_LANG === "zh" ? `${Math.round(s / 3600)} 小时前` : `${Math.round(s / 3600)}h ago`;
	return new Date(iso).toLocaleDateString();
}
function fmtBytes(n) {
	if (!Number.isFinite(n) || n <= 0) return "";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function shortId(value, keep = 10) {
	const text = String(value ?? "");
	return text === "" || text.length <= keep + 3 ? text : text.slice(0, keep) + "…";
}
function fmtClock(iso) {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const pad = (n) => String(n).padStart(2, "0");
	const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	return date.toDateString() === new Date().toDateString() ? hm : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hm}`;
}
function fmtDuration(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return "";
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
	return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
function statusColor(status) {
	const key = (STATUS_META[status] ?? { key: "idle" }).key;
	return `var(--${key === "succeeded" ? "green" : key === "failed" ? "red" : key === "warn" ? "orange" : key === "running" ? "blue" : "gray"})`;
}

/** 媒体元素：图片可点开大图，视频/音频直接可播。 */
function Media({ kind, url, onOpen }) {
	const src = url ?? "";
	if (kind === "image") return h("img", { className: "media", src, loading: "lazy", onClick: onOpen });
	if (kind === "video") return h("video", { className: "media video", src, controls: true, preload: "metadata" });
	if (kind === "audio") return h("audio", { className: "media audio", src, controls: true, preload: "metadata" });
	return h("div", { className: "media", style: { display: "grid", placeItems: "center", color: "var(--text2)" } }, h(Glyph, { kind: "other" }));
}

/** 缩略格：媒体 + 底栏（标题 / 右侧补充）。zoom=true 时图片可点开灯箱。 */
function Tile({ kind, url, title, sub, zoom, onOpen }) {
	return h("div", { className: "az8-asset" + (zoom ? " img" : ""), onClick: zoom ? onOpen : undefined },
		h(Media, { kind, url, onOpen: zoom ? onOpen : undefined }),
		h("div", { className: "bar" },
			h(Glyph, { kind }),
			h("b", { title }, title),
			sub ? h("span", null, sub) : null,
		),
	);
}

const STATUS_META = {
	succeeded: { key: "succeeded", zh: "成功", en: "Done", light: "#34C759", dark: "#30D158" },
	failed: { key: "failed", zh: "失败", en: "Failed", light: "#FF3B30", dark: "#FF453A" },
	running: { key: "running", zh: "生成中", en: "Running", light: "#007AFF", dark: "#0A84FF" },
	starting: { key: "running", zh: "启动中", en: "Starting", light: "#007AFF", dark: "#0A84FF" },
	downloading: { key: "running", zh: "下载中", en: "Downloading", light: "#007AFF", dark: "#0A84FF" },
	planning: { key: "idle", zh: "规划中", en: "Planning", light: "#8E8E93", dark: "#98989D" },
	resolving: { key: "idle", zh: "准备中", en: "Preparing", light: "#8E8E93", dark: "#98989D" },
	awaiting_confirm: { key: "warn", zh: "待确认报价", en: "Awaiting OK", light: "#FF9500", dark: "#FF9F0A" },
	"needs-choice": { key: "warn", zh: "待选模型", en: "Pick model", light: "#FF9500", dark: "#FF9F0A" },
	indeterminate: { key: "warn", zh: "结果不确定", en: "Unclear", light: "#FF9500", dark: "#FF9F0A" },
};

// ---------------------------------------------------------------------------
// 样式（Apple 工作台）：明暗双 token，自动探测宿主主题
// ---------------------------------------------------------------------------

const CSS = `
.az8{--blue:#0A84FF;--green:#30D158;--red:#FF453A;--orange:#FF9F0A;--gray:#98989D;
 --text:#f5f5f7;--text2:rgba(235,235,245,.62);--text3:rgba(235,235,245,.36);
 --hairline:rgba(255,255,255,.10);--hairline2:rgba(255,255,255,.06);
 --surface:rgba(38,38,40,.66);--surface2:rgba(56,56,58,.55);--surface3:rgba(118,118,128,.20);
 --fill:rgba(120,120,128,.18);--shadow:0 1px 2px rgba(0,0,0,.28),0 10px 32px rgba(0,0,0,.22);
 --shadow-sm:0 1px 2px rgba(0,0,0,.22);
 font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;
 font-size:13px;line-height:1.45;color:var(--text);
 -webkit-font-smoothing:antialiased;display:flex;flex-direction:column;height:100%;min-height:0;}
.az8[data-theme="light"]{--green:#34C759;--red:#FF3B30;--orange:#FF9500;--blue:#007AFF;--gray:#8E8E93;
 --text:#1d1d1f;--text2:rgba(60,60,67,.62);--text3:rgba(60,60,67,.34);
 --hairline:rgba(0,0,0,.10);--hairline2:rgba(0,0,0,.05);
 --surface:rgba(255,255,255,.72);--surface2:rgba(255,255,255,.55);--surface3:rgba(118,118,128,.12);
 --fill:rgba(118,118,128,.12);
 --shadow:0 1px 2px rgba(0,0,0,.05),0 10px 32px rgba(0,0,0,.08);
 --shadow-sm:0 1px 2px rgba(0,0,0,.06);}
.az8 *{box-sizing:border-box;}
.az8 button{font-family:inherit;}

/* —— 头部 —— */
.az8-head{display:flex;align-items:center;gap:9px;padding:12px 16px 10px;}
.az8-mark{width:24px;height:24px;border-radius:7px;flex:none;display:grid;place-items:center;
 background:linear-gradient(135deg,#5B2BD9,#B82B8F);color:#fff;font-size:8.5px;font-weight:700;letter-spacing:.02em;
 box-shadow:0 2px 6px rgba(120,40,180,.35);}
.az8-title{font-size:15px;font-weight:650;letter-spacing:-.01em;}
.az8-sub{font-size:11px;color:var(--text2);margin-top:1px;display:none;}
.az8-credits{margin-left:auto;display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:999px;
 background:color-mix(in srgb,var(--green) 13%,transparent);color:var(--green);
 font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;border:1px solid color-mix(in srgb,var(--green) 22%,transparent);}
.az8-credits .dot{width:6px;height:6px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green);}
.az8-refresh{margin-left:8px;width:26px;height:26px;border-radius:8px;border:none;cursor:pointer;flex:none;
 background:var(--fill);color:var(--text2);font-size:13px;display:grid;place-items:center;transition:all .18s ease;}
.az8-refresh:hover{color:var(--text);background:var(--surface3);}
.az8-refresh.spin{animation:az8spin .8s linear infinite;}
@keyframes az8spin{to{transform:rotate(360deg)}}

/* —— 分段控件 —— */
.az8-seg{display:flex;margin:2px 16px 12px;padding:2px;border-radius:10px;background:var(--fill);}
.az8-seg button{flex:1;border:none;background:none;cursor:pointer;color:var(--text2);
 font-size:12.5px;font-weight:560;padding:5px 0;border-radius:8px;transition:all .18s ease;letter-spacing:-.01em;}
.az8-seg button.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow-sm);}
.az8[data-theme="light"] .az8-seg button.on{background:rgba(255,255,255,.95);}

/* —— 滚动区 —— */
.az8-body{flex:1;min-height:0;overflow-y:auto;padding:0 16px 18px;scrollbar-width:thin;}
.az8-body::-webkit-scrollbar{width:6px;}
.az8-body::-webkit-scrollbar-thumb{background:var(--fill);border-radius:3px;}

/* —— 卡片与列表 —— */
.az8-card{border-radius:14px;background:var(--surface);border:1px solid var(--hairline2);
 backdrop-filter:blur(24px) saturate(160%);-webkit-backdrop-filter:blur(24px) saturate(160%);
 box-shadow:var(--shadow-sm);padding:12px 14px;transition:all .18s ease;}
.az8-runs{display:flex;flex-direction:column;gap:10px;}
.az8-run-top{display:flex;align-items:center;gap:8px;}
.az8-dot{width:8px;height:8px;border-radius:50%;flex:none;}
.az8-run-name{font-size:13px;font-weight:600;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.az8-run-time{margin-left:auto;font-size:11.5px;color:var(--text2);font-variant-numeric:tabular-nums;flex:none;}
.az8-run-meta{display:flex;align-items:center;gap:6px;margin-top:7px;flex-wrap:wrap;}
.az8-chip{font-size:11px;color:var(--text2);background:var(--fill);padding:2px 8px;border-radius:6px;
 font-variant-numeric:tabular-nums;}
.az8-chip.credits{color:var(--orange);background:color-mix(in srgb,var(--orange) 12%,transparent);}
.az8-run-prompt{margin-top:7px;font-size:12px;color:var(--text2);
 display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.az8-run-err{margin-top:8px;font-size:11.5px;color:var(--red);background:color-mix(in srgb,var(--red) 10%,transparent);
 padding:5px 9px;border-radius:8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}

/* —— 资产网格 —— */
.az8-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
.az8-asset{border-radius:14px;overflow:hidden;background:var(--surface);border:1px solid var(--hairline2);
 box-shadow:var(--shadow-sm);transition:transform .2s ease,box-shadow .2s ease;cursor:default;}
.az8-asset.img{cursor:zoom-in;}
.az8-asset:hover{transform:translateY(-2px);box-shadow:var(--shadow);}
.az8-asset .media{width:100%;aspect-ratio:1/1;object-fit:cover;display:block;background:var(--fill);}
.az8-asset .media.video{object-fit:contain;}
.az8-asset .bar{display:flex;align-items:center;gap:5px;padding:6px 10px;font-size:11px;color:var(--text2);}
.az8-asset .bar b{color:var(--text);font-weight:600;}
.az8-asset .bar span{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--text3);}

/* —— 空态 / 骨架 —— */
.az8-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:44px 12px;text-align:center;}
.az8-empty .halo{width:54px;height:54px;border-radius:50%;background:var(--fill);display:grid;place-items:center;font-size:22px;}
.az8-empty .t1{font-size:13.5px;font-weight:600;color:var(--text2);}
.az8-empty .t2{font-size:12px;color:var(--text3);}
.az8-sk{border-radius:14px;background:var(--fill);height:74px;animation:az8pulse 1.2s ease-in-out infinite;}
@keyframes az8pulse{0%,100%{opacity:1}50%{opacity:.5}}

/* —— 设置（iOS 分组列表）—— */
.az8-group{margin-bottom:16px;}
.az8-group-h{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--text3);
 text-transform:uppercase;padding:0 12px 6px;}
.az8-rows{border-radius:12px;background:var(--surface);border:1px solid var(--hairline2);
 backdrop-filter:blur(24px) saturate(160%);-webkit-backdrop-filter:blur(24px) saturate(160%);overflow:hidden;}
.az8-row{display:flex;align-items:center;gap:10px;padding:10px 12px;}
.az8-row + .az8-row{border-top:1px solid var(--hairline2);}
.az8-row label{font-size:13px;flex:1;}
.az8-row .u{color:var(--text3);font-size:11px;margin-top:1px;}
.az8-input,.az8-select{font-family:inherit;font-size:13px;color:var(--text);background:var(--fill);
 border:1px solid transparent;border-radius:8px;padding:5px 9px;outline:none;transition:all .18s ease;
 min-width:96px;text-align:right;-moz-appearance:textfield;}
.az8-input:focus,.az8-select:focus{border-color:var(--blue);background:transparent;}
.az8-input::-webkit-inner-spin-button{display:none;}
.az8-select{cursor:pointer;text-align:left;padding-right:22px;appearance:none;
 background-image:linear-gradient(45deg,transparent 50%,var(--text2) 50%),linear-gradient(135deg,var(--text2) 50%,transparent 50%);
 background-position:calc(100% - 12px) 55%,calc(100% - 8px) 55%;background-size:4px 4px;background-repeat:no-repeat;}
.az8-save{width:100%;border:none;cursor:pointer;border-radius:10px;padding:9px 0;
 background:linear-gradient(180deg,color-mix(in srgb,var(--blue) 92%,#fff),var(--blue));
 color:#fff;font-size:13.5px;font-weight:600;letter-spacing:-.01em;
 box-shadow:0 2px 8px color-mix(in srgb,var(--blue) 35%,transparent);transition:all .18s ease;}
.az8-save:hover{filter:brightness(1.08);}
.az8-save:active{transform:scale(.98);filter:brightness(.95);}
.az8-flash{font-size:12px;color:var(--green);text-align:center;min-height:16px;margin-top:8px;}

/* —— 运行详情 —— */
.az8-run{cursor:pointer;}
.az8-run:hover{border-color:var(--hairline);}
.az8-run:active{transform:scale(.995);}
.az8-back{border:none;background:none;cursor:pointer;color:var(--blue);font-size:13px;font-weight:600;
 padding:2px 0 10px;display:block;}
.az8-kv{display:flex;align-items:baseline;gap:10px;padding:7px 12px;min-width:0;}
.az8-kv + .az8-kv{border-top:1px solid var(--hairline2);}
.az8-kv .k{font-size:12px;color:var(--text2);flex:none;width:76px;}
.az8-kv .v{font-size:12.5px;color:var(--text);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;}
.az8-prompt{padding:10px 12px;font-size:12.5px;color:var(--text);line-height:1.5;white-space:pre-wrap;word-break:break-word;}
.az8-json{margin:0;padding:10px 12px;font-size:10.5px;line-height:1.5;color:var(--text2);
 background:var(--fill);border-radius:10px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;}

/* —— 流程时间线（运行详情）—— */
.az8-steps{padding:4px 0;}
.az8-step{display:grid;grid-template-columns:14px minmax(0,1fr) auto;column-gap:9px;padding:6px 12px;position:relative;}
.az8-step .pt{width:8px;height:8px;border-radius:50%;margin-top:5px;background:var(--green);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--green) 16%,transparent);}
.az8-step::before{content:"";position:absolute;left:15.5px;top:0;bottom:0;width:1px;background:var(--hairline);}
.az8-step:first-child::before{top:15px;}
.az8-step:last-child::before{bottom:calc(100% - 15px);}
.az8-step:only-child::before{display:none;}
.az8-step.active .pt{background:var(--blue);box-shadow:0 0 0 3px color-mix(in srgb,var(--blue) 18%,transparent);
  animation:az8pulse 1.2s ease-in-out infinite;}
.az8-step.active .nm{color:var(--blue);}
.az8-step.wait .pt,.az8-step.unknown .pt{background:var(--orange);box-shadow:0 0 0 3px color-mix(in srgb,var(--orange) 18%,transparent);}
.az8-step.failed .pt{background:var(--red);box-shadow:0 0 0 3px color-mix(in srgb,var(--red) 18%,transparent);}
.az8-step.skipped .pt{background:transparent;border:1.5px solid var(--text3);box-shadow:none;}
.az8-step .nm{font-size:12.5px;font-weight:500;line-height:18px;}
.az8-step.skipped .nm{color:var(--text3);font-weight:400;}
.az8-step .ds{font-size:11.5px;color:var(--text2);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-variant-numeric:tabular-nums;}
.az8-step.failed .ds{color:var(--red);white-space:normal;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;}
.az8-step .at{font-size:11px;color:var(--text3);line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap;}
.az8-note{padding:8px 12px;font-size:11.5px;color:var(--text2);line-height:1.5;border-top:1px solid var(--hairline2);}
.az8-note.warn{color:var(--orange);}
.az8-detail-head{margin-bottom:14px;}

.az8-grid.one{grid-template-columns:1fr;}
.az8-grid.one .media{aspect-ratio:4/3;}
.az8-asset .media.audio{aspect-ratio:auto;height:auto;display:block;padding:10px 12px;}
.az8-credits.low{color:var(--orange);background:color-mix(in srgb,var(--orange) 13%,transparent);
  border-color:color-mix(in srgb,var(--orange) 22%,transparent);}
.az8-credits.low .dot{background:var(--orange);box-shadow:0 0 6px var(--orange);}

/* —— 灯箱 —— */
.az8-lightbox{position:fixed;inset:0;z-index:1200;display:grid;place-items:center;cursor:zoom-out;
 background:rgba(0,0,0,.78);backdrop-filter:blur(20px) saturate(120%);-webkit-backdrop-filter:blur(20px) saturate(120%);
 animation:az8fade .2s ease;}
.az8-lightbox img{max-width:92vw;max-height:92vh;border-radius:12px;box-shadow:0 24px 80px rgba(0,0,0,.5);
 animation:az8zoom .22s cubic-bezier(.2,.9,.3,1.2);cursor:default;}
@keyframes az8fade{from{opacity:0}}
@keyframes az8zoom{from{transform:scale(.95);opacity:.4}}
`;

function useTheme() {
	const [theme, setTheme] = useState("dark");
	useEffect(() => {
		let alive = true;
		const detect = () => {
			try {
				const bg = getComputedStyle(document.body).backgroundColor;
				const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg || "");
				if (m !== null) {
					const lum = (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255;
					if (alive) setTheme(lum > 0.6 ? "light" : "dark");
				}
			} catch (e) { /* 保持默认 */ }
		};
		detect();
		const timer = setTimeout(detect, 1500);
		return () => { alive = false; clearTimeout(timer); };
	}, []);
	return theme;
}

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
// 组件
// ---------------------------------------------------------------------------

function Glyph({ kind }) {
	const common = { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", style: { flex: "none", opacity: 0.75 } };
	if (kind === "video") return h("svg", common,
		h("rect", { x: 1.5, y: 3.5, width: 13, height: 9, rx: 2.5, stroke: "currentColor", strokeWidth: 1.4 }),
		h("path", { d: "M6.6 6.4v3.2L9.6 8z", fill: "currentColor" }));
	if (kind === "audio") return h("svg", common,
		h("path", { d: "M3 7v2M6 4.5v7M9 6v4M12 4v8", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" }));
	if (kind === "other") return h("svg", common,
		h("path", { d: "M8 2v8.5M8 10.5l-2.8-2.8M8 10.5l2.8-2.8M3 13h10", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" }));
	return h("svg", common, // image
		h("rect", { x: 1.8, y: 2.8, width: 12.4, height: 10.4, rx: 2.4, stroke: "currentColor", strokeWidth: 1.4 }),
		h("circle", { cx: 5.6, cy: 6.4, r: 1.15, fill: "currentColor" }),
		h("path", { d: "M3.4 11.2l3.1-3a1.4 1.4 0 0 1 1.9-.05L14 13", stroke: "currentColor", strokeWidth: 1.4, strokeLinejoin: "round" }));
}

function RunCard({ run, projectName, onOpenDetail }) {
	const meta = STATUS_META[run.status] ?? { zh: run.status, en: run.status, light: "#8E8E93", dark: "#98989D" };
	const label = UI_LANG === "zh" ? meta.zh : meta.en;
	const color = `var(--${meta.key === "succeeded" ? "green" : meta.key === "failed" ? "red" : meta.key === "warn" ? "orange" : meta.key === "running" ? "blue" : "gray"})`;
	const credits = [];
	if (run.creditsEstimated != null) credits.push(`≈ ${run.creditsEstimated}`);
	if (run.creditsActual != null) credits.push(`实耗 ${run.creditsActual}`);
	const name = run.definitionName || projectName || run.projectId || t("nav.title");
	return h("div", { className: "az8-card az8-run", onClick: () => onOpenDetail(run.id) },
		h("div", { className: "az8-run-top" },
			h("span", { className: "az8-dot", style: { background: color, boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 18%, transparent)` } }),
			h("span", { className: "az8-run-name" }, `${name} · ${label}`),
			h("span", { className: "az8-run-time" }, relTime(run.startedAt || run.endedAt)),
		),
		h("div", { className: "az8-run-meta" },
			h(Glyph, { kind: run.target }),
			h("span", { className: "az8-chip" }, run.id),
			projectName ? h("span", { className: "az8-chip" }, projectName) : null,
			credits.length > 0 ? h("span", { className: "az8-chip credits" }, credits.join("  ·  ")) : null,
		),
		run.prompt ? h("div", { className: "az8-run-prompt" }, run.prompt) : null,
		run.error ? h("div", { className: "az8-run-err" }, run.error.message) : null,
	);
}

/** 流程时间线的一行（design §4.3）：done 绿 / active 蓝 / wait·unknown 橙 / failed 红 / skipped 空心。 */
function StepLine({ step }) {
	const zh = UI_LANG === "zh";
	let detail = "";
	if (step.key === "target" && step.id) detail = shortId(String(step.id).replace(/^view_node_/, ''));
	else if (step.key === "plan") {
		detail = [
			step.estimate != null ? `${zh ? "报价" : "quote"} ${step.estimate} cr` : "",
			step.actual != null ? `${zh ? "实耗" : "actual"} ${step.actual} cr` : "",
		].filter(Boolean).join(" · ");
	} else if (step.key === "submit" && step.id) detail = shortId(step.id, 12);
	else if (step.key === "run") {
		detail = [
			step.durationMs != null ? fmtDuration(step.durationMs) : "",
			step.state === "active" && step.progress != null ? `${Math.round(step.progress * 100)}%` : "",
		].filter(Boolean).join(" · ");
	} else if (step.key === "assets" && step.count > 0) detail = `${step.count} ${zh ? "个" : "files"} · ${fmtBytes(step.bytes)}`;
	if (step.error) detail = step.error;
	return h("div", { className: `az8-step ${step.state}`, "aria-label": `az8-step-${step.key}` },
		h("span", { className: "pt" }),
		h("div", { className: "tx" },
			h("div", { className: "nm" }, t(`step.${step.key}`)),
			detail !== "" ? h("div", { className: "ds", title: detail }, detail) : null,
		),
		step.at ? h("span", { className: "at" }, fmtClock(step.at)) : null,
	);
}

/**
 * 运行详情（design §4.3）：产物 → 流程时间线 → 工作流 / 参数 / 提示词 → 引用（上游血缘）→ 中间产物。
 * 数据源 GET /_dsh/dsh-az8/detail?run=，全部是真实事实：时间戳缺了就不显示，中间产物没有就明说。
 */
function RunDetail({ runId, onClose, onOpenImage }) {
	const [data, setData] = useState(null);
	const [err, setErr] = useState("");
	useEffect(() => {
		let alive = true;
		setData(null); setErr("");
		fetchJson(`${BASE}/detail?run=${encodeURIComponent(runId)}`)
			.then((json) => { if (alive) setData(json); })
			.catch((e) => { if (alive) setErr(String(e.message ?? e)); });
		return () => { alive = false; };
	}, [runId]);
	const back = h("button", { className: "az8-back", onClick: onClose, "aria-label": "az8-detail-back" }, "‹ " + t("detail.back"));
	if (err !== "") return h("div", null, back, h("div", { style: { padding: 24, color: "var(--orange)", fontSize: 12 } }, t("error.load") + err));
	if (data === null) return h("div", null, back, h("div", { className: "az8-runs" }, h("div", { className: "az8-sk", style: { height: 120 } })));

	const run = data.run ?? {};
	const workflow = data.workflow ?? {};
	const steps = Array.isArray(data.steps) ? data.steps : [];
	const notes = Array.isArray(data.notes) ? data.notes : [];
	const results = Array.isArray(data.assets) ? data.assets : [];
	const inputs = Array.isArray(data.inputs) ? data.inputs : [];
	const inter = Array.isArray(data.intermediates) ? data.intermediates : [];
	const config = data.config ?? {};
	const meta = STATUS_META[run.status] ?? { zh: run.status, en: run.status };
	const KV = (k, v) => h("div", { className: "az8-kv" }, h("span", { className: "k" }, k), h("span", { className: "v", title: String(v) }, v));
	const rows = (...children) => h("div", { className: "az8-rows" }, ...children.filter(Boolean));
	const section = (key, body) => (body
		? h("div", { className: "az8-group", "aria-label": `az8-section-${key.split(".")[1]}` }, h("div", { className: "az8-group-h" }, t(key)), body)
		: null);
	const grid = (items, render) => h("div", { className: "az8-grid" + (items.length === 1 ? " one" : "") }, items.map(render));
	const mediaUrl = (item) => item.url
		?? (item.assetId ? `${BASE}/media?id=${encodeURIComponent(item.assetId)}`
			: item.id ? `${BASE}/media?id=${encodeURIComponent(item.id)}` : "");

	return h("div", { className: "az8-detail" },
		back,
		h("div", { className: "az8-card az8-detail-head" },
			h("div", { className: "az8-run-top" },
				h("span", { className: "az8-dot", style: { background: statusColor(run.status), boxShadow: "0 0 0 3px color-mix(in srgb, " + statusColor(run.status) + " 18%, transparent)" } }),
				h("span", { className: "az8-run-name" }, `${workflow.definitionName || shortId(workflow.definitionId, 14) || t("nav.title")} · ${UI_LANG === "zh" ? meta.zh : meta.en}`),
				h("span", { className: "az8-run-time" }, run.startedAt ? fmtClock(run.startedAt) : ""),
			),
		),
		results.length > 0 ? section("detail.result", grid(results, (a) => h(Tile, {
			key: a.id, kind: a.kind, url: mediaUrl(a), zoom: a.kind === "image" && mediaUrl(a) !== "", onOpen: () => onOpenImage(mediaUrl(a)),
			title: a.slotName || a.id, sub: fmtBytes(a.bytes),
		}))) : null,
		section("detail.flow", rows(
			h("div", { className: "az8-steps" }, steps.map((step) => h(StepLine, { key: step.key, step }))),
			notes.map((key) => h("div", { key, className: "az8-note" }, t(`note.${key}`))),
			data.factsError ? h("div", { className: "az8-note warn" }, t("detail.factsError") + data.factsError) : null,
		)),
		section("detail.workflow", rows(
			KV(t("detail.model"), workflow.definitionName || (workflow.definitionId ? shortId(workflow.definitionId) : "—")),
			workflow.definitionVersion != null ? KV(t("detail.version"), `v${workflow.definitionVersion}`) : null,
			workflow.capability ? KV(t("detail.capability"), workflow.capability) : null,
			workflow.note ? h("div", { className: "az8-note" }, t(`note.${workflow.note}`)) : null,
			run.creditsEstimated != null ? KV(t("detail.estimate"), `${run.creditsEstimated} cr`) : null,
			run.creditsActual != null ? KV(t("detail.actual"), `${run.creditsActual} cr`) : null,
			run.workflowRunId ? KV("Run", shortId(run.workflowRunId, 16)) : null,
		)),
		Object.keys(config).length > 0 ? section("detail.config", rows(
			Object.entries(config).map(([k, v]) => KV(k, typeof v === "string" ? v : JSON.stringify(v))),
		)) : null,
		run.prompt ? section("detail.prompt", rows(h("div", { className: "az8-prompt" }, run.prompt))) : null,
		inputs.length > 0 ? section("detail.inputs", grid(inputs, (input, i) => {
			const url = mediaUrl(input);
			const kind = input.kind || "other";
			return h(Tile, {
				key: `${input.viewNodeId}-${i}`, kind, url, zoom: kind === "image" && url !== "", onOpen: () => onOpenImage(url),
				title: input.slotName || "reference",
				sub: input.upstreamRunId ? `${t("detail.fromRun")} ${input.upstreamRunId}` : "",
			});
		})) : null,
		inter.length > 0 ? section("detail.inter", grid(inter, (item, i) => h(Tile, {
			key: item.coreNodeId || i, kind: item.kind || "other", url: item.url,
			zoom: item.kind === "image" && !!item.url, onOpen: () => onOpenImage(item.url),
			title: item.slotName || `output ${i + 1}`, sub: shortId(item.coreNodeId),
		}))) : null,
		h("div", { className: "az8-raw" },
			h("div", { className: "az8-group-h", style: { cursor: "pointer" }, onClick: (e) => {
				const el = e.currentTarget.nextElementSibling;
				el.style.display = el.style.display === "none" ? "block" : "none";
			} }, `▸ ${t("detail.raw")}`),
			h("pre", { className: "az8-json", style: { display: "none" } }, JSON.stringify({ ...data, assets: undefined }, null, 1).slice(0, 4000)),
		),
	);
}

function RunsTab({ runs, projects, onOpenDetail }) {
	// projectName 可能存的是项目 id（早期缓存为空时写入的），用项目缓存换成真名
	const nameOf = (run) => {
		const cached = (projects ?? []).find((p) => p.id === run.projectId)?.name ?? "";
		return cached || (/^[0-9a-f]{32}$/i.test(run.projectName ?? "") ? "" : run.projectName);
	};
	if (runs === null) return h("div", { className: "az8-runs" },
		h("div", { className: "az8-sk" }), h("div", { className: "az8-sk" }), h("div", { className: "az8-sk" }));
	if (!runs || runs.length === 0) return h("div", { className: "az8-empty" },
		h("div", { className: "halo" }, "✨"),
		h("div", { className: "t1" }, t("empty.runs")),
		h("div", { className: "t2" }, t("empty.runs.hint")));
	return h("div", { className: "az8-runs" }, runs.map((run) => h(RunCard, { key: run.id, run, projectName: nameOf(run), onOpenDetail })));
}

function AssetCard({ asset, onOpen }) {
	return h(Tile, {
		kind: asset.kind, url: asset.url, zoom: asset.kind === "image", onOpen: () => onOpen(asset),
		title: asset.runId ?? "—", sub: fmtBytes(asset.bytes),
	});
}

function AssetsTab({ assets, onOpen }) {
	if (assets === null) return h("div", { className: "az8-grid" },
		h("div", { className: "az8-sk", style: { height: 0, paddingTop: "100%" } }),
		h("div", { className: "az8-sk", style: { height: 0, paddingTop: "100%" } }));
	if (!assets || assets.length === 0) return h("div", { className: "az8-empty" },
		h("div", { className: "halo" }, "🖼"),
		h("div", { className: "t1" }, t("empty.assets")),
		h("div", { className: "t2" }, t("empty.assets.hint")));
	return h("div", { className: "az8-grid" },
		assets.map((asset) => h(AssetCard, { key: asset.id, asset, onOpen })));
}

function Row({ label, unit, children }) {
	return h("div", { className: "az8-row" },
		h("label", null, label, unit ? h("div", { className: "u" }, unit) : null),
		children);
}

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
	if (form === null) return h("div", { className: "az8-runs" }, h("div", { className: "az8-sk", style: { height: 180 } }));
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
	return h("div", null,
		h("div", { className: "az8-group" },
			h("div", { className: "az8-group-h" }, "Project"),
			h("div", { className: "az8-rows" },
				h(Row, { label: t("f.defaultProject") },
					h("select", {
						className: "az8-select", value: form.defaultProjectId, onChange: set("defaultProjectId"),
						style: { maxWidth: 150 },
					},
						h("option", { value: "" }, t("f.none")),
						(snapshot?.projects ?? []).map((p) => h("option", { key: p.id, value: p.id }, p.name || p.id)),
					)),
			),
		),
		h("div", { className: "az8-group" },
			h("div", { className: "az8-group-h" }, "Generation"),
			h("div", { className: "az8-rows" },
				h(Row, { label: t("f.maxAutoCredits"), unit: t("f.maxAutoCredits.unit") },
					h("input", { className: "az8-input", type: "number", min: 0, value: form.maxAutoCredits, onChange: set("maxAutoCredits"), style: { width: 76 } })),
				h(Row, { label: t("f.waitTimeout"), unit: t("f.seconds") },
					h("input", { className: "az8-input", type: "number", min: 5, max: 900, value: form.waitTimeoutS, onChange: set("waitTimeoutS"), style: { width: 76 } })),
			),
		),
		h("div", { className: "az8-group" },
			h("div", { className: "az8-group-h" }, "Panel"),
			h("div", { className: "az8-rows" },
				h(Row, { label: t("f.panelPoll"), unit: t("f.seconds") },
					h("input", { className: "az8-input", type: "number", min: 1, max: 60, value: form.panelPollS, onChange: set("panelPollS"), style: { width: 76 } })),
			),
		),
		h("button", { className: "az8-save", onClick: save }, t("action.save")),
		h("div", { className: "az8-flash" }, flash),
	);
}

function Az8Panel(props, ctx) {
	const [tab, setTab] = useState("runs");
	const [snapshot, setSnapshot] = useState(null);
	const [credits, setCredits] = useState(null);
	const [error, setError] = useState("");
	const [spinning, setSpinning] = useState(false);
	const [lightbox, setLightbox] = useState(null);
	const [detailRunId, setDetailRunId] = useState(null);
	const [, bump] = useState(0);
	const theme = useTheme();
	const styleTag = useMemo(() => h("style", { dangerouslySetInnerHTML: { __html: CSS } }), []);
	useEffect(() => { listeners.push(bump); return () => { listeners = listeners.filter((fn) => fn !== bump); }; }, []);
	useEffect(() => {
		const onKey = (event) => { if (event.key === "Escape") setLightbox(null); };
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const reload = useCallback(async () => {
		setSpinning(true);
		try {
			const json = await fetchJson(`${STATE_ROUTE}?refresh=projects`);
			setSnapshot(json);
			setError("");
		} catch (e) { setError(String(e.message ?? e)); }
		setSpinning(false);
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
	const tabs = [["runs", "az8-tab-runs", t("tab.runs")], ["assets", "az8-tab-assets", t("tab.assets")], ["settings", "az8-tab-settings", t("tab.settings")]];
	return h("div", { className: "az8", "data-theme": theme },
		styleTag,
		h("div", { className: "az8-head" },
			h("div", { className: "az8-mark" }, "A8"),
			h("div", null, h("div", { className: "az8-title" }, t("nav.title"))),
			balance ? h("span", { className: `az8-credits${Number(balance.availableCredits) <= 0 ? " low" : ""}`, "aria-label": "az8-credits" },
				h("span", { className: "dot" }),
				`${Number(balance.availableCredits ?? 0).toLocaleString()} ${t("credits.balance")}`) : null,
			h("button", { className: `az8-refresh${spinning ? " spin" : ""}`, title: t("action.refresh"), onClick: reload }, "⟳"),
		),
		h("div", { className: "az8-seg" },
			tabs.map(([key, aria, label]) => h("button", {
				key, "aria-label": aria, className: tab === key ? "on" : "", onClick: () => setTab(key),
			}, label)),
		),
		error ? h("div", { style: { padding: "2px 16px 8px", fontSize: 12, color: "var(--orange)" } }, t("error.load") + error) : null,
		h("div", { className: "az8-body" },
			tab === "runs" ? (detailRunId !== null
				? h(RunDetail, { runId: detailRunId, onClose: () => setDetailRunId(null), onOpenImage: (url) => setLightbox({ url }) })
				: h(RunsTab, { runs: snapshot?.runs ?? null, projects: snapshot?.projects ?? [], onOpenDetail: setDetailRunId }))
			: tab === "assets" ? h(AssetsTab, { assets: snapshot?.assets ?? null, onOpen: setLightbox })
			: h(SettingsTab, { snapshot, reload }),
		),
		lightbox !== null ? h("div", { className: "az8-lightbox", onClick: () => setLightbox(null) },
			h("img", { src: lightbox.url, onClick: (e) => e.stopPropagation() }),
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
