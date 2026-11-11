/**
 * dsh-az8 — az8 CLI 子进程封装。
 *
 * 唯一云端通道（docs/design.md §3）：
 * - 退出码语义：0 成功 / 1 确定性失败 / 2 不确定（indeterminate）。
 * - 读类命令仅在返回体 error.retryable 为真时有限重试（≤3，同 deadline 风格）；
 *   写类命令零重试——调用方（orchestrator）负责契约。
 * - 凭证由 az8 CLI 自管：本模块只继承环境，绝不读取、记录或转发任何凭证材料。
 * - stderr 的 az8.operation-progress.v1 进度帧是临时反馈，v1 不解析，仅保留末尾用于错误信息。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_BIN = 'az8';
const DEFAULT_TIMEOUT_MS = 60_000;
const OUTPUT_CAP = 32 * 1024 * 1024; // 单流 32 MiB 上限，防爆内存。

// Desktop GUI 进程的 PATH 常缺 npm 全局 bin（az8 装在那里）——补常见前缀。
const EXTRA_PATH = [
	'/opt/homebrew/bin',
	'/usr/local/bin',
	join(homedir(), '.npm-global/bin'),
	join(homedir(), '.local/bin'),
].filter((dir) => existsSync(dir));

function augmentedEnv() {
	const path = process.env.PATH ?? '/usr/bin:/bin';
	const merged = [...path.split(':'), ...EXTRA_PATH].filter((v, i, arr) => v !== '' && arr.indexOf(v) === i);
	return { ...process.env, PATH: merged.join(':') };
}

/** 把裸命令名解析成绝对路径（解析不了原样返回，交给 spawn 报错）。 */
function resolveBin(bin) {
	if (typeof bin !== 'string' || bin === '') return DEFAULT_BIN;
	if (bin.includes('/')) return existsSync(bin) ? bin : bin;
	for (const dir of ['.', ...EXTRA_PATH, ...augmentedEnv().PATH.split(':')]) {
		const candidate = join(dir === '' ? '.' : dir, bin);
		if (existsSync(candidate)) return candidate;
	}
	return bin;
}

export class Az8CliError extends Error {
	constructor(message, detail) {
		super(message);
		this.name = 'Az8CliError';
		Object.assign(this, detail); // exitCode, classification, retryable, json, killed
	}
}

function firstLine(text, max = 300) {
	const line = String(text ?? '').split('\n', 1)[0].trim();
	return line.length > max ? line.slice(0, max) + '…' : line;
}

function classify(exitCode, killed) {
	if (exitCode === 0) return 'ok';
	if (exitCode === 2) return 'indeterminate';
	if (killed) return 'indeterminate'; // 超时杀进程：结果未知，按不确定处理。
	return 'definitive';
}

function tryParseJson(text) {
	const trimmed = String(text ?? '').trim();
	if (trimmed === '' || !(trimmed.startsWith('{') || trimmed.startsWith('['))) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

/**
 * 运行一次 az8 命令。永不抛错——返回结构化结果，由调用方分类决策。
 * @returns {{exitCode:number, killed:boolean, classification:string, stdout:string, stderr:string, json?:any}}
 */
export function run(args, options = {}) {
	// 防御：宿主配置层可能传进非字符串（曾把整个宿主炸掉）——类型不对就回退默认 bin。
	const requested = options.cliBin;
	const binName = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : DEFAULT_BIN;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return new Promise((resolve) => {
		let child;
		let bin;
		try {
			bin = resolveBin(binName);
			child = spawn(bin, args, {
				cwd: options.cwd ?? process.cwd(),
				env: augmentedEnv(),
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (error) {
			resolve({
				exitCode: -1, killed: false, classification: 'definitive',
				stdout: '', stderr: `spawn ${bin} failed: ${firstLine(error?.message ?? error)}`,
			});
			return;
		}
		let stdout = '';
		let stderr = '';
		let killed = false;
		let settled = false;
		const timer = setTimeout(() => {
			killed = true;
			child.kill('SIGTERM');
			setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 5000);
		}, timeoutMs);
		const finish = (exitCode) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				exitCode,
				killed,
				classification: classify(exitCode, killed),
				stdout,
				stderr,
				json: tryParseJson(stdout),
			});
		};
		child.stdout.on('data', (chunk) => { if (stdout.length < OUTPUT_CAP) stdout += chunk.toString('utf8'); });
		child.stderr.on('data', (chunk) => { if (stderr.length < Math.min(OUTPUT_CAP, 256 * 1024)) stderr += chunk.toString('utf8'); });
		child.on('error', (error) => finish(-1) || void (stdout += firstLine(error?.message)));
		child.on('close', (code) => finish(code ?? -1));
	});
}

function errorFrom(result, args) {
	const jsonErr = result.json && typeof result.json === 'object' ? result.json.error : undefined;
	const message = firstLine(jsonErr?.message ?? result.stderr ?? result.stdout ?? `az8 exited ${result.exitCode}`);
	return new Az8CliError(`az8 ${args[0]}: ${message}`, {
		exitCode: result.exitCode,
		classification: result.classification,
		retryable: jsonErr?.retryable === true,
		json: result.json,
	});
}

/**
 * 运行并要求成功 + JSON 输出；失败抛 Az8CliError（带 classification）。
 * 仅用于读类命令的直通；写类命令由 orchestrator 直接用 run() 逐 Receipt 处理。
 */
export async function runJson(args, options = {}) {
	const result = await run(args, options);
	if (result.exitCode !== 0) throw errorFrom(result, args);
	if (result.json === undefined) {
		throw new Az8CliError(`az8 ${args[0]}: expected JSON output`, {
			exitCode: result.exitCode, classification: 'definitive', retryable: false,
		});
	}
	return result.json;
}

/**
 * 读类命令的有限重试：仅当返回体标记 error.retryable 才重试，至多 maxAttempts 次。
 * 写类命令禁止使用本函数（design §3 契约）。
 */
export async function runJsonReadWithRetry(args, options = {}, maxAttempts = 3) {
	let lastError;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const result = await run(args, options);
		if (result.exitCode === 0 && result.json !== undefined) return result.json;
		lastError = errorFrom(result, args);
		if (lastError.retryable !== true) break;
	}
	throw lastError;
}
