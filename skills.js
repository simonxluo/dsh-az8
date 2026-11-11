/**
 * dsh-az8 — 技能包（docs/design.md §2.2，从 dsh-comfyui 移植的三级披露模式）。
 *
 * skills/<slug>/SKILL.md（首行注释 <!-- must-read --> 标记运行前必读）
 * + references/*.md（正文点名才读）+ assets/（参考图）。
 * list 只给一行摘要；read 才取正文；工具层的必读闸门由 orchestrator 调 mustReadGate。
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getSkillsDir, StoreError } from './store.js';

function slugOk(slug) {
	return /^[a-z0-9][a-z0-9-_.\u4e00-\u9fa5]{0,80}$/i.test(slug);
}

function skillDir(slug) {
	if (!slugOk(slug)) throw new StoreError(`slug 非法: ${slug}`);
	return join(getSkillsDir(), slug);
}

function parseSkill(slug, text) {
	const mustRead = /<!--\s*must-read\s*-->/.test(text.split('\n', 5).join('\n'));
	const titleLine = text.split('\n').find((l) => l.startsWith('# ')) ?? `# ${slug}`;
	const afterTitle = text.slice(text.indexOf(titleLine) + titleLine.length).trim();
	const summary = afterTitle.split('\n', 1)[0].replace(/<[^>]+>/g, '').trim().slice(0, 160);
	const references = [...text.matchAll(/references\/([A-Za-z0-9._-\u4e00-\u9fa5]+\.md)/g)]
		.map((m) => m[1]).filter((v, i, arr) => arr.indexOf(v) === i);
	return { slug, title: titleLine.replace(/^#\s*/, ''), summary, mustRead, references };
}

export async function listSkills() {
	const root = getSkillsDir();
	if (!existsSync(root)) return [];
	const out = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const file = join(root, entry.name, 'SKILL.md');
		if (!existsSync(file)) continue;
		try {
			out.push(parseSkill(entry.name, await readFile(file, 'utf8')));
		} catch { /* 读不了的条目跳过 */ }
	}
	return out;
}

export async function readSkill(slug, reference) {
	const dir = skillDir(slug);
	const file = reference === undefined ? join(dir, 'SKILL.md') : join(dir, 'references', reference);
	if (!existsSync(file)) throw new StoreError(`${reference === undefined ? 'SKILL.md' : `references/${reference}`} 不存在（slug: ${slug}）`);
	return { slug, reference: reference ?? null, content: await readFile(file, 'utf8') };
}

export async function writeSkill(slug, content, mode = 'write') {
	const file = join(skillDir(slug), 'SKILL.md');
	await mkdir(dirnameOf(file), { recursive: true });
	let next = String(content ?? '');
	if (mode === 'append') {
		const prev = existsSync(file) ? await readFile(file, 'utf8') : '';
		next = prev === '' ? String(content ?? '') : `${prev.replace(/\s*$/, '')}\n\n${String(content ?? '')}`;
	}
	await writeFile(file, next.endsWith('\n') ? next : next + '\n', { mode: 0o600 });
	return { slug, bytes: Buffer.byteLength(next), mode };
}

function dirnameOf(file) {
	const idx = file.lastIndexOf('/');
	return idx <= 0 ? '/' : file.slice(0, idx);
}

/** 必读闸门：mustRead 且本会话未读过 → 拒绝并给出指引（design §5 I 系列不变量之外的行为闸）。 */
export function mustReadGate(skills, slug, readSet) {
	const skill = skills.find((s) => s.slug === slug);
	if (skill === undefined || skill.mustRead !== true) return;
	if (readSet.has(slug)) return;
	throw new StoreError(`技能包 "${slug}" 标记了运行前必读：先用 az8_skill read 读完再生成`);
}
