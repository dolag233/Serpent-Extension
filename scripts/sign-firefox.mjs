// Serpent-54122a: sign the Firefox build via AMO (self-hosted / unlisted
// channel, no human review). API credentials are read from hidden prompts and
// passed to web-ext through environment variables — never written to disk and
// never visible in the process argument list.
//
//   npm run release:firefox   (build + lint + this sign step)
//
// Requires AMO API keys: https://addons.mozilla.org/developers/addon/api/key/
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(rootDir, 'dist', 'extension-firefox');
const artifactsDir = path.join(rootDir, 'dist', 'firefox-signed');

/** Hidden terminal prompt (no echo, no dependency). */
function promptHidden(promptText) {
  process.stdout.write(promptText);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (char) => {
      if (char === '\r' || char === '\n') {
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write('\n');
        resolve(value);
      } else if (char === '') {
        process.exit(130);
      } else if (char === '' || char === '\b') {
        value = value.slice(0, -1);
      } else {
        value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const issuer = await promptHidden('AMO API issuer: ');
  if (!issuer.trim()) {
    console.error('Aborted: no API issuer provided.');
    process.exitCode = 1;
    return;
  }
  const secret = await promptHidden('AMO API secret (input is hidden): ');
  if (!secret.trim()) {
    console.error('Aborted: no API secret provided.');
    process.exitCode = 1;
    return;
  }

  const webExtBin = require.resolve('web-ext/bin/web-ext.js');
  console.log(`Signing ${sourceDir} (unlisted channel)…`);

  const child = spawn(process.execPath, [
    webExtBin,
    'sign',
    '--source-dir', sourceDir,
    '--artifacts-dir', artifactsDir,
    '--channel=unlisted',
    '--no-input',
  ], {
    cwd: rootDir,
    env: {
      ...process.env,
      AMO_JWT_ISSUER: issuer.trim(),
      AMO_JWT_SECRET: secret.trim(),
    },
    stdio: 'inherit',
  });

  const exitCode = await new Promise((resolve) => {
    child.once('error', (error) => {
      console.error('Failed to run web-ext sign:', error);
      resolve(1);
    });
    child.once('exit', (code) => resolve(code ?? 1));
  });

  if (exitCode === 0) {
    const files = await readdir(artifactsDir).catch(() => []);
    const xpi = files.find((name) => name.endsWith('.xpi'));
    if (xpi) {
      console.log(`\nSigned extension: ${path.join(artifactsDir, xpi)}`);
      console.log('Install in Firefox: about:addons → gear → "从文件安装附加组件…"');
    }
  }
  process.exitCode = exitCode;
}

await main();
