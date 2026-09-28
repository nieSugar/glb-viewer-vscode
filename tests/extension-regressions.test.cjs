const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const originalLoad = Module._load;
let provider, configListener, messageHandler, disposePanel, execCall;
let statSize = 60 * 1024 * 1024, readCount = 0, statFails = false;
const posts = [];
const uriFile = fsPath => ({ fsPath, scheme: 'file', toString: () => `file://${fsPath}` });
const originalReadFileSync = fs.readFileSync;
const readWebviewFixture = filePath => String(filePath).endsWith('.css')
  ? 'src:url(/webview/fonts/test.woff2)'
  : '<html><head><!-- content-security-policy-replaced-on-extension-js--><link href="/webview/assets/test.css"><script src="/webview/assets/test.js"></script></head></html>';
const vscode = {
  env: { language: 'en' }, Uri: { file: uriFile },
  workspace: {
    fs: {
      stat: async () => { if (statFails) throw new Error('stat failed'); return { size: statSize }; },
      readFile: async () => { readCount++; return Uint8Array.from([1, 2, 3]); }
    },
    getConfiguration: () => ({ get: () => `C:\\Program Files\\Blender '${String.fromCharCode(0x6e2c, 0x8a66)}'\\blender.exe` }),
    onDidOpenTextDocument: () => ({ dispose() {} }),
    onDidChangeConfiguration: listener => { configListener = listener; return { dispose: () => { listener.disposed = true; } }; }
  },
  window: {
    registerCustomEditorProvider: (_id, value) => { provider = value; return { dispose() {} }; },
    showErrorMessage: message => { throw new Error(message); }, showTextDocument: async () => {}
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
  ConfigurationTarget: { Global: 1 }, ViewColumn: { Active: 1 }
};
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  if (request === 'child_process') return { execFile: (...args) => { execCall = args; } };
  return originalLoad.call(this, request, parent, isMain);
};
const extension = require('../extension');
Module._load = originalLoad;
fs.readFileSync = readWebviewFixture;
function panel() {
  posts.length = 0;
  return {
    webview: {
      cspSource: 'vscode-webview-resource:',
      asWebviewUri: value => ({ toString: () => `vscode-webview-resource:${value.toString()}` }),
      onDidReceiveMessage: fn => { messageHandler = fn; return { dispose() {} }; },
      postMessage: message => { posts.push(message); return Promise.resolve(true); }
    },
    onDidDispose: fn => { disposePanel = fn; return { dispose() {} }; }
  };
}
async function ready(uri) {
  const target = panel();
  await provider.resolveCustomEditor({ uri }, target, {});
  await messageHandler({ type: 'ready' });
  await new Promise(resolve => setImmediate(resolve));
  return target;
}
async function main() {
  extension.activate({ subscriptions: [], globalState: { get: () => true, update: async () => {} } });
  const localGltf = uriFile(`E:\\github(Old)\\models\\file with spaces ${String.fromCharCode(0x6e2c, 0x8a66)}.gltf`);
  const gltfPanel = await ready(localGltf);
  assert(posts.some(item => item.type === 'loadModelFromUri'), 'large local glTF keeps its resource base');
  assert.equal(readCount, 0);
  assert(gltfPanel.webview.options.localResourceRoots.some(root => root.fsPath === require('node:path').dirname(localGltf.fsPath)));

  statFails = true;
  await ready(uriFile('E:\\github(Old)\\models\\fallback.gltf'));
  assert(posts.some(item => item.type === 'loadModelFromUri'), 'local glTF keeps its URI when stat fails');
  statFails = false;

  const remoteGlb = { fsPath: '/workspace/model.glb', scheme: 'git', toString: () => 'git:/workspace/model.glb' };
  await ready(remoteGlb);
  assert(posts.some(item => item.type === 'modelChunkStart'));
  assert.equal(readCount, 1);

  statSize = 1;
  const localGlb = uriFile(`E:\\github(Old)\\models\\O'Brien ${String.fromCharCode(0x6a21, 0x578b)}.glb`);
  const target = await ready(localGlb);
  assert(posts.some(item => item.type === 'loadModelFromUri'), 'github local path is not a virtual filesystem');
  messageHandler({ type: 'openInBlender' });
  assert.equal(execCall[0], `C:\\Program Files\\Blender '${String.fromCharCode(0x6e2c, 0x8a66)}'\\blender.exe`);
  assert.deepEqual(execCall[1].slice(0, 2), ['--python-expr', 'import bpy, sys; bpy.ops.import_scene.gltf(filepath=sys.argv[-1])']);
  assert.equal(execCall[1][2], '--');
  assert.equal(execCall[1][3], localGlb.fsPath);

  const listener = configListener;
  assert.equal(listener.disposed, undefined);
  disposePanel();
  assert.equal(listener.disposed, true);
  assert.match(target.webview.html, /http-equiv="Content-Security-Policy"\s+content="default-src 'none';/);
  assert.match(target.webview.html, /style-src [^;]+data:/);
  assert.match(target.webview.html, /font-src [^;]+data:/);
  assert.match(target.webview.html, /worker-src [^;]+blob:/);
  assert.match(target.webview.html, /connect-src [^;]+https: data: blob:/);
  fs.readFileSync = originalReadFileSync;
  console.log('extension regression checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
