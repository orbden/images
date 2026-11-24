#!/usr/bin/env node
// Smoke-test the current GHCR tags, then run all checks against their resolved digests.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const { images } = JSON.parse(readFileSync(new URL('../versions.json', import.meta.url), 'utf8'));
const targets = [
  ...images.frankenphp.runtimes.filter(r => r.supportStatus === 'supported').map(r => ({ group: 'frankenphp', name: `frankenphp:${r.phpVersion}`, tag: r.tag, digest: r.digest, entry: images.frankenphp })),
  ...['mariadb', 'postgres'].flatMap(group => images[group].runtimes.filter(r => r.supportStatus === 'supported').map(r => ({ group, name: `${group}:${r.version}`, tag: r.version, digest: r.digest, entry: images[group] }))),
  ...['valkey', 'meilisearch', 'node'].map(group => ({ group, name: group, tag: images[group].version, digest: images[group].digest, entry: images[group] })),
];
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/smoke-published.mjs [--list] [frankenphp[:8.3] | mariadb[:11.4] | postgres[:18] | valkey | meilisearch | node] ...');
  process.exit(0);
}
const names = args.filter(a => a !== '--list');
for (const name of names) if (!targets.some(t => t.group === name || t.name === name)) throw new Error(`Unknown target: ${name}`);
const selected = targets.filter(t => !names.length || names.includes(t.group) || names.includes(t.name));
if (args.includes('--list')) {
  for (const t of selected) console.log(`${t.name} ${t.entry.publishedImage}:${t.tag}`);
  process.exit(0);
}
function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`docker ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? ''}`);
  return result.stdout.trim();
}
const commands = { mariadb: 'mariadbd', postgres: 'postgres', valkey: 'valkey-server', meilisearch: 'meilisearch', node: 'node' };
let failures = 0;
for (const t of selected) {
  const tag = `${t.entry.publishedImage}:${t.tag}`;
  console.log(`\n${t.name}: pulling ${tag}`);
  try {
    docker('pull', tag);
    const digests = JSON.parse(docker('image', 'inspect', '--format', '{{json .RepoDigests}}', tag));
    const ref = digests.find(d => d.startsWith(`${t.entry.publishedImage}@sha256:`));
    if (!ref) throw new Error(`No GHCR digest found for ${tag}`);
    console.log(`  resolved ${ref}`);
    if (!/^sha256:[a-f0-9]{64}$/.test(t.digest ?? '') || ref !== `${t.entry.publishedImage}@${t.digest}`) {
      throw new Error(`Published digest does not match versions.json (${t.digest ?? 'missing'})`);
    }
    if (t.group !== 'frankenphp') {
      console.log(`  ${docker('run', '--rm', '--network', 'none', '--entrypoint', commands[t.group], ref, '--version').split('\n')[0]}`);
      continue;
    }
    docker('run', '--rm', '--network', 'none', '--entrypoint', 'frankenphp', ref, 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile');
    const php = '$required = ["redis", "Zend OPcache", "imagick", "intl", "apcu", "igbinary", "mysqli", "pdo_mysql", "pdo_pgsql"]; foreach ($required as $name) { if (!extension_loaded($name)) { fwrite(STDERR, "Missing extension: $name\\n"); exit(1); } }';
    docker('run', '--rm', '--network', 'none', '--entrypoint', 'php', ref, '-r', php);
    const container = `wcp-smoke-${randomUUID()}`;
    try {
      docker('run', '-d', '--network', 'none', '--name', container, ref);
      let ready = false;
      for (let i = 0; i < 30; i++) {
        const probe = spawnSync('docker', ['exec', container, 'curl', '--fail', '--silent', 'http://localhost/healthcheck'], { encoding: 'utf8', timeout: 5000 });
        if (probe.status === 0 && probe.stdout.trim() === 'OK') { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!ready) throw new Error(`Healthcheck failed. Container logs:\n${docker('logs', container)}`);
    } finally {
      spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore', timeout: 30000 });
    }
    console.log('  Caddy configuration, PHP extensions and HTTP healthcheck passed');
  } catch (error) {
    failures++;
    console.error(`  FAILED: ${error.message}`);
  }
}
if (failures) { console.error(`\n${failures} image(s) failed`); process.exitCode = 1; }
else console.log(`\n${selected.length} image(s) passed`);
