/**
 * panel 路由单测：真 HTTP server + 真 panel.js，orchestrator 用最小假件（不碰 az8）。
 * 重点：handler 永不向宿主漏异常；"请求不成立"回 4xx，内部错误回 500；媒体 Range/206；
 * 预览缓存 key 的清洗；回环 / Host 校验；跨站写入拦截。
 * 运行：node test/panel.test.mjs（DSH_AZ8_* 指到临时目录）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { connect } from 'node:net';

const dir = await mkdtemp(join(tmpdir(), 'dsh-az8-panel-'));
process.env.DSH_AZ8_STATE = join(dir, 'state.json');
process.env.DSH_AZ8_ASSETS = join(dir, 'assets');
process.env.DSH_AZ8_SKILLS = join(dir, 'skills');

const store = await import('../store.js');
const { installPanelWeb, STATE_ROUTE, CREDITS_ROUTE, MEDIA_ROUTE, DETAIL_ROUTE, CACHE_ROUTE } = await import('../panel.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(240, 7)]);
await mkdir(join(dir, 'assets', '.cache'), { recursive: true });
await writeFile(join(dir, 'assets', 'r1-a1.png'), PNG);
await writeFile(join(dir, 'assets', '.cache', 'c_abc123.png'), PNG);
await writeFile(join(dir, 'assets', '.cache', 'empty.png'), Buffer.alloc(0));
await store.mutate((s) => {
	store.appendRun(s, { id: 'r1', projectId: 'p1', projectName: 'P1', target: 'image', prompt: 'x', definitionId: '', definitionName: '', status: 'succeeded', viewNodeId: 'vn-1', workflowRunId: 'wr-1', assets: ['a1'], error: null, confirm: null });
	store.appendAsset(s, { id: 'a1', runId: 'r1', projectId: 'p1', kind: 'image', filename: 'r1-a1.png', mime: 'image/png', bytes: PNG.length, viewNodeId: '', coreNodeId: 'cn-1', downloadedAt: '2026-11-20T10:01:00.000Z' });
});

const calls = { detail: [], credits: 0 };
const orch = {
	status: async () => ({ whoami: { nickname: 'n' }, credits: [], session: { active: false }, settings: store.loadState().settings, projects: [] }),
	runDetail: async (id) => {
		calls.detail.push(id);
		if (id === 'gone') throw new store.StoreError(`run ${id} 不存在`);
		if (id === 'boom') throw new Error('kaboom\nsecond line');
		return {
			ok: true, run: { id, status: 'succeeded' }, steps: [], notes: [], workflow: {}, config: {}, outputs: [],
			inputs: [{ viewNodeId: 'vn-ref', assetId: 'a1' }],
			intermediates: [{ coreNodeId: 'abc123', kind: 'image', url: '/_dsh/dsh-az8/cache?node=c_abc123&ext=png' }],
			assets: [{ id: 'a1', kind: 'image', slotName: 'image_urls' }],
		};
	},
};
const creditsProvider = async () => { calls.credits++; return { whoami: { nickname: 'n' }, credits: [{ availableCredits: 0, payer: 'personal' }] }; };

const routes = new Map();
const ctx = { inject: (_names, cb) => cb({ effect: (fn) => { fn(); }, webServer: { register: (route) => { routes.set(route.path, route.handler); } } }) };
installPanelWeb(ctx, orch, creditsProvider);
assert.equal(routes.size, 5, '五条面板路由全部注册');

// 真宿主语义：handler 抛出即进程崩溃——这里用 uncaughtException / rejected 计数代替
let leaked = 0;
process.on('uncaughtException', () => { leaked++; });
const server = createServer((req, res) => {
	const handler = routes.get(new URL(req.url, 'http://localhost').pathname);
	if (handler === undefined) { res.writeHead(404); res.end(); return; }
	handler(req, res).catch(() => { leaked++; });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// 所有请求都走这里，并且总是读完响应体：没读完的响应体会让 keep-alive 连接关不掉，
// server.close() 就永远不回调（表现成测试静默挂起）。
const call = async (path, { method = 'GET', headers = {}, body } = {}) => {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });
	const buffer = Buffer.from(await res.arrayBuffer());
	return { status: res.status, headers: res.headers, body: buffer, text: buffer.toString('utf8') };
};
const post = (path, headers, body = '{}') => call(path, { method: 'POST', headers, body });

// 1) detail：正常 / 不存在(404) / 内部错误(500)，都只回一行错误，不漏异常
{
	const ok = await call(`${DETAIL_ROUTE}?run=r1`);
	assert.equal(ok.status, 200);
	const json = JSON.parse(ok.text);
	assert.equal(json.ok, true);
	assert.equal(json.assets[0].url, `${MEDIA_ROUTE}?id=a1`, '产物按 id 补媒体 URL');
	assert.equal(json.inputs[0].url, `${MEDIA_ROUTE}?id=a1`, '引用按 assetId 补媒体 URL');
	assert.equal(json.intermediates[0].url, '/_dsh/dsh-az8/cache?node=c_abc123&ext=png', '中间产物保留预览缓存 URL');

	const gone = await call(`${DETAIL_ROUTE}?run=gone`);
	assert.equal(gone.status, 404, 'run 不存在是 404，不是 500');
	assert.equal(JSON.parse(gone.text).error, 'run gone 不存在');

	const boom = await call(`${DETAIL_ROUTE}?run=boom`);
	assert.equal(boom.status, 500, '内部错误才是 500');
	assert.equal(JSON.parse(boom.text).ok, false);
	assert.equal(JSON.parse(boom.text).error, 'kaboom', '错误只取第一行');

	const none = await call(DETAIL_ROUTE);
	assert.equal(none.status, 400);
	assert.equal(JSON.parse(none.text).error, 'missing ?run=<runId>');
}

// 2) state：只读快照 + 媒体 URL；set-settings 校验失败回 400
{
	const state = await call(STATE_ROUTE);
	assert.equal(state.status, 200);
	const json = JSON.parse(state.text);
	assert.deepEqual(json.runs.map((r) => r.id), ['r1']);
	assert.equal(json.assets[0].url, `${MEDIA_ROUTE}?id=a1`);

	const bad = await post(STATE_ROUTE, { 'content-type': 'application/json' }, JSON.stringify({ action: 'set-settings', patch: { maxAutoCredits: -5 } }));
	assert.equal(bad.status, 400, '非法 settings 是 400');
	assert.match(JSON.parse(bad.text).error, /maxAutoCredits/);
}

// 3) credits：假件打一次后走缓存
{
	const first = await call(CREDITS_ROUTE);
	const second = await call(CREDITS_ROUTE);
	assert.equal(JSON.parse(first.text).credits[0].availableCredits, 0);
	assert.equal(JSON.parse(second.text).credits[0].availableCredits, 0);
	assert.equal(calls.credits, 1, '5 分钟内只活查一次');
}

// 4) media：200 / Range 206 / 416 / 404
{
	const whole = await call(`${MEDIA_ROUTE}?id=a1`);
	assert.equal(whole.status, 200);
	assert.equal(whole.body.length, PNG.length);
	assert.equal(whole.headers.get('content-type'), 'image/png');
	assert.equal(whole.headers.get('accept-ranges'), 'bytes');

	const part = await call(`${MEDIA_ROUTE}?id=a1`, { headers: { range: 'bytes=8-31' } });
	assert.equal(part.status, 206);
	assert.equal(part.body.length, 24);
	assert.equal(part.headers.get('content-range'), `bytes 8-31/${PNG.length}`);
	assert.deepEqual(part.body, PNG.subarray(8, 32), 'Range 切片内容正确');

	const unsatisfiable = await call(`${MEDIA_ROUTE}?id=a1`, { headers: { range: 'bytes=999999-' } });
	assert.equal(unsatisfiable.status, 416);
	assert.equal(unsatisfiable.headers.get('content-range'), `bytes */${PNG.length}`);

	const unknown = await call(`${MEDIA_ROUTE}?id=zz`);
	assert.equal(unknown.status, 404);
}

// 5) cache：预览缓存按 key 寻址；key 被清洗（无路径穿越）；空文件不算命中
{
	const hit = await call(`${CACHE_ROUTE}?node=c_abc123&ext=png`);
	assert.equal(hit.status, 200);
	assert.equal(hit.headers.get('content-type'), 'image/png');
	assert.equal(hit.body.length, PNG.length);

	const traversal = await call(`${CACHE_ROUTE}?node=..%2F..%2Fr1-a1&ext=png`);
	assert.equal(traversal.status, 404, '穿越字符被清洗成不存在的 key');

	const empty = await call(`${CACHE_ROUTE}?node=empty&ext=png`);
	assert.equal(empty.status, 404, '0 字节缓存不算命中');

	const missingKey = await call(`${CACHE_ROUTE}?ext=png`);
	assert.equal(missingKey.status, 400);
}

// 6) 访问控制：非回环 Host（防 DNS rebinding）/ 跨站写入 / 非 JSON
{
	// fetch 不让改 Host 头（改了也是 200，等于没测）：这条用原生 socket 发才真的带上伪造 Host。
	const rebindingStatus = await new Promise((resolve, reject) => {
		const socket = connect(port, '127.0.0.1', () => {
			socket.write(`GET ${STATE_ROUTE} HTTP/1.1\r\nHost: evil.example:51710\r\nConnection: close\r\n\r\n`);
		});
		let raw = '';
		socket.on('data', (chunk) => { raw += chunk.toString('utf8'); });
		socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(raw)?.[1] ?? 0)));
		socket.on('error', reject);
	});
	assert.equal(rebindingStatus, 403, '非回环 Host 名被拒（防 DNS rebinding）');

	const cross = await post(STATE_ROUTE, { 'content-type': 'application/json', origin: 'https://evil.example' });
	assert.equal(cross.status, 403, '跨站写入被拒');

	const crossSite = await post(STATE_ROUTE, { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' });
	assert.equal(crossSite.status, 403, 'Sec-Fetch-Site: cross-site 被拒');

	const notJson = await post(STATE_ROUTE, { 'content-type': 'text/plain' }, 'x');
	assert.equal(notJson.status, 415, 'POST 只收 JSON');
}

// fetch 的 keep-alive 连接会让 server.close() 一直等：先掐掉所有连接再关
server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
assert.equal(leaked, 0, '没有异常漏到宿主');
await rm(dir, { recursive: true, force: true });
console.log('panel.test.mjs ✅ 全部通过（6 组）');
