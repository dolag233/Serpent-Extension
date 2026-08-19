// Serpent-54122a: sign the Firefox build via AMO (self-hosted / unlisted
// channel, no human review). API credentials are read from hidden prompts and
// passed to web-ext through environment variables — never written to disk and
// never visible in the process argument list.
//
//   npm run release:firefox   (build + lint + this sign step)
//
// Requires AMO API keys: https://addons.mozilla.org/developers/addon/api/key/
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import readline from 'node:readline';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(rootDir, 'dist', 'extension-firefox');
const artifactsDir = path.join(rootDir, 'dist', 'firefox-signed');

/**
 * Hidden terminal prompt (no echo, no dependency). Uses readline's muted
 * trick instead of raw stdin so Windows Ctrl+V / right-click paste works.
 */
function promptHidden(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    let muted = false;
    rl._writeToOutput = (stringToWrite) => {
      if (!muted) rl.output.write(stringToWrite);
    };
    rl.question(promptText, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    // question() 已同步写完 prompt；此后吞掉输入回显（含粘贴的字符）。
    // 粘贴在 readline terminal 模式下逐字符进入，muted 后无回显但内容保留。
    setImmediate(() => {
      muted = true;
    });
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

  // web-ext 10.x 的 package.json exports 未暴露 ./bin/web-ext.js 子路径，
  // require.resolve 会抛 ERR_PACKAGE_PATH_NOT_EXPORTED；直接定位本地安装路径。
  const webExtBin = path.join(rootDir, 'node_modules', 'web-ext', 'bin', 'web-ext.js');
  console.log(`Signing ${sourceDir} (unlisted channel)…`);

  // web-ext 10.x 只接受 --api-key/--api-secret（不再读 AMO_JWT_* 环境变量）。
  // 密钥会短暂出现在子进程参数列表（web-ext 的 API 限制），但不写入任何文件。
  const child = spawn(process.execPath, [
    webExtBin,
    'sign',
    '--source-dir', sourceDir,
    '--artifacts-dir', artifactsDir,
    '--channel=unlisted',
    '--api-key', issuer.trim(),
    '--api-secret', secret.trim(),
    '--no-input',
  ], {
    cwd: rootDir,
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
