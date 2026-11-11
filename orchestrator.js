/**
 * dsh-az8 — 生成编排器（docs/design.md §5 状态机 / §4.1 主链路）。
 *
 * 严格遵守 az8 CLI 契约：一次一个写操作、每个写操作等终态 Receipt、写失败绝不自动重试、
 * watch 不套循环（等待统一走 waitWorkflowRun 单窗口）。操作输入经 capabilities.detail 的
 * JSON Schema 自适应映射（design §7），映射不了的留给服务端校验并透传可读错误。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
		await ensureSession(projectId ?? state.settings.defaultProjectId);
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
		const status = String(pickString(runJson, ['status']) ?? '').toLowerCase();
		if (['succeeded', 'success', 'completed', 'done'].includes(status)) return 'succeeded';
		if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) return 'failed';
		if (['pending', 'running', 'queued'].includes(status)) return 'running';
		return 'unknown';
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
					if (typeof item.coreNodeId === 'string' && item.coreNodeId !== '') push({ coreNodeId: item.coreNodeId });
					else if (typeof item.viewNodeId === 'string' && item.viewNodeId !== '') push({ viewNodeId: item.viewNodeId });
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
								}));
								return { status: 'completed', result: `AZ8 ${runId} 生成完成，产物 ${assets.length} 个（面板「资产」页可看）` };
							}
							if (terminal === 'failed') {
								await store.mutate((s) => store.patchRun(s, runId, { status: 'failed', endedAt: new Date().toISOString(), error: { code: 'run-failed', message: firstLine(JSON.stringify(runJson), 300) } }));
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
			}));
			return { ...snapshot(runId), assets, via, note: assets.length === 0 ? 'Run 成功但没解析到可下载产物：用 az8_media 手动下载（先 az8_runs get 看 run 事实）' : '' };
		}
		if (terminal === 'failed') {
			await store.mutate((s) => store.patchRun(s, runId, { status: 'failed', endedAt: new Date().toISOString(), error: { code: 'run-failed', message: firstLine(JSON.stringify(runJson), 300) } }));
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
				await store.mutate((s) => store.patchRun(s, existing.id, { status: 'running', workflowRunId, confirm: null }));
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
				await store.mutate((s) => store.patchRun(s, runId, { viewNodeId, status: 'planning' }));

				const refs = await resolveReferences(runId, projectId, args.references);

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
				await store.mutate((s) => store.patchRun(s, runId, { creditsEstimated: Number.isFinite(estimate) ? estimate : undefined }));
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
						hint: `报价 ${Number.isFinite(estimate) ? estimate : '未知'} credits（闸门 ${maxCredits}）。用户同意后用 az8_generate { resumeRunId: "${runId}", confirmed: true } 继续。`,
					};
				}

				const { workflowRunId } = await executePlanOps(runId, planOps);
				if (workflowRunId === '') throw Object.assign(new Error('plan.operations 执行完但没拿到 workflowRunId（最后一步: ' + firstLine(JSON.stringify(planOps.at(-1)?.name ?? ''), 120) + '）'), { classification: 'indeterminate' });
				await store.mutate((s) => store.patchRun(s, runId, { status: 'running', workflowRunId, confirm: null }));
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

	async function status() {
		const [whoami, credits, projectsJson] = await Promise.all([
			callOk(['whoami'], 'whoami', 30_000),
			callOk(['credits'], 'credits', 30_000),
			call(['projects', 'list', '--scope', 'owned'], 30_000),
		]);
		const projects = projectsJson.exitCode === 0 && Array.isArray(projectsJson.json?.projects) ? projectsJson.json.projects : [];
		await store.mutate((s) => store.setProjectsCache(s, projects));
		const current = await call(['session', 'current'], 15_000);
		return {
			whoami: whoami.account ?? whoami,
			credits: credits.balances ?? [],
			projects: store.loadState().projectsCache,
			session: current.exitCode === 0 ? current.json ?? { active: true } : { active: false },
			settings: store.loadState().settings,
		};
	}

	return {
		generate, resume: generate, waitRun, status, definitions,
		uploadMedia, downloadOne, ensureSession, closeSession,
		markSkillRead: (slug) => { readSkills.add(String(slug)); },
		listSkills,
	};
}
