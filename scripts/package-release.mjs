/**
 * Build a distributable release zip.
 *
 *   node scripts/package-release.mjs
 *
 * Produces `release/extended-wled-controller-v<version>.zip` containing the
 * built server + core + web bundles and everything needed to run the container
 * (Dockerfile, compose, .env.example, README). Run `npm run build` first, or
 * pass `--build` to do it here.
 *
 * The spec asks for a zip "when the system is finished or on every major version
 * release". Wire this into a release checklist / CI when milestone 7 lands.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const name = `extended-wled-controller-v${version}`;

if (process.argv.includes('--build')) {
  console.log('building…');
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
}

const need = [
  'packages/core/dist',
  'packages/server/dist',
  'packages/web/dist',
];
for (const p of need) {
  if (!existsSync(join(root, p))) {
    console.error(`missing ${p} — run "npm run build" (or pass --build)`);
    process.exit(1);
  }
}

const stage = join(tmpdir(), name);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const include = [
  'package.json',
  'package-lock.json',
  'Dockerfile',
  'docker-compose.yml',
  '.env.example',
  'README.md',
  'tsconfig.base.json',
  'tsconfig.json',
  'packages/core/package.json',
  'packages/core/dist',
  'packages/server/package.json',
  'packages/server/dist',
  'packages/web/package.json',
  'packages/web/dist',
];
for (const rel of include) {
  const from = join(root, rel);
  if (!existsSync(from)) continue;
  cpSync(from, join(stage, rel), { recursive: true });
}

mkdirSync(join(root, 'release'), { recursive: true });
const zipPath = join(root, 'release', `${name}.zip`);
rmSync(zipPath, { force: true });

const isWin = process.platform === 'win32';
if (isWin) {
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipPath}' -Force"`,
    { stdio: 'inherit' },
  );
} else {
  execSync(`cd "${stage}" && zip -qr "${zipPath}" .`, { stdio: 'inherit', shell: '/bin/bash' });
}
rmSync(stage, { recursive: true, force: true });
console.log(`\nwrote release/${name}.zip`);
