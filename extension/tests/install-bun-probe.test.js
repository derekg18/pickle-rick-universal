import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_SH = path.resolve(__dirname, '..', '..', 'install.sh');
const BANNER = 'Plumbus generative audit is running in degraded mode';

describe('install.sh bun probe', () => {
  test('install.sh contains bun probe with correct banner text', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    assert.ok(src.includes(BANNER), `install.sh must contain banner: "${BANNER}"`);
    assert.ok(src.includes('bun --version'), 'install.sh must probe bun --version');
  });

  test('bun probe emits banner when bun is absent', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    const probeLines = src
      .split('\n')
      .filter(l => l.includes('bun --version'))
      .join('\n');

    // Construct PATH without any bun entry
    const filteredPath = (process.env.PATH || '')
      .split(':')
      .filter(p => !p.toLowerCase().includes('bun') && !p.includes('.bun'))
      .join(':');

    const stdout = execSync(`bash -c ${JSON.stringify(probeLines)}`, {
      encoding: 'utf8',
      env: { ...process.env, PATH: filteredPath },
    });

    assert.ok(stdout.includes(BANNER), `expected banner "${BANNER}" in stdout, got: ${stdout}`);
  });

  test('no chmod +x applied to registry JSON', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    assert.ok(
      !src.includes('chmod +x') || !src.includes('engine-injected-keys.json'),
      'install.sh must not chmod +x engine-injected-keys.json',
    );
    const badLine = src
      .split('\n')
      .find(l => l.includes('chmod +x') && l.includes('engine-injected-keys.json'));
    assert.strictEqual(badLine, undefined, `found forbidden line: ${badLine}`);
  });

  test('chmod +x applied to plumbus-frame-analyzer.js', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    const hasChmod = src
      .split('\n')
      .some(l => l.includes('chmod +x') && l.includes('plumbus-frame-analyzer.js'));
    assert.ok(hasChmod, 'install.sh must chmod +x plumbus-frame-analyzer.js');
  });
});
