const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const scratch = mkdtempSync(join(tmpdir(), 'glb-package-check-'));
try
{
  const result = spawnSync(process.execPath, [join(__dirname, '../tasks/create_package.mjs')], {
    cwd: scratch, env: { ...process.env, PATH: scratch }, encoding: 'utf8'
  });
  assert.equal(result.status, 1, 'A failed VSIX command must stop the release chain');
}
finally
{
  rmSync(scratch, { recursive: true, force: true });
}

console.log('Package task failure check passed.');
