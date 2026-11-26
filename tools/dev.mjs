import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function launch(name, cwd, args) {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'cmd.exe' : 'npm';
  const fullArgs = isWin ? ['/c', 'npm', ...args] : args;
  // Keep stdin piped (not closed) so Vite does not auto-exit on non-TTY stdin EOF
  const proc = spawn(cmd, fullArgs, {
    cwd,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  proc.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`[${name}] exited with code ${code}`);
    }
  });
  return proc;
}

console.log('Starting Profit What-If Simulator (API :4000 + Vite UI :5173)...');
const api = launch('backend', path.join(rootDir, 'backend'), ['run', 'dev']);
const ui = launch('frontend', path.join(rootDir, 'frontend'), ['run', 'dev']);

function shutdown() {
  api.kill();
  ui.kill();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
