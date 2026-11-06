#!/usr/bin/env node
/**
 * 把仓库里的技能安装到任意技能根目录。
 *
 * 目录约定：仓库根下只有一个 .dsh/，里面并列放着 skills / scripts / data / plugins。
 * 技能装到 <root>/<name> 之后，共享依赖按“与 skills 同级”解析（<root>/../scripts、
 * <root>/../data），所以 copy 模式会把这些共享目录一起铺到 <root>/..，装完不依赖仓库。
 *
 * 两种模式：
 *   link  建目录联接/符号链接，指向仓库里的技能目录。改动即时生效，适合本机自用。
 *   copy  复制目录，并写入 repo.txt（仓库绝对路径），适合放到别处或给别的机器用。
 *
 * 用法：
 *   node .dsh/scripts/install-skills.mjs --root "C:\Users\me\.dsh\skills" --mode link
 *   node .dsh/scripts/install-skills.mjs --root "D:\other\.dsh\skills" --mode copy --force
 *   node .dsh/scripts/install-skills.mjs --root ... --skills 9c
 *   node .dsh/scripts/install-skills.mjs --root ... --mode copy --no-shared
 *
 * 退出码：0 全部就绪；1 有失败项。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本脚本所在目录（<repo>/.dsh/scripts）。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** DSH 根目录：<repo>/.dsh，skills / scripts / data 都在它下面并列。 */
const DSH_ROOT = path.resolve(HERE, '..');

/** 仓库根目录（本脚本位于 <repo>/.dsh/scripts/）。 */
const REPO_ROOT = path.resolve(DSH_ROOT, '..');

/** 仓库内技能目录。 */
const SKILLS_DIR = path.join(DSH_ROOT, 'skills');

/** 与 skills 并列的共享目录；copy 模式会把它们铺到 <技能根>/..。 */
const SHARED_DIRS = ['data', 'scripts'];

/** 依赖共享目录的技能。新增这类技能时记得加进来。 */
const SHARED_SKILLS = new Set(['9c']);

/** 默认安装全部技能。 */
const DEFAULT_SKILLS = ['9c'];

/** copy 模式下写入技能目录、用于定位仓库的文件。 */
const REPO_MARKER = 'repo.txt';

function parseArgs(argv) {
  const options = { root: '', mode: 'link', skills: DEFAULT_SKILLS, force: false, shared: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') options.root = argv[(index += 1)] ?? '';
    else if (arg === '--mode') options.mode = (argv[(index += 1)] ?? 'link').toLowerCase();
    else if (arg === '--skills') options.skills = String(argv[(index += 1)] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--force') options.force = true;
    else if (arg === '--no-shared') options.shared = false;
  }
  return options;
}

function usage() {
  const lines = [
    'install-skills.mjs — 把仓库技能装到指定技能根目录',
    '',
    `  仓库：${REPO_ROOT}`,
    `  DSH 根：${DSH_ROOT}`,
    '',
    '  --root  <dir>    目标技能根目录（必填），技能会装到 <dir>/<name>',
    '                  也可以直接给 DSH 根（…/.dsh），自动装到 <dir>/skills/<name>',
    '  --mode  link|copy  默认 link；copy 会写入 repo.txt 供技能定位仓库',
    `  --skills <a,b>   只装指定技能，默认 ${DEFAULT_SKILLS.join(',')}`,
    '  --force          目标已存在时删除后重装',
    `  --no-shared      不铺共享目录（${SHARED_DIRS.join(' / ')}）`,
    '',
    `  共享目录会铺到 <root>/..，即与技能目录同级；只有 ${[...SHARED_SKILLS].join(', ')} 需要它们。`,
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

/**
 * 把一个目录放到目标位置，已存在时按 --force 决定覆盖还是跳过。
 * @param source - 仓库里的真实目录。
 * @param destination - 目标位置。
 * @param options - 安装选项（mode / force）。
 * @returns 结果记录。
 */
function materialize(source, destination, options) {
  if (path.resolve(source) === path.resolve(destination)) {
    return { status: 'in-place', reason: '目标就是仓库内的原始目录，无需复制' };
  }
  if (fs.existsSync(destination)) {
    if (!options.force) return { status: 'skipped', reason: '目标已存在，未指定 --force' };
    fs.rmSync(destination, { recursive: true, force: true });
  }
  if (options.mode === 'link') {
    linkDir(source, destination);
    return { status: 'linked', path: destination, target: source };
  }
  copyDir(source, destination);
  return { status: 'copied', path: destination };
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

  let root = path.resolve(options.root);
  // 允许直接把 DSH 根（…/.dsh）交给 --root：技能落到 <root>/skills，
  // 共享目录落到 <root>/data、<root>/scripts，和仓库里的结构一致。
  if (path.basename(root) === '.dsh') root = path.join(root, 'skills');
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
      const outcome = materialize(source, destination, options);
      if (outcome.status === 'skipped' || outcome.status === 'failed' || outcome.status === 'in-place') {
        results.push({ name, ...outcome });
        continue;
      }
      if (options.mode === 'copy') {
        fs.writeFileSync(path.join(destination, REPO_MARKER), `${REPO_ROOT}\n`, 'utf8');
        results.push({ name, status: 'copied', path: destination, repo: REPO_ROOT });
      } else {
        results.push({ name, status: 'linked', path: destination, target: source });
      }
    } catch (error) {
      results.push({ name, status: 'failed', reason: error instanceof Error ? error.message : String(error) });
    }
  }

  // 共享目录铺到 <root>/..：技能里的相对路径按“与 skills 同级”解析，仓库内和安装后是同一条。
  const payloadRoot = path.resolve(root, '..');
  const shared = [];
  const needsShared = options.shared && options.skills.some((name) => SHARED_SKILLS.has(name));
  if (needsShared) {
    for (const dir of SHARED_DIRS) {
      const source = path.join(DSH_ROOT, dir);
      if (!fs.existsSync(source)) continue;
      try {
        shared.push({ dir, ...materialize(source, path.join(payloadRoot, dir), options) });
      } catch (error) {
        shared.push({ dir, status: 'failed', reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  console.log(JSON.stringify({ repo: REPO_ROOT, root, payloadRoot, mode: options.mode, results, shared }, null, 2));
  const failed = results.filter((item) => item.status === 'failed').length
    + shared.filter((item) => item.status === 'failed').length;
  process.exitCode = failed === 0 ? 0 : 1;
}

main();
