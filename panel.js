/**
 * dsh-az8 — 面板 API 与媒体路由（docs/design.md §4.2）。
 *
 * GET  /_dsh/dsh-az8/state    面板全量快照（settings + projects + runs + assets）
 * GET  /_dsh/dsh-az8/credits  活查余额（60s 缓存）
 * GET  /_dsh/dsh-az8/media?id=a9  产物媒体流（assetId 索引寻址，Range/206，视频可拖）
 * POST /_dsh/dsh-az8/state    { action: 'set-settings', patch }（校验走 store.settingsPatch）
 *
 * 访问控制沿用 dsh-myinfo 的面板语义：仅回环、Host 必须是 localhost 名（防 DNS
 * rebinding）、POST 必须 JSON 且 Origin/Sec-Fetch-Site 合法（防跨站写入）。
 * 对话内出图与面板共用 media 路由：markdown 相对 URL（同源，无 CORS）。
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import * as store from './store.js';

export const STATE_ROUTE = '/_dsh/dsh-az8/state';
export const CREDITS_ROUTE = '/_dsh/dsh-az8/credits';
export const MEDIA_ROUTE = '/_dsh/dsh-az8/media';
export const MEDIA_URL = (assetId) => `${MEDIA_ROUTE}?id=${encodeURIComponent(assetId)}`;

/** 工具结果里的可贴 markdown：图片内嵌、其余给链接（dsh-comfyui 验证过的展示模式）。 */
export function markdownForAsset(asset) {
	const url = MEDIA_URL(asset.id);
	if (asset.kind === 'image') return `![AZ8 ${asset.filename}](${url})`;
	return `[AZ8 ${asset.kind}: ${asset.filename}](${url})`;
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const MIME_TYPES = {
	'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
	'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/wav': '.wav',
};

function sendJson(response, status, value) {
	const payload = JSON.stringify(value);
	response.writeHead(status, {
		'content-type': 'application/json',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(payload),
	});
	response.end(payload);
}

function hostVerdict(host) {
	if (typeof host !== 'string' || host.trim() === '') return undefined;
	const text = host.trim().toLowerCase();
	const name = text.startsWith('[') ? text.slice(0, text.indexOf(']') + 1) : text.split(':')[0];
	return LOCAL_HOSTNAMES.has(name) ? undefined : `host "${host}" is not a localhost name`;
}

function loopVerdict(request) {
	const remote = String(request.socket?.remoteAddress ?? '');
	if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
		return 'az8 panel is localhost-only';
	}
	return hostVerdict(request.headers.host);
}

function postVerdict(headers) {
	if (!String(headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
		return { status: 415, message: 'application/json only' };
	}
	const origin = headers.origin;
	if (typeof origin === 'string' && origin.trim() !== '') {
		let url;
		try { url = new URL(origin); } catch { url = undefined; }
		if (url !== undefined && (url.protocol === 'http:' || url.protocol === 'https:')
			&& !LOCAL_HOSTNAMES.has(url.hostname.toLowerCase())) {
			return { status: 403, message: `origin "${origin}" is not allowed` };
		}
	}
	const site = headers['sec-fetch-site'];
	if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') {
		return { status: 403, message: `a ${site} request may not write az8 data` };
	}
	return undefined;
}

function readJsonBody(request) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		request.on('data', (chunk) => {
			size += chunk.length;
			if (size > 64 * 1024) { reject(new Error('body too large')); request.destroy(); return; }
			chunks.push(chunk);
		});
		request.on('end', () => {
			try { resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
			catch (error) { reject(new Error(`invalid JSON: ${String(error?.message ?? error).split('\n', 1)[0]}`)); }
		});
		request.on('error', reject);
	});
}

function panelSnapshot() {
	const state = store.loadState();
	return {
		ok: true,
		settings: state.settings,
		projects: state.projectsCache,
		runs: state.runs.slice(0, 60),
		assets: state.assets.map((a) => ({ ...a, url: MEDIA_URL(a.id) })),
		limits: { runs: store.RUN_LIMIT, assets: store.ASSET_LIMIT },
	};
}

/** 解析 Range 头；返回 {start,end} 或 undefined。 */
function parseRange(header, size) {
	const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
	if (match === null) return undefined;
	const start = match[1] === '' ? undefined : Number(match[1]);
	const end = match[2] === '' ? undefined : Number(match[2]);
	if (start === undefined && end === undefined) return undefined;
	let from = start ?? Math.max(0, size - (end ?? 0));
	let to = end === undefined ? size - 1 : Math.min(end, size - 1);
	if (start === undefined) { from = Math.max(0, size - (end ?? 0)); to = size - 1; }
	if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || from >= size) return null;
	return { start: from, end: to };
}

function serveMedia(request, response, query) {
	const id = query.get('id') ?? '';
	const state = store.loadState();
	const asset = store.getAsset(state, id);
	if (asset === undefined) { sendJson(response, 404, { ok: false, error: `unknown asset id "${id}"` }); return; }
	const file = join(store.getAssetsDir(), asset.filename);
	stat(file).then((info) => {
		const size = info.size;
		const mime = asset.mime !== '' && MIME_TYPES.hasOwnProperty(asset.mime) ? asset.mime : (asset.mime || 'application/octet-stream');
		const base = {
			'content-type': mime,
			'accept-ranges': 'bytes',
			'cache-control': 'private, max-age=86400',
		};
		if (request.method === 'HEAD') {
			response.writeHead(200, { ...base, 'content-length': size });
			response.end();
			return;
		}
		const range = parseRange(request.headers.range, size);
		if (range === null) {
			response.writeHead(416, { 'content-range': `bytes */${size}` });
			response.end();
			return;
		}
		if (range === undefined) {
			response.writeHead(200, { ...base, 'content-length': size });
			createReadStream(file).pipe(response);
			return;
		}
		response.writeHead(206, {
			...base,
			'content-length': range.end - range.start + 1,
			'content-range': `bytes ${range.start}-${range.end}/${size}`,
		});
		createReadStream(file, { start: range.start, end: range.end }).pipe(response);
	}).catch(() => {
		sendJson(response, 404, { ok: false, error: `asset file missing on disk: ${asset.filename}` });
	});
}

export function installPanelWeb(ctx, orch, creditsProvider) {
	ctx.inject(['webServer'], (webCtx) => {
		let creditsCache = { at: 0, value: null };
		webCtx.effect(() => webCtx.webServer.register({
			kind: 'exact',
			path: CREDITS_ROUTE,
			handler: async (request, response) => {
				const verdict = loopVerdict(request);
				if (verdict !== undefined) { sendJson(response, 403, { ok: false, error: verdict }); return; }
				if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return; }
				if (Date.now() - creditsCache.at > 60_000) {
					try {
						const status = await creditsProvider();
						creditsCache = { at: Date.now(), value: status };
					} catch (error) {
						if (creditsCache.value === null) {
							sendJson(response, 502, { ok: false, error: String(error?.message ?? error).split('\n', 1)[0] });
							return;
						}
					}
				}
				sendJson(response, 200, { ok: true, credits: creditsCache.value?.credits ?? [], whoami: creditsCache.value?.whoami ?? null });
			},
		}));

		webCtx.effect(() => webCtx.webServer.register({
			kind: 'exact',
			path: MEDIA_ROUTE,
			handler: async (request, response) => {
				const verdict = loopVerdict(request);
				if (verdict !== undefined) { sendJson(response, 403, { ok: false, error: verdict }); return; }
				if (request.method !== 'GET' && request.method !== 'HEAD') {
					response.writeHead(405, { allow: 'GET, HEAD' });
					response.end();
					return;
				}
				const url = new URL(request.url ?? '/', 'http://localhost');
				serveMedia(request, response, url.searchParams);
			},
		}));

		webCtx.effect(() => webCtx.webServer.register({
			kind: 'exact',
			path: STATE_ROUTE,
			handler: async (request, response) => {
				try {
					const verdict = loopVerdict(request);
					if (verdict !== undefined) { sendJson(response, 403, { ok: false, error: verdict }); return; }
					if (request.method === 'GET') {
						// GET 时若面板要求刷新项目缓存，带 ?refresh=projects 活查一次（走 orchestrator，失败静默用缓存）。
						const url = new URL(request.url ?? '/', 'http://localhost');
						if (url.searchParams.get('refresh') === 'projects') {
							try { await orch.status(); } catch { /* 保留缓存 */ }
						}
						sendJson(response, 200, panelSnapshot());
						return;
					}
					if (request.method !== 'POST') { response.writeHead(405, { allow: 'GET, POST' }); response.end(); return; }
					const post = postVerdict(request.headers);
					if (post !== undefined) { sendJson(response, post.status, { ok: false, error: post.message }); return; }
					const body = await readJsonBody(request);
					if (body?.action !== 'set-settings') {
						sendJson(response, 400, { ok: false, error: `unknown action "${String(body?.action ?? '')}"` });
						return;
					}
					const patch = store.settingsPatch(body.patch ?? {});
					await store.mutate((state) => { Object.assign(state.settings, patch); });
					sendJson(response, 200, { ok: true, value: patch });
				} catch (error) {
					sendJson(response, error?.name === 'StoreError' ? 400 : 500, { ok: false, error: String(error?.message ?? error).split('\n', 1)[0] });
				}
			},
		}));
	});
}
