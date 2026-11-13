import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';

test('启动入口遵循指定的监听端口', {timeout: 8000}, async () => {
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['src/serve.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {...process.env, HOST: '127.0.0.1', PORT: String(port)},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  try {
    let health;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, output);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {signal: AbortSignal.timeout(500)});
        if (response.ok) { health = await response.json(); break; }
      } catch {}
      await delay(25);
    }
    assert.equal(health?.status, 'ok', output);
    assert.ok(output.includes(`http://127.0.0.1:${port}`), output);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  }
});
