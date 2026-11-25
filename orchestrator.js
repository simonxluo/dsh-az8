/**
 * dsh-az8 — 生成编排器（docs/design.md §5 状态机 / §4.1 主链路）。
 *
 * 严格遵守 az8 CLI 契约：一次一个写操作、每个写操作等终态 Receipt、写失败绝不自动重试、
 * watch 不套循环（等待统一走 waitWorkflowRun 单窗口）。操作输入经 capabilities.detail 的
 * JSON Schema 自适应映射（design §7），映射不了的留给服务端校验并透传可读错误。
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { run as defaultCliRun } from './cli.js';
import * as store from './store.js';
import { listSkills, mustReadGate } from './skills.js';

const CAPS_TTL_MS = 10 * 60_000;
const ID_SHAPE = /^[0-9a-f]{8,}$/i;
const TARGETS = ['image', 'video', 'audio', 'text'];

const SYNONYMS = {
	viewNodeId: ['viewNodeId', 'targetViewNodeId', 'target'],
	target: ['target', 'targetType', 'kind', 'mediaType'],
	prompt: ['prompt', 'text'],
	definitionId: ['definitionId', 'definition'],
	references: ['references'],
	detail: ['detail'],
	workflowRunId: ['workflowRunId', 'runId'],
	timeoutMs: ['timeoutMs', 'waitMs', 'timeout'],
};

function rid(runId, step) {
	return `az8-${runId}-${step}-${Math.random().toString(36).slice(2, 10)}`;
}

function firstLine(text, max = 300) {
	const line = String(text ?? '').split('\n', 1)[0].trim();
	return line.length > max ? line.slice(0, max) + '…' : line;
}

export function deepScan(value, pred, out = [], depth = 0) {
	if (depth > 12 || value === null || typeof value !== 'object') return out;
	if (Array.isArray(value)) {
		for (const item of value) deepScan(item, pred, out, depth + 1);
		return out;
	}
	if (pred(value)) out.push(value);
	for (const item of Object.values(value)) deepScan(item, pred, out, depth + 1);
	return out;
}

function pickString(obj, keys) {
	for (const key of keys) {
		const hits = deepScan(obj, (v) => typeof v[key] === 'string' && v[key] !== '');
		if (hits.length > 0) return hits[0][key];
	}
	return '';
}

function cliErr(result, what) {
	const jsonErr = result.json && typeof result.json === 'object' ? result.json.error : undefined;
	const error = new Error(`az8 ${what}: ${firstLine(jsonErr?.message ?? result.stderr ?? result.stdout ?? `exit ${result.exitCode}`)}`);
	error.classification = result.classification;
	error.retryable = jsonErr?.retryable === true;
	return error;
}

/**
 * 终态 Run 事实瘦身（design §2.1 facts / §4.3）：只留详情页要用的顶层键，
 * URL/凭证样键名不落盘，字符串里的链接抹成 [url]，超长串截断。
 */
const FACT_KEYS = ['id', 'status', 'createdAt', 'startedAt', 'endedAt', 'updatedAt', 'progress', 'definitionId', 'definitionVersion', 'outputs', 'usage', 'error', 'asyncTaskId'];
const FACT_SKIP_KEY = /url|token|secret|signature|credential|authorization|cookie/i;
export function scrubFacts(value, depth = 0) {
	if (value === null || typeof value !== 'object') {
		if (typeof value !== 'string') return value;
		const text = value.length > 400 ? value.slice(0, 400) + '…' : value;
		return /https?:\/\//i.test(text) ? text.replace(/https?:\/\/\S+/gi, '[url]') : text;
	}
	if (depth > 6) return undefined;
	if (Array.isArray(value)) {
		return value.slice(0, 24).map((item) => scrubFacts(item, depth + 1)).filter((item) => item !== undefined);
	}
	const out = {};
	for (const [key, item] of Object.entries(value)) {
		if (FACT_SKIP_KEY.test(key)) continue;
		if (depth === 0 && !FACT_KEYS.includes(key)) continue;
		const cleaned = scrubFacts(item, depth + 1);
		if (cleaned !== undefined) out[key] = cleaned;
	}
	return out;
}

/** Run 事实的终态判定：活查到的 facts 可能比 journal 新，以它为第二意见。 */
export function terminalStateOf(runJson) {
	const status = String(pickString(runJson, ['status']) ?? '').toLowerCase();
	if (['succeeded', 'success', 'completed', 'done'].includes(status)) return 'succeeded';
	if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) return 'failed';
	if (['pending', 'running', 'queued'].includes(status)) return 'running';
	return 'unknown';
}

const STEP_KEYS = ['target', 'plan', 'submit', 'run', 'assets'];
const JOURNAL_TERMINAL = new Set(['succeeded', 'failed', 'indeterminate']);
const ACTIVE_STEP = { resolving: 'target', planning: 'plan', starting: 'submit', running: 'run', downloading: 'assets' };

const toMs = (value) => {
	if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
	const ms = typeof value === 'string' ? Date.parse(value) : NaN;
	return Number.isFinite(ms) ? ms : 0;
};
const toIso = (value) => {
	const ms = toMs(value);
	return ms > 0 ? new Date(ms).toISOString() : '';
};

/**
 * 画布目标节点 history[] 里属于本次 run 的那一条：严格按 runtime.instanceIds 匹配，
 * 匹配不上返回 undefined——节点上可能有多代生成，按时间猜会张冠李戴。
 */
export function pickHistory(node, run) {
	const history = Array.isArray(node?.history) ? node.history : [];
	if (run.workflowRunId === '') return undefined;
	return history.find((entry) => Array.isArray(entry?.runtime?.instanceIds) && entry.runtime.instanceIds.includes(run.workflowRunId));
}

/**
 * 老 run（v0.2.2 之前生成，journal 里没有 detail/timeline）从画布 history 回填。
 * 只补缺失字段，不覆盖已有；返回可直接进 patchRun 的对象。
 */
export function backfillFromHistory(run, node, entry) {
	const patch = { timeline: { ...(run.timeline ?? {}) } };
	if ((run.timeline?.targetAt ?? '') === '' && toIso(node?.createdAt) !== '') patch.timeline.targetAt = toIso(node.createdAt);
	if (entry === undefined) return patch;
	const definitionId = String(entry.definitionId ?? run.definitionId ?? '');
	if (run.definitionId === '' && definitionId !== '') patch.definitionId = definitionId;
	if ((run.timeline?.plannedAt ?? '') === '') patch.timeline.plannedAt = toIso(entry.createdAt);
	if ((run.timeline?.submittedAt ?? '') === '') patch.timeline.submittedAt = toIso(entry.runtime?.submittedAt ?? entry.updatedAt);
	const slots = entry.inputs?.slots ?? {};
	const literal = (name) => (Array.isArray(slots[name]) ? slots[name] : []).find((x) => x?.kind === 'literal' && typeof x.content === 'string')?.content;
	if (Object.keys(run.detail?.config ?? {}).length === 0) {
		let config = {};
		try {
			const parsed = JSON.parse(literal('config') ?? '');
			if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
		} catch { /* config 字面量不是 JSON 对象就留空 */ }
		patch.detail = { ...(run.detail ?? {}), config, configFields: run.detail?.configFields ?? [] };
	}
	// 引用槽的真机形态还没校准（§13b-8）：只认非字面量且带 viewNodeId 类字段的条目，认不出就留空。
	if (!Array.isArray(run.references)) {
		const refs = [];
		for (const [slot, items] of Object.entries(slots)) {
			if (!Array.isArray(items)) continue;
			for (const item of items) {
				if (item?.kind === 'literal') continue;
				const viewNodeId = String(item?.viewNodeId ?? item?.referenceViewNodeId ?? '');
				if (viewNodeId === '' || refs.some((r) => r.viewNodeId === viewNodeId)) continue;
				refs.push({ viewNodeId, slotName: String(item?.slotName ?? slot) });
			}
		}
		patch.references = refs;
	}
	return patch;
}

/**
 * 运行详情组装（纯函数，单测直接覆盖）：journal run + 权威 facts + 全量 state（串血缘）
 * → 面板 JSON。不碰 CLI、不碰磁盘；预览 URL 由 orchestrator/panel 补。
 */
export function buildRunDetail(run, facts, state = { runs: [], assets: [] }) {
	const assets = (run.assets ?? []).map((id) => state.assets.find((a) => a.id === id)).filter(Boolean);
	const assetByCore = new Map(assets.map((a) => [a.coreNodeId, a]));
	const outputs = Array.isArray(facts?.outputs) ? facts.outputs : [];
	const seenCore = new Set();
	const outRows = [];
	const intermediates = [];
	for (const item of outputs) {
		const coreNodeId = String(item?.coreNodeId ?? '');
		if (coreNodeId === '' || seenCore.has(coreNodeId)) continue;
		seenCore.add(coreNodeId);
		const row = { coreNodeId, slotName: String(item?.slotName ?? ''), role: String(item?.role ?? '') };
		const asset = assetByCore.get(coreNodeId);
		if (asset !== undefined) outRows.push({ ...row, assetId: asset.id });
		else intermediates.push(row); // 中间产物 = 本次 outputs 里没入库的条目（§4.3：按血缘，不按画布邻近）
	}
	const definition = run.detail?.definition ?? {};
	const workflow = {
		definitionId: String(run.definitionId || definition.id || facts?.definitionId || ''),
		definitionName: String(run.definitionName ?? definition.name ?? ''),
		capability: String(definition.capability ?? ''),
		group: String(definition.group ?? ''),
		definitionVersion: facts?.definitionVersion ?? definition.version ?? null,
		note: '',
	};
	if (workflow.definitionId === '' && outputs.length === 0 && run.viewNodeId === '' && JOURNAL_TERMINAL.has(run.status)) workflow.note = 'not-planned';

	// 引用（血缘上游）：引用的 viewNode 若是更早一条 run 的生成目标，标出 upstreamRunId
	const runByTarget = new Map(state.runs.filter((r) => typeof r.viewNodeId === 'string' && r.viewNodeId !== '').map((r) => [r.viewNodeId, r]));
	const inputs = [];
	for (const ref of Array.isArray(run.references) ? run.references : []) {
		const viewNodeId = String(ref?.viewNodeId ?? '');
		if (viewNodeId === '' || inputs.some((x) => x.viewNodeId === viewNodeId)) continue;
		inputs.push({ viewNodeId, slotName: String(ref?.slotName ?? ''), upstreamRunId: runByTarget.get(viewNodeId)?.id ?? '', assetId: '' });
	}

	// 五个阶段（§4.3）：第一个没走到的步骤才是 failed/unknown/wait/active，其后一律 skipped
	const factsState = terminalStateOf(facts);
	const ok = {
		target: run.viewNodeId !== '',
		plan: run.creditsEstimated != null || run.confirm != null || run.workflowRunId !== '',
		submit: run.workflowRunId !== '',
		run: run.status === 'succeeded' || factsState === 'succeeded',
		assets: assets.length > 0,
	};
	const states = {};
	let stopped = false;
	for (const key of STEP_KEYS) {
		if (!stopped && ok[key]) { states[key] = 'done'; continue; }
		if (!stopped) {
			stopped = true;
			states[key] = run.status === 'failed' ? 'failed'
				: run.status === 'indeterminate' ? 'unknown'
				: run.status === 'awaiting_confirm' || run.status === 'needs-choice' ? 'wait'
				: JOURNAL_TERMINAL.has(run.status) ? 'skipped'
				: ACTIVE_STEP[run.status] === key ? 'active' : 'skipped';
		} else states[key] = 'skipped';
	}
	const tl = run.timeline ?? {};
	const durationMs = toMs(facts?.endedAt ?? facts?.updatedAt) - toMs(facts?.startedAt ?? facts?.createdAt);
	const bytes = assets.reduce((sum, a) => sum + (Number(a.bytes) || 0), 0);
	const lastDownload = assets.map((a) => a.downloadedAt).filter(Boolean).sort().at(-1);
	const withError = (step) => ((step.state === 'failed' || step.state === 'unknown') && run.error?.message
		? { ...step, error: firstLine(run.error.message, 160) } : step);
	const steps = STEP_KEYS.map((key) => withError({ key, state: states[key] }));
	Object.assign(steps[0], { at: toIso(tl.targetAt), id: run.viewNodeId });
	Object.assign(steps[1], { at: toIso(tl.plannedAt), estimate: run.creditsEstimated ?? null, actual: run.creditsActual ?? null });
	Object.assign(steps[2], { at: toIso(tl.submittedAt), id: run.workflowRunId });
	Object.assign(steps[3], { at: toIso(facts?.startedAt ?? facts?.createdAt), durationMs: durationMs > 0 ? durationMs : null, progress: typeof facts?.progress === 'number' ? facts.progress : null });
	Object.assign(steps[4], { at: lastDownload ? toIso(lastDownload) : '', count: assets.length, bytes });

	// notes 是给面板翻译的码，不在这里写死中文/英文
	const notes = [];
	if (run.status === 'succeeded' && assets.length === 0) notes.push('no-assets');
	if (run.status === 'succeeded' && intermediates.length === 0 && outRows.length > 0) notes.push('single-step');
	if (run.status === 'indeterminate') notes.push('indeterminate');
	if (run.status === 'awaiting_confirm') notes.push(run.confirm?.canAfford === false ? 'unaffordable' : 'awaiting-confirm');
	if (!JOURNAL_TERMINAL.has(run.status) && run.status !== 'awaiting_confirm' && run.status !== 'needs-choice' && factsState === 'succeeded') notes.push('unfinished');

	return {
		run: {
			id: run.id, status: run.status, target: run.target,
			projectId: run.projectId, projectName: run.projectName,
			viewNodeId: run.viewNodeId ?? '', workflowRunId: run.workflowRunId ?? '',
			startedAt: run.startedAt ?? '', endedAt: run.endedAt ?? '',
			prompt: run.prompt, error: run.error ?? null, confirm: run.confirm ?? null,
			creditsEstimated: run.creditsEstimated ?? null, creditsActual: run.creditsActual ?? null,
		},
		workflow,
		config: run.detail?.config ?? {},
		configFields: Array.isArray(run.detail?.configFields) ? run.detail.configFields : [],
		steps, inputs,
		outputs: outRows,
		intermediates,
		assets: assets.map((a) => ({ id: a.id, kind: a.kind, filename: a.filename, bytes: a.bytes, mime: a.mime, coreNodeId: a.coreNodeId, slotName: outRows.find((o) => o.coreNodeId === a.coreNodeId)?.slotName ?? '' })),
		notes,
	};
}

export function createOrchestrator({ cliBin = 'az8', logger, jobs, runner } = {}) {
	const log = (...a) => { try { logger?.info?.(...a); } catch { /* noop */ } };
	const cliRun = runner ?? defaultCliRun;

	let sessionRef = null;              // { projectId, openedAt }
	let capsCache = null;               // { at, names:Set, details:Map }
	const readSkills = new Set();       // 本会话已读技能包（必读闸门）
	let writeQueue = Promise.resolve(); // I1：同一时刻至多一个 in-flight 写
	const queued = (fn) => {
		const next = writeQueue.then(fn, fn);
		writeQueue = next.then(() => undefined, () => undefined);
		return next;
	};

	const call = (args, timeoutMs) => cliRun(args, { cliBin, timeoutMs });
	const callOk = async (args, what, timeoutMs) => {
		const result = await call(args, timeoutMs);
		if (result.exitCode !== 0 || result.json === undefined) throw cliErr(result, what);
		return result.json;
	};

	// --- 会话 ------------------------------------------------------------

	async function ensureSession(projectId) {
		if (sessionRef?.projectId === projectId) {
			const cur = await call(['session', 'current'], 15_000);
			if (cur.exitCode === 0) return sessionRef;
		}
		if (sessionRef !== null) {
			await call(['session', 'close'], 15_000); // best-effort
			sessionRef = null;
		}
		const opened = await callOk(['session', 'open', projectId], 'session open', 30_000);
		sessionRef = { projectId, openedAt: new Date().toISOString() };
		log(`session open ${projectId}`);
		return { sessionRef, opened };
	}

	async function closeSession() {
		await call(['session', 'close'], 15_000);
		sessionRef = null;
	}

	// --- capabilities ------------------------------------------------------

	async function caps(force = false) {
		if (!force && capsCache !== null && Date.now() - capsCache.at < CAPS_TTL_MS) return capsCache;
		const json = await callOk(['session', 'query', 'capabilities.summary'], 'capabilities.summary', 30_000);
		const names = new Set(deepScan(json, (v) => typeof v.name === 'string').map((v) => v.name));
		capsCache = { at: Date.now(), names, details: new Map() };
		return capsCache;
	}

	async function opDetail(name) {
		const cache = await caps();
		if (cache.details.has(name)) return cache.details.get(name);
		const json = await callOk(['session', 'query', 'capabilities.detail', '--operation-name', name], 'capabilities.detail', 30_000);
		const schemas = deepScan(json, (v) => v !== null && typeof v === 'object' && v.type === 'object' && v.properties !== undefined);
		const schema = schemas[0] ?? null;
		cache.details.set(name, schema);
		return schema;
	}

	function buildInput(schema, hints) {
		if (schema === null || schema?.properties === undefined) return { ...hints };
		const props = schema.properties;
		const out = {};
		const used = new Set();
		for (const [hintKey, value] of Object.entries(hints)) {
			if (value === undefined) continue;
			const names = [hintKey, ...(SYNONYMS[hintKey] ?? [])];
			let prop = names.find((n) => props[n] !== undefined);
			if (prop === undefined) {
				prop = Object.keys(props).find((p) => names.some((n) => p.toLowerCase() === n.toLowerCase()));
			}
			if (prop === undefined && hintKey === 'target') {
				prop = Object.keys(props).find((p) => {
					const en = Array.isArray(props[p]?.enum) ? props[p].enum : undefined;
					return en !== undefined && TARGETS.every((t) => en.includes(t));
				});
			}
			if (prop === undefined) continue;
			used.add(prop);
			const en = Array.isArray(props[prop]?.enum) ? props[prop].enum : undefined;
			out[prop] = en !== undefined && en.includes(value) ? value : value;
		}
		return out;
	}

	async function requireOp(name) {
		const cache = await caps();
		if (!cache.names.has(name)) {
			const near = [...cache.names].filter((n) => /generation|workflow|reference|target/i.test(n)).slice(0, 20);
			throw Object.assign(new Error(`当前 Canvas 能力里没有 "${name}"（相近: ${near.join(', ') || '无'}）`), { classification: 'definitive' });
		}
	}

	async function operation(name, input, requestId, timeoutMs) {
		const result = await call(['session', 'operation', name, '--request-id', requestId, '--input-json', JSON.stringify(input ?? {})], timeoutMs ?? 60_000);
		if (result.exitCode !== 0) throw cliErr(result, `operation ${name}`);
		const json = result.json ?? {};
		return (json.result !== undefined && json.result !== null && typeof json.result === 'object') ? { receipt: json, result: json.result } : { receipt: json, result: json };
	}

	// --- 状态快照 ----------------------------------------------------------

	function snapshot(runId) {
		const state = store.loadState();
		return store.getRun(state, runId);
	}

	function failRun(runId, error) {
		const classification = error?.classification === 'indeterminate' ? 'indeterminate' : 'failed';
		const guidance = classification === 'indeterminate'
			? '结果不确定：不要重试同一意图。检查 az8_runs / 画布事实后按 az8 指南 reconcile（reconcileGenerationStart）。'
			: '确定性失败：修正后用新的 resume/重新生成。';
		return store.mutate((state) => store.patchRun(state, runId, {
			status: classification,
			endedAt: new Date().toISOString(),
			error: { code: error?.name ?? 'error', message: firstLine(error?.message), classification },
			confirm: null,
		}));
	}

	// --- 目录 / 定义 -------------------------------------------------------

	async function definitions({ target, capability, search, pageSize = 20, projectId } = {}) {
		const state = store.loadState();
		// 没给项目且没默认项目时复用当前已开的会话（generate 里就是这么调的）；
		// 都没有才报错——绝不拿空字符串去 session open。
		const sessionProject = String(projectId ?? state.settings.defaultProjectId ?? '');
		if (sessionProject !== '') await ensureSession(sessionProject);
		else if (sessionRef === null) throw new store.StoreError('查工作流目录需要 projectId（或先在设置里填默认项目）');
		const args = ['session', 'query', 'workflowDefinitions.summary'];
		if (target !== undefined) args.push('--workflow-target', target);
		if (capability !== undefined && capability !== '') args.push('--workflow-capability', capability);
		if (search !== undefined && search !== '') args.push('--workflow-search', search);
		args.push('--page-size', String(pageSize));
		const collected = [];
		let cursor = null;
		for (let page = 0; page < 10; page++) {
			const pageArgs = cursor === null ? args : [...args, '--cursor', cursor];
			const json = await callOk(pageArgs, 'workflowDefinitions.summary', 30_000);
			const defs = deepScan(json, (v) => v !== null && typeof v === 'object'
				&& (typeof v.definitionId === 'string' || typeof v.id === 'string') && (v.name !== undefined || v.capability !== undefined));
			collected.push(...defs);
			cursor = json.pagination?.nextCursor ?? null;
			if (json.pagination?.hasMore !== true || cursor === null) break;
		}
		return { definitions: collected.slice(0, 60), hasMore: cursor !== null };
	}

	// --- 媒体上传 / 下载 ------------------------------------------------------

	async function uploadMedia({ path, projectId, name, position }) {
		const bytes = await readFile(path);
		const key = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
		const args = ['canvas', 'upload', projectId, '--file', path, '--idempotency-key', `dsh-az8-${key}`];
		if (name !== undefined && name !== '') args.push('--name', name);
		if (position !== undefined) {
			args.push('--position-x', String(position.x ?? 640), '--position-y', String(position.y ?? 160));
		}
		const result = await call(args, 600_000);
		if (result.exitCode !== 0) throw cliErr(result, 'canvas upload');
		const viewNodeId = pickString(result.json, ['viewNodeId']) || '';
		return { viewNodeId, idempotencyKey: `dsh-az8-${key}`, receipt: result.json };
	}

	async function downloadOne(projectId, ref, runId, kindHint) {
		const state = store.loadState();
		const assetId = store.nextAssetId(state);
		const dir = store.getAssetsDir();
		await mkdir(dir, { recursive: true });
		const tmp = join(dir, `.tmp-${assetId}-${Date.now()}`);
		const args = ['canvas', 'download', projectId];
		if (ref.viewNodeId !== undefined) args.push('--view-node-id', ref.viewNodeId);
		else if (ref.coreNodeId !== undefined) args.push('--core-node-id', ref.coreNodeId);
		else throw Object.assign(new Error('download 需要 viewNodeId 或 coreNodeId'), { classification: 'definitive' });
		args.push('--output', tmp);
		const result = await call(args, 600_000);
		if (result.exitCode !== 0) throw cliErr(result, 'canvas download');
		const info = result.json ?? {};
		// 真机 Receipt（az8.canvas.media-download.v1）：{ file: { bytes, contentType, detectedExtension, path, checksum }, … }
		const file = info.file ?? {};
		const mime = String(file.contentType ?? file.detectedMediaType ?? info.mime ?? '');
		const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : (String(info.media?.mediaType ?? '').includes('image') ? 'image' : (kindHint ?? 'other'));
		const detected = String(file.detectedExtension ?? '').replace(/^\./, '');
		const ext = detected !== '' ? `.${detected}` : extname(String(file.path ?? tmp)) || (mime.split('/')[1] ? `.${mime.split('/')[1].split(';')[0]}` : '.bin');
		const filename = `${runId}-${assetId}${ext}`;
		const finalPath = join(dir, filename);
		await rename(tmp, finalPath);
		const asset = {
			id: assetId, runId, projectId,
			slotName: String(ref.slotName ?? ''), role: String(ref.role ?? ''),
			kind, filename, mime, bytes: Number(file.bytes ?? info.bytes ?? 0), sha256: String(file.checksum?.hex ?? info.sha256 ?? ''),
			viewNodeId: String(ref.viewNodeId ?? ''), coreNodeId: String(ref.coreNodeId ?? info.media?.coreNodeId ?? ''),
			downloadedAt: new Date().toISOString(),
		};
		await store.mutate((s) => { store.appendAsset(s, asset); });
		return asset;
	}

	/** 终态后的权威 Run 事实（getWorkflowRun 是读操作，经 operation 形态调用）。 */
	async function getRunFacts(workflowRunId) {
		const cache = await caps();
		if (cache.names.has('getWorkflowRun')) {
			const schema = await opDetail('getWorkflowRun');
			const input = buildInput(schema, { workflowRunId });
			const { result } = await operation('getWorkflowRun', input, rid('facts', Date.now().toString(36)), 60_000);
			return result.workflowRun ?? result;
		}
		return {};
	}

	/**
	 * 画布中间产物预览：按 viewNodeId 下载到 cache 目录并返回相对 URL。
	 * 供面板「工作流详情」展示非最终产物节点；失败返回 null（预览尽力而为）。
	 */
	/**
	 * 画布节点预览缓存：按 viewNodeId 或 coreNodeId 下载到 cache 目录，返回 { url, kind }。
	 * 只给详情页的「中间产物 / 引用」用（最终产物走 assets 索引，不进这里）。
	 * 磁盘已有同名缓存就复用（跨进程重启不重复下载）；失败返回 null，预览尽力而为。
	 */
	const PREVIEW_KIND = { png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', mp4: 'video', webm: 'video', mp3: 'audio', wav: 'audio', m4a: 'audio' };
	const previewCache = new Map(); // cacheKey -> { url, kind, at }
	async function previewCanvasNode(projectId, ref, { maxSize = 12 * 1024 * 1024, ttlMs = 10 * 60_000 } = {}) {
		const viewNodeId = typeof ref?.viewNodeId === 'string' ? ref.viewNodeId : '';
		const coreNodeId = typeof ref?.coreNodeId === 'string' ? ref.coreNodeId : '';
		const key = viewNodeId !== '' ? `v_${viewNodeId}` : coreNodeId !== '' ? `c_${coreNodeId}` : '';
		if (key === '') return null;
		const cached = previewCache.get(key);
		if (cached !== undefined && Date.now() - cached.at < ttlMs) return cached;
		try {
			const dir = store.getCacheDir();
			await mkdir(dir, { recursive: true });
			const existing = (await readdir(dir)).find((name) => name.startsWith(`${key}.`));
			let ext = '';
			let kind = '';
			if (existing !== undefined) {
				ext = extname(existing).slice(1);
				kind = PREVIEW_KIND[ext] ?? '';
			} else {
				const tmp = join(dir, `.tmp-${key}-${Date.now()}`);
				const selector = viewNodeId !== '' ? ['--view-node-id', viewNodeId] : ['--core-node-id', coreNodeId];
				const result = await call(['canvas', 'download', projectId, ...selector, '--output', tmp], 120_000);
				if (result.exitCode !== 0) { await rm(tmp, { force: true }); return null; }
				const info = result.json?.file ?? {};
				if (Number(info.bytes ?? 0) > maxSize) { await rm(tmp, { force: true }); return null; }
				const mime = String(info.contentType ?? '');
				ext = String(info.detectedExtension ?? '').replace(/^\./, '') || (mime.split('/')[1] ?? 'bin').split(';')[0];
				kind = mime.split('/')[0];
				await rename(tmp, join(dir, `${key}.${ext}`));
			}
			const entry = { url: `/_dsh/dsh-az8/cache?node=${encodeURIComponent(key)}&ext=${encodeURIComponent(ext)}`, kind, at: Date.now() };
			previewCache.set(key, entry);
			return entry;
		} catch (error) {
			log(`previewCanvasNode ${key} failed: ${firstLine(error?.message)}`);
			return null;
		}
	}

	function extractUsageCredits(runJson) {
		for (const hit of deepScan(runJson, (v) => v?.usage?.credits !== undefined)) {
			const credits = hit.usage.credits;
			if (typeof credits.actual === 'number') return credits.actual;
			if (typeof credits === 'number') return credits;
		}
		return undefined;
	}

	// --- 生成主链路 ----------------------------------------------------------

	async function resolveReferences(runId, projectId, references) {
		const refs = [];
		for (const ref of references ?? []) {
			if (typeof ref.viewNodeId === 'string' && ref.viewNodeId !== '') {
				refs.push({ viewNodeId: ref.viewNodeId, ...(ref.slotName ? { slotName: ref.slotName } : {}) });
				continue;
			}
			if (typeof ref.assetId === 'string' && ref.assetId !== '') {
				const asset = store.getAsset(store.loadState(), ref.assetId);
				if (asset === undefined || asset.viewNodeId === '') throw Object.assign(new Error(`资产 ${ref.assetId} 没有可用的 viewNodeId`), { classification: 'definitive' });
				refs.push({ viewNodeId: asset.viewNodeId, ...(ref.slotName ? { slotName: ref.slotName } : {}) });
				continue;
			}
			if (typeof ref.path === 'string' && ref.path !== '') {
				if (!existsSync(ref.path)) throw Object.assign(new Error(`引用文件不存在: ${ref.path}`), { classification: 'definitive' });
				const up = await uploadMedia({ path: ref.path, projectId, name: `ref-${runId}` });
				if (up.viewNodeId === '') throw Object.assign(new Error('上传成功但没解析出 viewNodeId（ Receipt: ' + firstLine(JSON.stringify(up.receipt), 200) + ' ）'), { classification: 'indeterminate' });
				refs.push({ viewNodeId: up.viewNodeId, ...(ref.slotName ? { slotName: ref.slotName } : {}) });
				continue;
			}
			throw Object.assign(new Error('reference 需要 viewNodeId / assetId / path 之一'), { classification: 'definitive' });
		}
		return refs;
	}

	async function executePlanOps(runId, planOps) {
		let workflowRunId = '';
		let lastResult = null;
		for (let i = 0; i < planOps.length; i++) {
			const step = planOps[i];
			const name = String(step.name ?? step.operation ?? step.op ?? '');
			if (name === '') throw Object.assign(new Error(`plan.operations[${i}] 缺少操作名`), { classification: 'definitive' });
			const input = step.input ?? step.inputs ?? step;
			const { result } = await operation(name, input, rid(runId, `op${i + 1}`));
			lastResult = result;
			if (/start/i.test(name)) {
				workflowRunId = pickString(result, ['workflowRunId', 'runId']) || '';
			}
		}
		return { workflowRunId, lastResult };
	}

	async function waitWindow(workflowRunId, waitMs) {
		const cache = await caps();
		if (cache.names.has('waitWorkflowRun')) {
			const schema = await opDetail('waitWorkflowRun');
			const input = buildInput(schema, { workflowRunId, timeoutMs: waitMs });
			const { result } = await operation('waitWorkflowRun', input, rid('wait', Date.now().toString(36)), waitMs + 60_000);
			return { run: result.workflowRun ?? result, via: 'waitWorkflowRun' };
		}
		const facts = await getRunFacts(workflowRunId);
		return { run: facts, via: 'getWorkflowRun' };
	}

	function runTerminalState(runJson) {
		return terminalStateOf(runJson);
	}

	async function resolveOutputs(runId, projectId, runJson, viewNodeId) {
		const refs = [];
		const push = (ref) => {
			if (ref !== undefined && !refs.some((x) => JSON.stringify(x) === JSON.stringify(ref))) refs.push(ref);
		};
		// 真机形态：workflowRun.outputs = [{ coreNodeId, role, slotName }] —— 按 core node 下载。
		for (const hit of deepScan(runJson, (v) => Array.isArray(v.outputs))) {
			for (const item of hit.outputs) {
				if (item !== null && typeof item === 'object') {
					const slot = { slotName: String(item.slotName ?? ''), role: String(item.role ?? '') };
					if (typeof item.coreNodeId === 'string' && item.coreNodeId !== '') push({ coreNodeId: item.coreNodeId, ...slot });
					else if (typeof item.viewNodeId === 'string' && item.viewNodeId !== '') push({ viewNodeId: item.viewNodeId, ...slot });
				} else if (typeof item === 'string' && ID_SHAPE.test(item)) push({ coreNodeId: item });
			}
		}
		if (refs.length === 0 && viewNodeId !== '') push({ viewNodeId });
		const assets = [];
		for (const ref of refs.slice(0, 4)) {
			try {
				assets.push(await downloadOne(projectId, ref, runId));
			} catch (error) {
				log(`download candidate ${JSON.stringify(ref)} failed: ${firstLine(error?.message)}`);
			}
		}
		return assets;
	}

	async function finishRun(runId, { projectId, workflowRunId, viewNodeId, waitMs, mode }) {
		if (mode === 'async' && jobs !== undefined) {
			const label = `AZ8 ${runId} (${workflowRunId})`;
			const jobId = jobs.start({
				kind: 'az8',
				label,
				run: () => ({
					cancel: () => { /* waitWorkflowRun 单窗口自然到期，不强制取消 */ },
					done: (async () => {
						try {
							const { run: runJson } = await waitWindow(workflowRunId, waitMs);
							const terminal = runTerminalState(runJson);
							if (terminal === 'succeeded') {
								const facts = await getRunFacts(workflowRunId);
								const assets = await resolveOutputs(runId, projectId, facts, viewNodeId);
								const usageCredits = extractUsageCredits(facts) ?? extractUsageCredits(runJson);
								await store.mutate((s) => store.patchRun(s, runId, {
									status: 'succeeded', endedAt: new Date().toISOString(),
									creditsActual: usageCredits,
									assets: assets.map((a) => a.id),
									facts: scrubFacts(facts),
								}));
								return { status: 'completed', result: `AZ8 ${runId} 生成完成，产物 ${assets.length} 个（面板「资产」页可看）` };
							}
							if (terminal === 'failed') {
								await store.mutate((s) => store.patchRun(s, runId, {
									status: 'failed', endedAt: new Date().toISOString(),
									error: { code: 'run-failed', message: firstLine(JSON.stringify(runJson), 300) },
									facts: scrubFacts(runJson),
								}));
								return { status: 'failed', detail: `AZ8 ${runId} 生成失败` };
							}
							return { status: 'completed', result: `AZ8 ${runId} 仍在运行（观察窗口结束），稍后用 az8_runs 查询` };
						} catch (error) {
							await store.mutate((s) => store.patchRun(s, runId, { status: 'indeterminate', endedAt: new Date().toISOString(), error: { code: 'wait-error', message: firstLine(error?.message) } }));
							return { status: 'failed', detail: `AZ8 ${runId} 等待出错: ${firstLine(error?.message)}` };
						}
					})(),
				}),
			});
			await store.mutate((s) => store.patchRun(s, runId, { jobId }));
			return { ...snapshot(runId), background: { kind: 'background', jobId, label } };
		}

		const { run: runJson, via } = await waitWindow(workflowRunId, waitMs);
		const terminal = runTerminalState(runJson);
		if (terminal === 'succeeded') {
			const facts = await getRunFacts(workflowRunId);
			const assets = await resolveOutputs(runId, projectId, facts, viewNodeId);
			const usageCredits = extractUsageCredits(facts) ?? extractUsageCredits(runJson);
			await store.mutate((s) => store.patchRun(s, runId, {
				status: 'succeeded', endedAt: new Date().toISOString(),
				creditsActual: usageCredits,
				assets: assets.map((a) => a.id),
				facts: scrubFacts(facts),
			}));
			return { ...snapshot(runId), assets, via, note: assets.length === 0 ? 'Run 成功但没解析到可下载产物：用 az8_media 手动下载（先 az8_runs get 看 run 事实）' : '' };
		}
		if (terminal === 'failed') {
			await store.mutate((s) => store.patchRun(s, runId, {
				status: 'failed', endedAt: new Date().toISOString(),
				error: { code: 'run-failed', message: firstLine(JSON.stringify(runJson), 300) },
				facts: scrubFacts(runJson),
			}));
			return { ...snapshot(runId), via };
		}
		return { ...snapshot(runId), stillRunning: true, via, note: '观察窗口结束仍在运行：稍后用 az8_runs（action: wait）再等一个窗口。' };
	}

	async function generate(args) {
		return queued(async () => {
			const settings = store.loadState().settings;
			const waitMs = Math.min(Math.max(Number(args.waitMs ?? settings.waitTimeoutMs), 5_000), 900_000);
			const mode = args.mode === 'async' && jobs !== undefined ? 'async' : 'sync';

			if (args.resumeRunId !== undefined) {
				const existing = snapshot(args.resumeRunId);
				if (existing === undefined) throw new store.StoreError(`run ${args.resumeRunId} 不存在`);
				if (existing.status !== 'awaiting_confirm') throw new store.StoreError(`run ${args.resumeRunId} 状态是 ${existing.status}，只有 awaiting_confirm 可 resume`);
				if (args.confirmed !== true) throw new store.StoreError('resume 需要 confirmed: true（用户已同意报价）');
				await ensureSession(existing.projectId);
				const planOps = existing.confirm?.planOps ?? [];
				const { workflowRunId } = await executePlanOps(existing.id, planOps);
				if (workflowRunId === '') throw Object.assign(new Error('plan.operations 执行完但没拿到 workflowRunId'), { classification: 'indeterminate' });
				await store.mutate((s) => store.patchRun(s, existing.id, { status: 'running', workflowRunId, confirm: null, timeline: { ...(snapshot(existing.id).timeline ?? {}), submittedAt: new Date().toISOString() } }));
				return finishRun(existing.id, { projectId: existing.projectId, workflowRunId, viewNodeId: existing.viewNodeId, waitMs, mode });
			}

			const runId = await store.mutate((state) => {
				const run = {
					id: store.nextRunId(state),
					projectId: '', projectName: '',
					target: String(args.target ?? 'image'),
					prompt: String(args.prompt ?? '').slice(0, 500),
					definitionId: String(args.definitionId ?? ''), definitionName: '',
					status: 'resolving',
					viewNodeId: '', workflowRunId: '',
					creditsEstimated: undefined, creditsActual: undefined,
					assets: [], startedAt: new Date().toISOString(), endedAt: '',
					error: null, confirm: null,
					timeline: {}, references: [], detail: null, facts: null, enriched: false,
				};
				store.appendRun(state, run);
				return run.id;
			});

			try {
				const projectId = String(args.projectId ?? '') || settings.defaultProjectId;
				if (projectId === '') {
					await store.mutate((s) => store.patchRun(s, runId, { status: 'failed', endedAt: new Date().toISOString(), error: { code: 'no-project', message: '未指定 projectId 且设置里没有默认项目。先 az8_status 看 projects，然后带 projectId 重试或设置 defaultProjectId。' } }));
					return snapshot(runId);
				}
				if (args.skill !== undefined) mustReadGate(await listSkills(), String(args.skill), readSkills);

				await ensureSession(projectId);
				const projects = store.loadState().projectsCache;
				const projectName = projects.find((p) => p.id === projectId)?.name ?? projectId;
				await store.mutate((s) => store.patchRun(s, runId, { projectId, projectName }));

				let definitionId = args.definitionId !== undefined ? String(args.definitionId) : '';
				if (definitionId === '' && args.definition !== undefined && args.definition !== '') {
					const { definitions: matches } = await definitions({ search: String(args.definition), target: args.target });
					const needle = String(args.definition).toLowerCase();
					const exact = matches.filter((d) => (d.definitionId ?? d.id ?? '').toLowerCase() === needle || (d.name ?? '').toLowerCase() === needle);
					const chosen = exact.length === 1 ? exact : matches.filter((d) => ((d.name ?? '') + (d.definitionId ?? d.id ?? '')).toLowerCase().includes(needle));
					if (chosen.length !== 1) {
						await store.mutate((s) => store.patchRun(s, runId, { status: 'needs-choice', error: { code: 'definition-choice', message: `模型/工作流 "${args.definition}" 命中 ${chosen.length} 个，把 definitionId 带上重试` }, }));
						return { ...snapshot(runId), candidates: chosen.slice(0, 10).map((d) => ({ definitionId: d.definitionId ?? d.id, name: d.name, capability: d.capability ?? '' })) };
					}
					definitionId = String(chosen[0].definitionId ?? chosen[0].id ?? '');
					await store.mutate((s) => store.patchRun(s, runId, { definitionId, definitionName: String(chosen[0].name ?? '') }));
				}

				await requireOp('createGenerationTarget');
				const targetSchema = await opDetail('createGenerationTarget');
				const { result: targetRes } = await operation('createGenerationTarget', buildInput(targetSchema, { target: args.target }), rid(runId, 'target'));
				const viewNodeId = pickString(targetRes, ['viewNodeId', 'targetViewNodeId']);
				if (viewNodeId === '') throw Object.assign(new Error('createGenerationTarget 成功但没解析出 viewNodeId: ' + firstLine(JSON.stringify(targetRes), 200)), { classification: 'indeterminate' });
				await store.mutate((s) => store.patchRun(s, runId, { viewNodeId, status: 'planning', timeline: { targetAt: new Date().toISOString() } }));

				const refs = await resolveReferences(runId, projectId, args.references);
				if (refs.length > 0) await store.mutate((s) => store.patchRun(s, runId, { references: refs.map((r) => ({ viewNodeId: r.viewNodeId, slotName: r.slotName ?? '' })) }));

				await requireOp('planGeneration');
				const planSchema = await opDetail('planGeneration');
				const planHints = {
					viewNodeId, prompt: String(args.prompt ?? ''),
					...(definitionId !== '' ? { definitionId } : {}),
					...(refs.length > 0 ? { references: refs } : {}),
					...(args.config !== undefined && args.config !== null ? { config: args.config } : {}),
					detail: 'detail',
				};
				let { result: planReceipt } = await operation('planGeneration', buildInput(planSchema, planHints), rid(runId, 'plan'));
				let inner = planReceipt.plan ?? planReceipt;

				// 真机形态：默认 Draft 可能带定义不认的 config 字段（config-field-unknown，ready:false）。
				// planGeneration 是 bounded-read，允许用 configFields 重建干净 config 重 plan 一次。
				const blockingOf = (p) => (p.issues ?? []).filter((i) => (i.severity ?? 'error') === 'error');
				if ((inner.ready !== true || blockingOf(inner).length > 0)
					&& blockingOf(inner).every((i) => i.code === 'config-field-unknown')
					&& Array.isArray(inner.configFields) && inner.configFields.length > 0
					&& planHints.config === undefined) {
					const cleanConfig = {};
					for (const field of inner.configFields) {
						if (typeof field.name !== 'string' || field.name === '') continue;
						const value = field.value ?? (Array.isArray(field.options) ? field.options[0] : undefined);
						if (value !== undefined) cleanConfig[field.name] = value;
					}
					log(`plan ready:false（脏 config），用 configFields 重建后重 plan 一次`);
					const retry = await operation('planGeneration', buildInput(planSchema, { ...planHints, config: cleanConfig }), rid(runId, 'plan2'));
					planReceipt = retry.result;
					inner = planReceipt.plan ?? planReceipt;
				}

				const blocking = blockingOf(inner);
				if (inner.ready !== true || blocking.length > 0) {
					await store.mutate((s) => store.patchRun(s, runId, { status: 'failed', endedAt: new Date().toISOString(), error: { code: 'plan-blocking', message: firstLine(JSON.stringify(blocking.length > 0 ? blocking : inner), 400) } }));
					return { ...snapshot(runId), plan: inner };
				}
				const estimate = Number(inner.estimate?.credits?.total ?? NaN);
				const affordable = inner.estimate?.credits?.canAfford ?? true;
				// 工作流详情 + 报价 + 时间线一次落盘（design §2.1 / §4.3）：面板详情零 CLI 的数据源。
				// 模型名缺失（显式传 definitionId 时 plan 可能不带 name）→ 目录反查一次，不命中不阻塞生成。
				const plannedDefinitionId = String(definitionId || inner.definition?.id || inner.definition?.definitionId || '');
				let plannedDefinition = inner.definition ?? null;
				if (plannedDefinitionId !== '' && String(plannedDefinition?.name ?? '') === '') {
					try {
						const meta = await definitionMetaOf(plannedDefinitionId, projectId);
						if (meta !== null) plannedDefinition = { ...(plannedDefinition ?? {}), ...meta };
					} catch (error) { log(`definitionMeta ${plannedDefinitionId} failed: ${firstLine(error?.message)}`); }
				}
				const detailMeta = {
					definition: plannedDefinition,
					config: (Array.isArray(inner.configFields)
						? inner.configFields.filter((f) => typeof f?.name === 'string' && f.value !== undefined).reduce((acc, f) => { acc[f.name] = f.value; return acc; }, {})
						: {}),
					configFields: Array.isArray(inner.configFields)
						? inner.configFields.map((f) => ({ name: f.name, value: f.value, options: f.options ?? null, required: f.required === true }))
						: [],
				};
				await store.mutate((s) => store.patchRun(s, runId, {
					...(definitionId === '' && plannedDefinitionId !== '' ? { definitionId: plannedDefinitionId } : {}),
					creditsEstimated: Number.isFinite(estimate) ? estimate : undefined,
					definitionName: String(plannedDefinition?.name ?? '') || undefined,
					detail: detailMeta,
					timeline: { ...(snapshot(runId).timeline ?? {}), plannedAt: new Date().toISOString() },
				}));
				const planOps = Array.isArray(inner.operations) ? inner.operations : [];
				if (planOps.length === 0) {
					// 真机形态：默认 Draft 不可用时 plan 返回 alternatives（候选定义）而不是 operations。
					const alternatives = Array.isArray(planReceipt.alternatives) ? planReceipt.alternatives : [];
					if (alternatives.length > 0) {
						await store.mutate((s) => store.patchRun(s, runId, { status: 'needs-choice', error: { code: 'definition-choice', message: `plan 要求先选工作流（返回 ${alternatives.length} 个候选）` } }));
						return {
							...snapshot(runId),
							candidates: alternatives.slice(0, 10).map((d) => ({ definitionId: d.id ?? d.definitionId, name: d.name, capability: d.capability ?? '' })),
						};
					}
					await store.mutate((s) => store.patchRun(s, runId, { status: 'failed', endedAt: new Date().toISOString(), error: { code: 'plan-empty', message: 'plan 没返回 operations: ' + firstLine(JSON.stringify(inner), 300) } }));
					return { ...snapshot(runId), plan: inner };
				}

				const maxCredits = args.maxCredits !== undefined ? Number(args.maxCredits) : settings.maxAutoCredits;
				if (args.confirmed !== true && (!Number.isFinite(estimate) || !affordable || estimate > maxCredits)) {
					await store.mutate((s) => store.patchRun(s, runId, {
						status: 'awaiting_confirm',
						confirm: { estimate: Number.isFinite(estimate) ? estimate : null, canAfford: affordable === true, maxCredits, planOps },
					}));
					return {
						...snapshot(runId),
						needsConfirmation: true,
						hint: affordable === false
						? `报价 ${Number.isFinite(estimate) ? estimate : '未知'} credits，但账号余额不足（canAfford=false）：用户确认也跑不了，先充值或换更便宜的模型。`
						: `报价 ${Number.isFinite(estimate) ? estimate : '未知'} credits（闸门 ${maxCredits}）。用户同意后用 az8_generate { resumeRunId: "${runId}", confirmed: true } 继续。`,
					};
				}

				const { workflowRunId } = await executePlanOps(runId, planOps);
				if (workflowRunId === '') throw Object.assign(new Error('plan.operations 执行完但没拿到 workflowRunId（最后一步: ' + firstLine(JSON.stringify(planOps.at(-1)?.name ?? ''), 120) + '）'), { classification: 'indeterminate' });
				await store.mutate((s) => store.patchRun(s, runId, { status: 'running', workflowRunId, confirm: null, timeline: { ...(snapshot(runId).timeline ?? {}), submittedAt: new Date().toISOString() } }));
				return finishRun(runId, { projectId, workflowRunId, viewNodeId, waitMs, mode });
			} catch (error) {
				await failRun(runId, error);
				return { ...snapshot(runId), guidance: error?.classification === 'indeterminate' ? '结果不确定，勿重试同意图；按 az8 指南 reconcile。' : '' };
			}
		});
	}

	async function waitRun(runId, timeoutMs) {
		return queued(async () => {
			const run = snapshot(runId);
			if (run === undefined) throw new store.StoreError(`run ${runId} 不存在`);
			if (run.workflowRunId === '') throw new store.StoreError(`run ${runId} 还没有 workflowRunId`);
			await ensureSession(run.projectId);
			return finishRun(runId, { projectId: run.projectId, workflowRunId: run.workflowRunId, viewNodeId: run.viewNodeId, waitMs: Math.min(Math.max(timeoutMs ?? 180_000, 5_000), 900_000), mode: 'sync' });
		});
	}

	// whoami 结果进程内缓存 10 分钟：面板 credits 轮询不该反复 spawn CLI
	//（并发/高频 az8 进程会触发 refresh token 重用检测，2026-11 三次吊销的教训）。
	let whoamiCache = { at: 0, value: null };
	async function whoamiCached() {
		if (whoamiCache.value !== null && Date.now() - whoamiCache.at < 10 * 60_000) return whoamiCache.value;
		const whoami = await callOk(['whoami'], 'whoami', 30_000);
		whoamiCache = { at: Date.now(), value: whoami };
		return whoami;
	}

	async function status() {
		// 串行（不是 Promise.all）：多个 az8 进程并发刷新 token 会被服务端判重用吊销。
		const whoami = await whoamiCached();
		const credits = await callOk(['credits'], 'credits', 30_000);
		const projectsJson = await call(['projects', 'list', '--scope', 'owned'], 30_000);
		const projects = projectsJson.exitCode === 0 && Array.isArray(projectsJson.json?.projects) ? projectsJson.json.projects : [];
		await store.mutate((s) => {
			store.setProjectsCache(s, projects);
			// 老 run 的 projectName 可能存成了项目 id（当时缓存是空的）：拿到真名就治愈
			for (const run of s.runs) {
				if (run.projectId !== '' && (run.projectName === run.projectId || run.projectName === '')) {
					const name = projects.find((p) => p.id === run.projectId)?.name ?? '';
					if (name !== '') run.projectName = name;
				}
			}
		});
		const current = await call(['session', 'current'], 15_000);
		return {
			whoami: whoami.account ?? whoami,
			credits: credits.balances ?? [],
			projects: store.loadState().projectsCache,
			session: current.exitCode === 0 ? current.json ?? { active: true } : { active: false },
			settings: store.loadState().settings,
		};
	}

	/**
	 * 单个 run 的完整详情（面板「运行详情」数据源）：
	 * journal 快照 + 权威 workflowRun 事实 + 输入/输出节点 + 中间产物预览 URL。
	 * workflowRunId 缺失（未开始/未到 start）时返回 journal 侧已知部分。
	 */
	// --- 运行详情（design §4.3）----------------------------------------------
	// journal 优先：新 run 的 detail/timeline/references/facts 在生成时已落盘，详情零 CLI。
	// 老 run（v0.2.2 之前）：活查一次并回填（enriched 标记），之后同样零 CLI。
	// 非终态 run 不落 facts，每次活查——indeterminate 的活查结果就是 reconcile 证据。

	// 定义元数据进程内缓存（definitionId → { name, capability, … }），只缓存命中，失败下次再查
	const defMetaCache = new Map();
	async function definitionMetaOf(definitionId, projectId) {
		if (definitionId === '') return null;
		if (defMetaCache.has(definitionId)) return defMetaCache.get(definitionId);
		const { definitions: matches } = await definitions({ search: definitionId, pageSize: 5, projectId });
		const exact = matches.find((d) => String(d.definitionId ?? d.id ?? '') === definitionId);
		if (exact === undefined) return null;
		const meta = {
			id: definitionId,
			name: String(exact.name ?? ''),
			capability: String(exact.capability ?? ''),
			target: String(exact.target ?? ''),
			group: String(exact.group ?? ''),
			version: typeof exact.version === 'number' ? exact.version : null,
		};
		defMetaCache.set(definitionId, meta);
		return meta;
	}

	/** 模型名缺失才查目录；命中后回填 definitionName + detail.definition（一次）。 */
	async function ensureDefinitionMeta(run, needSession) {
		const definitionId = String(run.definitionId || run.detail?.definition?.id || '');
		if (definitionId === '' || String(run.definitionName ?? '') !== '' || run.projectId === '') return run;
		let meta = null;
		try {
			await needSession();
			meta = await definitionMetaOf(definitionId, run.projectId);
		} catch (error) { log(`definitionMeta ${definitionId} failed: ${firstLine(error?.message)}`); }
		if (meta === null || meta.name === '') return run;
		const patch = { definitionName: meta.name };
		if (String(run.detail?.definition?.capability ?? '') === '') {
			patch.detail = { ...(run.detail ?? {}), definition: { ...(run.detail?.definition ?? {}), ...meta } };
		}
		await store.mutate((s) => store.patchRun(s, run.id, patch));
		return snapshot(run.id);
	}

	async function runDetail(runId) {
		return queued(async () => {
			let run = snapshot(runId);
			if (run === undefined) throw new store.StoreError(`run ${runId} 不存在`);
			// 会话按需开：journal 里什么都有的时候，一次 az8 都不调
			let sessionReady = false;
			let sessionError = '';
			const needSession = async () => {
				if (sessionReady) return;
				if (sessionError !== '') throw new Error(sessionError);
				await ensureSession(run.projectId);
				sessionReady = true;
			};
			const guard = async (fn) => {
				try { await fn(); }
				catch (error) { sessionError = sessionError || firstLine(error?.message); }
			};
			// 终态且已落盘 → 用 journal；否则活查
			const terminal = JOURNAL_TERMINAL.has(run.status);
			let facts = terminal && run.facts != null ? run.facts : null;
			const patch = {};
			// ① 权威事实
			if (run.projectId !== '' && run.workflowRunId !== '' && facts === null) {
				await guard(async () => {
					await needSession();
					facts = scrubFacts(await getRunFacts(run.workflowRunId));
					if (terminal && typeof facts.status === 'string') patch.facts = facts;
				});
			}
			// ② 老 run 回填：严格按 workflowRunId 匹配 history；最多试 3 次（节点被删时不无限重试）
			if (sessionError === '' && run.projectId !== '' && run.viewNodeId !== '' && run.enriched !== true
				&& (run.detail == null || Object.keys(run.timeline ?? {}).length === 0 || !Array.isArray(run.references))) {
				const tries = (run.enrichTries ?? 0) + 1;
				patch.enrichTries = tries;
				if (tries >= 3) patch.enriched = true;
				await guard(async () => {
					await needSession();
					const json = await callOk(['session', 'query', 'canvas.detail', '--view-node-id', run.viewNodeId], 'canvas.detail', 30_000);
					const node = deepScan(json, (v) => v !== null && typeof v === 'object' && v.id === run.viewNodeId)[0];
					if (node !== undefined) Object.assign(patch, backfillFromHistory(run, node, pickHistory(node, run)));
					patch.enriched = true; // 节点已不在画布上也标记完成：没有可回填的东西
				});
			}
			if (Object.keys(patch).length > 0) {
				await store.mutate((s) => store.patchRun(s, runId, patch));
				run = snapshot(runId);
			}
			// ③ 模型名
			if (sessionError === '') {
				const named = await ensureDefinitionMeta(run, needSession).catch((error) => { sessionError = sessionError || firstLine(error?.message); return run; });
				run = named;
			}
			// ④ 组装
			const state = store.loadState();
			const view = buildRunDetail(run, facts, state);
			// ⑤ 预览：中间产物按 coreNodeId、引用按 viewNodeId 下到 cache（≤3/≤4，磁盘已有则复用）
			if (sessionError === '' && run.projectId !== '') {
				for (const item of view.intermediates.slice(0, 3)) {
					let hit = null;
					await guard(async () => { await needSession(); hit = await previewCanvasNode(run.projectId, { coreNodeId: item.coreNodeId }); });
					if (hit !== null) { item.url = hit.url; item.kind = hit.kind; }
				}
				for (const input of view.inputs.slice(0, 4)) {
					const assetId = state.runs.find((r) => r.id === input.upstreamRunId)?.assets?.[0];
					if (assetId !== undefined) { input.assetId = assetId; continue; }
					let hit = null;
					await guard(async () => { await needSession(); hit = await previewCanvasNode(run.projectId, { viewNodeId: input.viewNodeId }); });
					if (hit !== null) { input.url = hit.url; input.kind = hit.kind; }
				}
			}
			return { ok: true, ...view, ...(sessionError !== '' ? { factsError: sessionError } : {}) };
		});
	}

	return {
		generate, resume: generate, waitRun, status, definitions, runDetail,
		uploadMedia, downloadOne, ensureSession, closeSession,
		markSkillRead: (slug) => { readSkills.add(String(slug)); },
		listSkills,
	};
}
