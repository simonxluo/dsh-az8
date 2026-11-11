/**
 * dsh-az8 — 状态存储（docs/design.md §2.1）。
 *
 * state.json（0600，tmp+rename 原子写）承载 settings / projectsCache / runs journal /
 * assets 索引 / meta 水位线。所有写入经 mutate() 串行事务；文件缺失的资产条目标记
 * missing 而不是删除（面板显示占位）。路径解析：显式 env（测试用）> 插件配置 > 默认
 * $DSH_HOME/integrations/dsh-az8/。
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export class StoreError extends Error {
	constructor(message) {
		super(message);
		this.name = 'StoreError';
	}
}

export const RUN_LIMIT = 200;
export const ASSET_LIMIT = 500;

const SETTINGS_LIMITS = {
	maxAutoCredits: { min: 0, max: 100_000 },
	waitTimeoutMs: { min: 5_000, max: 900_000 },
	panelPollMs: { min: 1_000, max: 60_000 },
};

// --- 路径 -------------------------------------------------------------------

let stateFile = '';
let assetsDir = '';
let skillsDir = '';

export function setPaths(config = {}) {
	const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
	const base = join(home, 'integrations', 'dsh-az8');
	stateFile = process.env.DSH_AZ8_STATE
		?? (typeof config.stateFile === 'string' && config.stateFile.trim() !== '' ? config.stateFile.trim() : join(base, 'state.json'));
	assetsDir = process.env.DSH_AZ8_ASSETS
		?? (typeof config.assetsDir === 'string' && config.assetsDir.trim() !== '' ? config.assetsDir.trim() : join(base, 'assets'));
	skillsDir = process.env.DSH_AZ8_SKILLS
		?? (typeof config.skillsDir === 'string' && config.skillsDir.trim() !== '' ? config.skillsDir.trim() : join(base, 'skills'));
}

export function getStateFile() { return stateFile || (setPaths({}), stateFile); }
export function getAssetsDir() { return assetsDir || (setPaths({}), assetsDir); }
export function getSkillsDir() { return skillsDir || (setPaths({}), skillsDir); }

// --- 默认状态 ----------------------------------------------------------------

export function defaultState() {
	return {
		schemaVersion: 1,
		settings: {
			defaultProjectId: '',
			maxAutoCredits: 30,
			waitTimeoutMs: 180_000,
			panelPollMs: 5_000,
		},
		projectsCache: [],
		runs: [],
		assets: [],
		meta: { idSeq: { r: 0, a: 0 }, updatedAt: '' },
	};
}

function normalize(loaded) {
	const base = defaultState();
	if (loaded === null || typeof loaded !== 'object') return base;
	const merged = { ...base, ...loaded };
	merged.settings = { ...base.settings, ...(loaded.settings ?? {}) };
	merged.meta = { ...base.meta, ...(loaded.meta ?? {}) };
	merged.meta.idSeq = { ...base.meta.idSeq, ...(loaded.meta?.idSeq ?? {}) };
	for (const key of ['projectsCache', 'runs', 'assets']) {
		merged[key] = Array.isArray(loaded[key]) ? loaded[key] : [];
	}
	return merged;
}

export function loadState() {
	const file = getStateFile();
	if (!existsSync(file)) return defaultState();
	try {
		return normalize(JSON.parse(readFileSync(file, 'utf8')));
	} catch (error) {
		throw new StoreError(`state.json 解析失败（${file}）: ${String(error?.message ?? error).split('\n', 1)[0]}`);
	}
}

async function saveState(state) {
	const file = getStateFile();
	state.meta.updatedAt = new Date().toISOString();
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, JSON.stringify(state, null, '\t') + '\n', { mode: 0o600 });
	await rename(tmp, file);
}

// 串行事务：同一进程内 mutate 排队执行，避免并发写覆盖。
let queue = Promise.resolve();

export function mutate(fn) {
	const next = queue.then(async () => {
		const state = loadState();
		const result = await fn(state);
		await saveState(state);
		return result;
	});
	queue = next.then(() => undefined, () => undefined);
	return next;
}

// --- 水位线 id（prefix r/a，不复用已删 id）--------------------------------------

function nextIdIn(list, prefix, meta) {
	let max = 0;
	for (const entry of list) {
		const m = /^([ra])(\d+)$/.exec(String(entry?.id ?? ''));
		if (m !== null && m[1] === prefix) max = Math.max(max, Number(m[2]));
	}
	const seq = meta.idSeq ?? {};
	const next = Math.max(max, Number(seq[prefix]) || 0) + 1;
	if (meta.idSeq === null || typeof meta.idSeq !== 'object') meta.idSeq = {};
	meta.idSeq[prefix] = next;
	return prefix + next;
}

export function nextRunId(state) { return nextIdIn(state.runs, 'r', state.meta); }
export function nextAssetId(state) { return nextIdIn(state.assets, 'a', state.meta); }

// --- settings ----------------------------------------------------------------

export function settingsPatch(patch = {}) {
	const out = {};
	if (patch.defaultProjectId !== undefined) {
		if (typeof patch.defaultProjectId !== 'string') throw new StoreError('defaultProjectId 需是字符串');
		out.defaultProjectId = patch.defaultProjectId.trim();
	}
	for (const key of Object.keys(SETTINGS_LIMITS)) {
		if (patch[key] === undefined) continue;
		const value = Number(patch[key]);
		if (!Number.isFinite(value) || value < SETTINGS_LIMITS[key].min || value > SETTINGS_LIMITS[key].max) {
			const { min, max } = SETTINGS_LIMITS[key];
			throw new StoreError(`${key} 需是 ${min}~${max} 之间的数字`);
		}
		out[key] = Math.round(value);
	}
	if (Object.keys(out).length === 0) throw new StoreError('settings patch 里没有可识别的字段');
	return out;
}

// --- runs journal / assets ------------------------------------------------------

export function appendRun(state, run) {
	state.runs.unshift(run);
	if (state.runs.length > RUN_LIMIT) state.runs.length = RUN_LIMIT;
	return run;
}

export function patchRun(state, runId, patch) {
	const run = state.runs.find((x) => x.id === runId);
	if (run === undefined) throw new StoreError(`run ${runId} 不存在`);
	Object.assign(run, patch);
	return run;
}

export function getRun(state, runId) {
	return state.runs.find((x) => x.id === runId);
}

export function appendAsset(state, asset) {
	state.assets.unshift(asset);
	if (state.assets.length > ASSET_LIMIT) state.assets.length = ASSET_LIMIT;
	return asset;
}

export function getAsset(state, assetId) {
	return state.assets.find((x) => x.id === assetId);
}

export function setProjectsCache(state, projects) {
	state.projectsCache = projects.map((p) => ({
		id: String(p.id ?? ''),
		name: String(p.name ?? ''),
		role: String(p.role ?? ''),
		updatedAt: String(p.updatedAt ?? ''),
	})).filter((p) => p.id !== '');
}
