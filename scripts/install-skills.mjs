#!/usr/bin/env node
/**
 * 把仓库里的技能安装到任意技能根目录。
 *
 * 两种模式：
 *   link  建目录联接/符号链接，指向仓库里的技能目录。改动即时生效，适合本机自用。
 *   copy  复制目录，并写入 repo.txt（仓库绝对路径），适合放到别处或给别的机器用。
 *
 * 用法：
 *   node scripts/install-skills.mjs --root "C:\Users\me\.dsh\skills" --mode link
 *   node scripts/install-skills.mjs --root "D:\other\.dsh\skills" --mode copy --force
 *   node scripts/install-skills.mjs --root ... --skills 9c
 *
 * 退出码：0 全部就绪；1 有失败项。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（本脚本位于 <repo>/scripts/）。 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 仓库内技能目录。 */
const SKILLS_DIR = path.join(REPO_ROOT, '.dsh', 'skills');

/** 默认安装全部技能。 */
const DEFAULT_SKILLS = ['9c', 'shichijijiucai'];

/** copy 模式下写入技能目录、用于定位仓库的文件。 */
const REPO_MARKER = 'repo.txt';

function parseArgs(argv) {
  const options = { root: '', mode: 'link', skills: DEFAULT_SKILLS, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') options.root = argv[(index += 1)] ?? '';
    else if (arg === '--mode') options.mode = (argv[(index += 1)] ?? 'link').toLowerCase();
    else if (arg === '--skills') options.skills = String(argv[(index += 1)] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--force') options.force = true;
  }
  return options;
}

function usage() {
  const lines = [
    'install-skills.mjs — 把仓库技能装到指定技能根目录',
    '',
    `  仓库：${REPO_ROOT}`,
    '',
    '  --root  <dir>    目标技能根目录（必填），技能会装到 <dir>/<name>',
    '  --mode  link|copy  默认 link；copy 会写入 repo.txt 供技能定位仓库',
    `  --skills <a,b>   只装指定技能，默认 ${DEFAULT_SKILLS.join(',')}`,
    '  --force          目标已存在时删除后重装',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * 建目录链接：Windows 用 junction（不需要管理员权限），其他平台用符号链接。
 * @param target - 真实目录。
 * @param at - 链接位置。
 */
function linkDir(target, at) {
  if (process.platform === 'win32') {
    fs.symlinkSync(target, at, 'junction');
    return;
  }
  fs.symlinkSync(target, at, 'dir');
}

/**
 * 复制目录，跳过仓库内部的缓存类文件。
 * @param from - 源目录。
 * @param to - 目标目录。
 */
function copyDir(from, to) {
  fs.cpSync(from, to, {
    recursive: true,
    filter: (source) => !/[\\/](node_modules|\.cache)([\\/]|$)/.test(source),
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.root === '') {
    usage();
    process.exitCode = 1;
    return;
  }
  if (options.mode !== 'link' && options.mode !== 'copy') {
    console.log(`未知模式：${options.mode}`);
    process.exitCode = 1;
    return;
  }

  const root = path.resolve(options.root);
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });

  const results = [];
  for (const name of options.skills) {
    const source = path.join(SKILLS_DIR, name);
    const destination = path.join(root, name);
    if (!fs.existsSync(source)) {
      results.push({ name, status: 'failed', reason: `仓库里没有这个技能：${source}` });
      continue;
    }
    try {
      if (fs.existsSync(destination)) {
        if (!options.force) {
          results.push({ name, status: 'skipped', reason: '目标已存在，未指定 --force' });
          continue;
        }
        fs.rmSync(destination, { recursive: true, force: true });
      }
      if (options.mode === 'link') {
        linkDir(source, destination);
        results.push({ name, status: 'linked', path: destination, target: source });
      } else {
        copyDir(source, destination);
        fs.writeFileSync(path.join(destination, REPO_MARKER), `${REPO_ROOT}\n`, 'utf8');
        results.push({ name, status: 'copied', path: destination, repo: REPO_ROOT });
      }
    } catch (error) {
      results.push({ name, status: 'failed', reason: error instanceof Error ? error.message : String(error) });
    }
  }

  console.log(JSON.stringify({ repo: REPO_ROOT, root, mode: options.mode, results }, null, 2));
  const failed = results.filter((item) => item.status === 'failed');
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main();
