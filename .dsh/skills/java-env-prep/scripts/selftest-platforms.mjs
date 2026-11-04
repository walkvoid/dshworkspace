#!/usr/bin/env node
/**
 * 平台探测的纯函数自检（不发网络请求、不读写真实 profile）。
 *
 *   node scripts/selftest-platforms.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bookmarkItemsFromDoc,
  classifyHost,
  classifyText,
  collectDomains,
  discoverScriptSites,
  hasPlatformKind,
  matchKnownSite,
  mergePlatformsIntoProfile,
  missingPlatformKinds,
  registrableDomain,
  resolveRegistryPath,
  siteBase,
} from './env-prep.mjs';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
};

test('siteBase 只保留 origin', () => {
  assert.equal(siteBase('http://beecloud.jasolar.com:1040/#/login'), 'http://beecloud.jasolar.com:1040');
  assert.equal(siteBase('https://aio.llschain.com/home'), 'https://aio.llschain.com');
  assert.equal(siteBase('not-a-url'), null);
});

test('registrableDomain 处理二级后缀与 IP', () => {
  assert.equal(registrableDomain('nacos-auth.jasolar.com'), 'jasolar.com');
  assert.equal(registrableDomain('aio.llschain.com'), 'llschain.com');
  assert.equal(registrableDomain('a.b.com.cn'), 'b.com.cn');
  assert.equal(registrableDomain('172.16.111.6'), '172.16.111.6');
});

test('classifyHost 按主机名分段', () => {
  assert.deepEqual(classifyHost('aio.llschain.com'), ['bug']);
  assert.deepEqual(classifyHost('jenkins.jasolar.com'), ['release']);
  assert.deepEqual(classifyHost('logs.jasolar.com'), ['log']);
  assert.deepEqual(classifyHost('lowcode.jasolar.com'), []);
});

test('classifyText 不把 login/lowcode 当成 log', () => {
  assert.deepEqual(classifyText('lowcode login'), {});
  assert.deepEqual(classifyText('应用观测'), { log: ['应用观测'] });
  assert.deepEqual(classifyText('发布平台'), { release: ['发布'] });
});

test('matchKnownSite 识别 beecloud / aio / jenkins', () => {
  assert.equal(matchKnownSite({ host: 'beecloud.jasolar.com', name: '' })?.id, 'beecloud');
  assert.deepEqual(matchKnownSite({ host: 'beecloud.jasolar.com', name: '' })?.kinds, ['log', 'release']);
  assert.equal(matchKnownSite({ host: 'aio.llschain.com', name: 'AIO' })?.id, 'aio');
  assert.equal(matchKnownSite({ host: 'jenkins.jasolar.com', name: '' })?.id, 'jenkins');
});

test('collectDomains 从各环境地址归并出公司域名', () => {
  const domains = collectDomains({
    environments: [{ url: 'https://scf-dev.jasolar.com:30443' }],
    nacos: [{ url: 'http://nacos-auth.jasolar.com:1040/nacos' }],
    logs: [{ url: 'http://grafana.jasolar.com:1040/' }],
  });
  assert.deepEqual([...domains], ['jasolar.com']);
});

test('resolveRegistryPath 指向 project/.platforms.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'env-prep-selftest-'));
  const outDir = path.join(root, 'project', 'demo', '.env-prep');
  assert.equal(resolveRegistryPath(outDir), path.join(root, 'project', '.platforms.json'));
  assert.equal(resolveRegistryPath(outDir, path.join(root, 'custom.json')), path.join(root, 'custom.json'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('discoverScriptSites 只静态读 BASE，不执行脚本', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'env-prep-scripts-'));
  try {
    fs.mkdirSync(path.join(root, '.tools'), { recursive: true });
    fs.mkdirSync(path.join(root, '.aio'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.tools', 'beecloud.mjs'),
      "const BASE = 'http://beecloud.demo.com:1040';\nprocess.exit(99);\n",
      'utf8',
    );
    fs.writeFileSync(path.join(root, '.aio', 'aio.mjs'), "const BASE = 'https://aio.demo.com';\nprocess.exit(99);\n", 'utf8');
    const sites = discoverScriptSites(root);
    const beecloud = sites.find((item) => item.tools === '.tools/beecloud.mjs');
    const aio = sites.find((item) => item.tools === '.aio/aio.mjs');
    assert.ok(beecloud);
    assert.deepEqual([...beecloud.kinds].sort(), ['log', 'release']);
    assert.equal(beecloud.commands.log.includes('search'), true);
    assert.ok(aio);
    assert.deepEqual(aio.kinds, ['bug']);
    assert.equal(aio.commands.bug, 'node .aio/aio.mjs bugs');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bookmarkItemsFromDoc 保留书签文件夹路径', () => {
  const doc = {
    roots: {
      bookmark_bar: {
        children: [
          {
            type: 'folder',
            name: '工作',
            children: [
              {
                type: 'folder',
                name: '联易融',
                children: [{ type: 'url', name: 'AIO', url: 'https://aio.llschain.com/home' }],
              },
            ],
          },
        ],
      },
    },
  };
  const items = bookmarkItemsFromDoc(doc, 'chrome');
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://aio.llschain.com/home');
  assert.equal(items[0].folder, '工作 / 联易融');
});

test('mergePlatformsIntoProfile 写入且幂等', () => {
  const beecloud = {
    kind: 'log',
    site: 'beecloud',
    name: 'BeeCloud',
    url: 'http://beecloud.demo.com',
    confidence: 'script',
    tools: '.tools/beecloud.mjs',
    command: 'node .tools/beecloud.mjs search',
    api: '/u5/api/v1/auth/me',
    auth: 'script-managed',
  };
  const platforms = {
    log: beecloud,
    release: { ...beecloud, kind: 'release', api: undefined, command: null },
    bug: {
      kind: 'bug',
      site: 'aio',
      name: 'AIO',
      url: 'https://aio.demo.com',
      confidence: 'script',
      tools: '.aio/aio.mjs',
      command: 'node .aio/aio.mjs bugs',
      auth: 'script-managed',
    },
  };
  const profile = { project: 'demo', logs: [{ id: 'grafana', url: 'http://grafana.demo.com' }], platforms: {} };
  const changes = mergePlatformsIntoProfile(profile, platforms);
  assert.ok(changes.includes('platforms.log'));
  assert.equal(profile.logs.length, 2);
  assert.equal(profile.logs.find((item) => item.site === 'beecloud').tools, '.tools/beecloud.mjs');
  assert.equal(profile.release[0].site, 'beecloud');
  assert.equal(profile.bug[0].site, 'aio');
  assert.equal(profile.platforms.log.api, '/u5/api/v1/auth/me');

  const again = mergePlatformsIntoProfile(profile, platforms);
  assert.deepEqual(again, []);
});

test('mergePlatformsIntoProfile 不覆盖用户手写的平台入口', () => {
  const profile = {
    project: 'demo',
    logs: [],
    platforms: { log: { site: 'elk', name: 'ELK', url: 'http://elk.demo.com' } },
  };
  mergePlatformsIntoProfile(profile, {
    log: { kind: 'log', site: 'beecloud', name: 'BeeCloud', url: 'http://beecloud.demo.com', confidence: 'script' },
  });
  assert.equal(profile.platforms.log.site, 'elk');
});

test('hasPlatformKind / missingPlatformKinds', () => {
  const profile = {
    logs: [{ id: 'grafana', url: 'http://grafana.demo.com' }],
    platforms: { release: { site: 'beecloud', url: 'http://beecloud.demo.com' } },
  };
  assert.equal(hasPlatformKind(profile, 'log'), true);
  assert.equal(hasPlatformKind(profile, 'release'), true);
  assert.equal(hasPlatformKind(profile, 'bug'), false);
  assert.deepEqual(missingPlatformKinds(profile), ['bug']);
});

console.log(`\n${passed} passed`);
