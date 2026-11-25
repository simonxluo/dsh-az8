/**
 * client.js 结构自检（design §11-4b）：不渲染、不碰浏览器，只对源码做几条"装错了就会静默失效"的断言。
 * 右栏页签 / 左栏入口 / 主面板页 / 设置区块四处注册，任何一处 id 对不上，宿主都不会报错，只是入口消失。
 * 运行：node test/client.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

// 1) 工厂形态：window.__ModuleLoader__.load({ id, factory })，factory 体必须是合法 JS
const factory = /window\.__ModuleLoader__\.load\(\{ id: "dsh-az8", factory: \(require\) => \{([\s\S]*?)\n\}\}\);\s*$/.exec(src);
assert.ok(factory !== null, 'client.js 必须以 __ModuleLoader__.load 工厂结尾');
const body = factory[1];
new Function('require', body); // 语法错误会在这里抛
assert.match(src.slice(0, src.indexOf('window.__ModuleLoader__')), /dsh-az8[\s\S]*Client half/, '文件头注释说明这是 Client 半边');

// 2) 不 require 宿主 Client 包（DSH 规则：这些包随时变，require 不到会让整个入口白屏）
const requires = [...body.matchAll(/\brequire\((["'])([^"']+)\1\)/g)].map((m) => m[2]);
assert.deepEqual(requires.filter((n) => n !== 'react'), [], '只允许 require("react")');

// 3) 四处注册：id / key 的配对关系
const injects = [...body.matchAll(/slots\.inject\(\s*"([a-z.]+)"\s*,\s*\(\)\s*=>\s*[a-zA-Z.]*slots\.register\(\s*\{([\s\S]*?)\}\s*,/g)];
const reg = (slot) => { const hit = injects.find((m) => m[1] === slot); assert.ok(hit !== undefined, `缺少 ${slot} 注册`); return hit[2]; };
// regSrc(slot)：从 inject 起到组件实参为止的原文（含组件），用来断言"渲染的是哪个组件"。
// 右栏页签注册在子上下文上（dock.slots.inject），所以接收者不限定。
const regSrc = (slot) => { const at = body.search(new RegExp(`slots\\.inject\\("${slot.replaceAll(".", "\\.")}"`)); assert.ok(at >= 0, `找不到 ${slot} 的 inject`); return body.slice(at, at + 420); };
const field = (text, name) => { const m = new RegExp(`\\b${name}:\\s*([^,\\n]+)`).exec(text); return m === null ? null : m[1].trim(); };

assert.equal(field(reg('sidebar.panellist'), 'name'), '"sidebar.panellist"', 'panellist 注册的 name 必须与槽同名');
assert.equal(field(reg('sidebar.panellist'), 'id'), 'PANEL_ID');
assert.equal(field(reg('main'), 'key'), 'PANEL_ID', '左栏行 id 与主面板页 key 必须是同一个 id，否则点了行没有页面');
assert.equal(field(reg('settings.section'), 'id'), '"dsh-az8"');
assert.equal(field(reg('sidebar.right.pane.tab'), 'key'), 'DOCK_ID');
assert.equal(field(reg('sidebar.right.pane.tab.title'), 'key'), 'DOCK_ID', '页签正文与标题用同一个 key');

// 常量：左栏行顺序排在已发布的 插件(0)/自动化任务(10) 之后
assert.match(body, /const PANEL_ID = "dsh-az8";/);
assert.match(body, /const PANEL_ORDER = 20;/);

// 4) 标签跟随界面语言：入口标签是函数，不是写死的一种语言
const panellist = reg('sidebar.panellist');
assert.match(panellist, /label:\s*\(\)\s*=>\s*t\("nav\.title"\)/, 'panellist 的 label 必须是 () => t(...)，跟随 locale');

// 5) 图标：纯函数，只读 size / active，不碰 DOM / 定时器 / 状态
const icon = /function Az8PanelIcon\(\{ size, active \}\) \{([\s\S]*?)\n\}\n/.exec(body);
assert.ok(icon !== null, '缺少 Az8PanelIcon');
assert.doesNotMatch(icon[1], /document\.|window\.|setTimeout|setInterval|useState|useEffect|fetch\(/, '图标必须是纯渲染');
assert.match(icon[1], /"aria-hidden": "true"/, '装饰性图标对读屏隐藏（行自己有标签）');
assert.match(icon[1], /currentColor/, '图标颜色跟随所在行的选中态配色');

// 6) 主面板页复用同一个面板组件，只换布局变体；不复制组件、不复制样式表
const page = reg('main');
assert.match(regSrc('main'), /Az8Panel\(pageProps, ctx, "page"\)/, '主面板页必须复用 Az8Panel(variant "page")');
assert.match(regSrc('sidebar.right.pane.tab'), /Az8Panel\(props, ctx\)\)/, '右栏页签用默认变体');
assert.equal((body.match(/^function Az8Panel\(/gm) ?? []).length, 1, 'Az8Panel 只定义一次');
assert.match(body, /function Az8Panel\(props, ctx, variant = "dock"\) \{/);
assert.match(body, /variant === "page" \? "az8 az8-page" : "az8"/, 'page 变体只多一个类名');

// 7) 样式表：花括号配对；page 变体有避让红绿灯与左上角控件的内边距；样式只注入一次
const css = /const CSS = `([\s\S]*?)`;\n/.exec(body);
assert.ok(css !== null, '找不到样式表');
assert.equal((css[1].match(/{/g) ?? []).length, (css[1].match(/}/g) ?? []).length, 'CSS 花括号必须配对');
assert.match(css[1], /\.az8-page \.az8-head\{[^}]*--dsh-frame-top-clearance/);
assert.match(css[1], /\.az8-page \.az8-head\{[^}]*--dsh-frame-leading-clearance/);
assert.match(css[1], /\.az8-page \.az8-seg\{[^}]*--dsh-frame-leading-clearance/);
assert.match(css[1], /@media \(max-width:640px\)\{\.az8-page\{--page-gutter:16px;\}/, '窄屏收窄页边距');
assert.equal((body.match(/dangerouslySetInnerHTML/g) ?? []).length, 1, '样式表只通过一个 <style> 注入');
// 容器与控件跟宿主主题 token（§13b-12）：面板变量都带兜底
for (const v of ['--text', '--surface', '--fill', '--hairline', '--hairline2']) {
	assert.match(css[1], new RegExp(`\\n ${v}:var\\(--dsw-alias-[a-z0-9-]+,`), `${v} 应接到宿主 token 并带兜底`);
}

// 8) 运行时收尾：apply 导出、inject 清单只列可选依赖之外的东西
assert.match(body, /exports\.apply = apply;/);
assert.match(body, /exports\.inject = inject;/);

console.log('client.test.mjs ✅ 全部通过（8 组）');
