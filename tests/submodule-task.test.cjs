const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, sep } = require('node:path');

const scratch = mkdtempSync(join(tmpdir(), 'viewer-submodule-test-'));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test',
  '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try
{
  const root = resolve(__dirname, '..');
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.preinstall, undefined);
  assert.equal(packageJson.scripts.postinstall, undefined);
  const remote = join(scratch, 'remote');
  const parent = join(scratch, 'parent');
  git(scratch, 'init', '-b', 'main', remote);
  writeFileSync(join(remote, 'version'), 'first', 'utf8');
  git(remote, 'add', 'version');
  git(remote, 'commit', '-m', 'first');
  const pinned = git(remote, 'rev-parse', 'HEAD');
  git(scratch, 'init', '-b', 'main', parent);
  git(parent, 'submodule', 'add', remote, 'glb-viewer-core');
  git(parent, 'commit', '-am', 'pin core');
  writeFileSync(join(remote, 'version'), 'new upstream', 'utf8');
  git(remote, 'commit', '-am', 'advance core');
  const core = join(parent, 'glb-viewer-core');
  git(core, 'pull', 'origin', 'main');
  assert.notEqual(git(core, 'rev-parse', 'HEAD'), pinned);
  execFileSync(process.execPath, [join(root, 'tasks/update_submodule.mjs'), 'glb-viewer-core'],
    { cwd: parent, stdio: 'pipe' });
  assert.equal(git(core, 'rev-parse', 'HEAD'), pinned, 'Restore the parent commit rather than the upstream branch');
  assert.equal(git(parent, 'status', '--porcelain'), '');
  console.log('Pinned submodule checks passed.');
}
finally
{
  assert.ok(resolve(scratch).startsWith(resolve(tmpdir()) + sep));
  rmSync(scratch, { recursive: true, force: true });
}
