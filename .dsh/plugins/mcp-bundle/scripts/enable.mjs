#!/usr/bin/env node
/**
 * Enable or remove @local/mcp-bundle on one dsh profile.
 *
 *   node scripts/enable.mjs --profile web --install
 *   node scripts/enable.mjs --profile desktop --dry-run
 *   node scripts/enable.mjs --profile web --remove
 *
 * The script only edits `<profile>/package.json` (dependency + bundle list),
 * writes a timestamped backup first, and optionally runs `pnpm install` in the
 * profile. It never touches cordis.patch.yml, so per-profile overrides keep
 * working.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_DIR = path.resolve(HERE, '..');
const PKG = '@local/mcp-bundle';

function usage() {
  console.log(`用法：node scripts/enable.mjs [选项]

  --profile <name>   目标 profile（默认 desktop）
  --home <dir>       DSH_HOME（默认 %USERPROFILE%\\.dsh 或 $DSH_HOME）
  --install          修改后在该 profile 里执行 pnpm install
  --remove           从 profile 移除本 bundle
  --dry-run          只打印将要做的修改
`);
}

function parseArgs(argv) {
  const options = { profile: 'desktop', home: '', install: false, remove: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--profile') options.profile = argv[(index += 1)] ?? '';
    else if (arg === '--home') options.home = argv[(index += 1)] ?? '';
    else if (arg === '--install') options.install = true;
    else if (arg === '--remove') options.remove = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') return { help: true };
  }
  return options;
}

function resolveHome(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.DSH_HOME) return path.resolve(process.env.DSH_HOME);
  return path.join(process.env.USERPROFILE ?? os.homedir(), '.dsh');
}

function findPnpm() {
  if (process.env.DSH_PNPM) return process.env.DSH_PNPM;
  const home = process.env.USERPROFILE ?? os.homedir();
  const candidates = [
    path.join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
  ];
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    usage();
    return 0;
  }
  if (!options.profile) {
    console.error('error: --profile needs a name');
    return 2;
  }

  const home = resolveHome(options.home);
  const profileDir = path.join(home, 'profiles', options.profile);
  const pkgPath = path.join(profileDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    console.error(`error: ${pkgPath} does not exist`);
    console.error(`hint: create the profile first, e.g. dsh ${options.profile} --dump-config`);
    return 2;
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.dsh ??= {};
  pkg.dsh.profile ??= {};
  pkg.dsh.profile.bundles ??= [];
  pkg.dependencies ??= {};

  const link = `link:${BUNDLE_DIR.split(path.sep).join('/')}`;
  const bundles = pkg.dsh.profile.bundles;
  const hasEntry = bundles.includes(PKG);
  const hasDependency = Object.hasOwn(pkg.dependencies, PKG);

  if (options.remove) {
    pkg.dsh.profile.bundles = bundles.filter((name) => name !== PKG);
    delete pkg.dependencies[PKG];
  } else {
    if (!hasDependency) pkg.dependencies[PKG] = link;
    if (!hasEntry) bundles.push(PKG);
  }

  const changed = options.remove ? hasEntry || hasDependency : !hasEntry || !hasDependency;
  console.log(`profile   ${profileDir}`);
  console.log(`bundle    ${options.remove ? 'remove' : 'add'} ${PKG}`);
  if (!changed) console.log('state     already in the requested state');
  if (!changed || options.dryRun) {
    if (!changed && !options.remove) console.log('next      nothing to do; restart the app if you just enabled it manually');
    return 0;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${pkgPath}.${stamp}.bak`;
  fs.copyFileSync(pkgPath, backup);
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log(`backup    ${backup}`);

  if (options.install) {
    const pnpm = findPnpm();
    if (!pnpm) {
      console.error('error: pnpm not found; run pnpm install in the profile manually');
      return 1;
    }
    console.log('install   pnpm install');
    const result = spawnSync(process.execPath, [pnpm, 'install'], { cwd: profileDir, stdio: 'inherit' });
    if (result.status !== 0) return result.status ?? 1;
  } else {
    console.log(`next      run: pnpm --dir "${profileDir}" install`);
  }

  if (options.remove) {
    console.log('next      restart the app; the tools disappear');
  } else {
    console.log('next      set the MCP_* / COS_* variables in %USERPROFILE%\\.dsh\\.env, then restart the app');
    console.log('verify    tools appear as mcp__mysql_dev__*, mcp__mysql_qa__*, mcp__cos__*');
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
