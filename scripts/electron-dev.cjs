const http = require('http');
const { spawn } = require('child_process');

const DEV_URL = 'http://127.0.0.1:5173';
const VITE_COMMAND = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function ping(url, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode && response.statusCode < 500);
    });

    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });

    request.on('error', () => resolve(false));
  });
}

async function waitForUrl(url, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await ping(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

function spawnChild(command, args, extraEnv = {}) {
  return spawn(command, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
}

async function main() {
  let viteProc = null;
  let shuttingDown = false;

  const cleanup = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (viteProc && !viteProc.killed) {
      viteProc.kill('SIGTERM');
    }
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);

  const hasExistingVite = await ping(DEV_URL);
  if (hasExistingVite) {
    console.log(`[electron:dev] reusing existing Vite server at ${DEV_URL}`);
  } else {
    console.log(`[electron:dev] starting Vite at ${DEV_URL}`);
    viteProc = spawnChild(VITE_COMMAND, ['vite', '--host', '127.0.0.1', '--strictPort']);

    const ready = await waitForUrl(DEV_URL);
    if (!ready) {
      cleanup();
      console.error(`[electron:dev] Vite did not become ready at ${DEV_URL}`);
      process.exitCode = 1;
      return;
    }
  }

  const electronProc = spawnChild(VITE_COMMAND, ['electron', './electron/main.cjs'], {
    VITE_DEV_SERVER_URL: DEV_URL,
  });

  electronProc.on('exit', (code, signal) => {
    cleanup();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 0;
  });

  if (viteProc) {
    viteProc.on('exit', (code) => {
      if (shuttingDown) return;
      console.error(`[electron:dev] Vite exited early with code ${code ?? 'unknown'}`);
      electronProc.kill('SIGTERM');
      process.exitCode = code ?? 1;
    });
  }
}

void main();