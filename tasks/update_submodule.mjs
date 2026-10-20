import { execFileSync } from 'node:child_process';

execFileSync('git', ['submodule', 'update', '--init', '--recursive', '--', process.argv[2] || 'glb-viewer-core'], { stdio: 'inherit' });
