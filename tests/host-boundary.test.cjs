const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const uri = (scheme = 'file', name = 'model.glb') => ({
  scheme, fsPath: '/models/' + name, toString: () => scheme + ':/models/' + name
});
const root = path.resolve(__dirname, '..');
let provider;
let stat = async() => ({ size: 1 });
let read = async() => Uint8Array.from([1, 2, 3]);
const errors = [], executions = [], configurations = [];
const vscode = {
  env: { language: 'en' }, Uri: { file: value => ({ fsPath: value, scheme: 'file', toString: () => value }) },
  workspace: {
    fs: { stat: value => stat(value), readFile: value => read(value) },
    getConfiguration: () => ({ get: (key, fallback) => key === 'blenderPath' ? '/usr/bin/blender' : fallback }),
    onDidOpenTextDocument: () => ({ dispose() {} }),
    onDidChangeConfiguration: listener => {
      const subscription = { listener, disposed: false, dispose() { this.disposed = true; } };
      configurations.push(subscription);
      return subscription;
    },
    openTextDocument: async() => ({})
  },
  window: {
    registerCustomEditorProvider: (_name, value) => { provider = value; return { dispose() {} }; },
    showErrorMessage: message => { errors.push(message); return Promise.resolve(); },
    showTextDocument: async() => {}
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async() => {} },
  ViewColumn: { Active: 1 }, ConfigurationTarget: { Global: 1 }
};
const module_stub = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'extension.js'), 'utf8'), {
  require(name) {
    if (name === 'vscode') return vscode;
    if (name === 'fs') return { readFileSync: () => '<!-- content-security-policy-replaced-on-extension-js-->', existsSync: () => false };
    if (name === 'child_process') return { execFile: (...args) => executions.push(args) };
    return require(name);
  },
  module: module_stub, __dirname: root, process, Buffer, Uint8Array, console: { log() {}, warn() {} }
}, { filename: path.join(root, 'extension.js') });
module_stub.exports.activate({ subscriptions: [], globalState: { get: () => true, update: async() => {} } });

async function panel(modelUri, post = async() => true) {
  const posts = [];
  const target = {
    posts, listenerDisposed: false,
    webview: {
      cspSource: 'vscode-webview-resource:',
      asWebviewUri: value => ({ toString: () => 'https://webview.test/' + encodeURIComponent(value.toString()) }),
      postMessage: message => { posts.push(message); return post(message); },
      onDidReceiveMessage: listener => { target.receive = listener; return { dispose: () => { target.listenerDisposed = true; } }; }
    },
    onDidDispose: listener => { target.dispose = listener; }
  };
  await provider.resolveCustomEditor({ uri: modelUri }, target, {});
  return target;
}

async function main() {
  const bridgeSource = fs.readFileSync(path.join(root, 'glb-viewer-core/src/js/HostBridge.js'), 'utf8');
  const { is_host_message } = await import('data:text/javascript;base64,' + Buffer.from(bridgeSource).toString('base64'));
  const validatePosts = target => {
    for (const message of target.posts) assert.equal(is_host_message(message), true, 'Extension message must satisfy the real Core contract: ' + message.type);
  };

  {
    const target = await panel(uri());
    await target.receive({ type: 'ready' });
    validatePosts(target);
    const requestId = target.posts.find(message => message.type === 'beginModelLoad').requestId;
    assert.equal(target.posts.find(message => message.type === 'loadModelFromUri').requestId, requestId);
    assert.equal(target.posts.find(message => message.type === 'setHostCapabilities').capabilities.openInBlender, true);
    const errorCount = errors.length;
    for (const message of [null, 'ready', {}, { type: 'modelLoadState', requestId: 'stale', status: 'error', error: 'stale' },
      { type: 'modelLoadState', requestId, status: 'loaded' }, { type: 'modelLoadState', requestId, status: 'error', error: {} }]) await target.receive(message);
    assert.equal(errors.length, errorCount);
    await target.receive({ type: 'modelLoadState', requestId, status: 'error', error: 'Invalid GLB' });
    assert.match(errors.at(-1), /Failed to load model: Invalid GLB/);
    await target.receive({ type: 'openInBlender' });
    assert.equal(executions.at(-1)[1].at(-1), '/models/model.glb');
    target.dispose();
    assert.equal(configurations.at(-1).disposed, true);
    assert.equal(target.listenerDisposed, true);
    const count = target.posts.length;
    await target.receive({ type: 'ready' });
    await target.receive({ type: 'modelLoadState', requestId, status: 'error', error: 'disposed' });
    assert.equal(target.posts.length, count);
    assert.doesNotMatch(errors.at(-1), /disposed/);
  }

  {
    const target = await panel(uri('git'));
    await target.receive({ type: 'ready' });
    validatePosts(target);
    const start = target.posts.find(message => message.type === 'modelChunkStart');
    assert.equal(start.requestId, target.posts.find(message => message.type === 'beginModelLoad').requestId);
    assert.equal(target.posts.find(message => message.type === 'modelChunk').transferId, start.transferId);
    assert.equal(target.posts.find(message => message.type === 'setHostCapabilities').capabilities.openInBlender, false);
    const count = executions.length;
    await target.receive({ type: 'openInBlender' });
    assert.equal(executions.length, count, 'Virtual documents cannot launch Blender on an unrelated disk path');
    target.dispose();
  }

  {
    read = async() => Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'geometry.bin', byteLength: 3 }] }));
    const target = await panel(uri('git', 'external.gltf'));
    await target.receive({ type: 'ready' });
    assert.equal(target.posts.some(message => message.type === 'modelChunkStart'), false);
    assert.match(errors.at(-1), /External glTF resources/);
    assert.equal(target.posts.at(-1).type, 'cancelModelLoad');
    validatePosts(target);
    target.dispose();
    read = async() => Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'data:application/octet-stream;base64,AQID', byteLength: 3 }] }));
    const embedded = await panel(uri('git', 'embedded.gltf'));
    await embedded.receive({ type: 'ready' });
    assert(embedded.posts.some(message => message.type === 'modelChunk'));
    validatePosts(embedded);
    embedded.dispose();
  }

  {
    const gate = deferred();
    let reads = 0;
    stat = () => gate.promise;
    read = async() => { reads++; return new Uint8Array(4); };
    const target = await panel(uri('git'));
    const ready = target.receive({ type: 'ready' });
    target.dispose();
    gate.resolve({ size: 4 });
    await ready;
    assert.equal(reads, 0, 'Closing a panel during stat must prevent the file read');
    assert.equal(target.posts.some(message => message.type === 'modelChunkStart'), false);
    stat = async() => ({ size: 1 });
  }

  {
    const gate = deferred();
    read = () => gate.promise;
    const target = await panel(uri('git'));
    const ready = target.receive({ type: 'ready' });
    await flush();
    const count = errors.length;
    target.dispose();
    gate.reject(new Error('late read error'));
    await ready;
    assert.equal(errors.length, count, 'A closed panel must not show late filesystem errors');
  }

  {
    const firstRead = deferred();
    let count = 0;
    read = () => ++count === 1 ? firstRead.promise : Promise.resolve(new Uint8Array(3));
    const target = await panel(uri('git'));
    const first = target.receive({ type: 'ready' });
    await flush();
    await target.receive({ type: 'ready' });
    firstRead.resolve(new Uint8Array(4));
    await first;
    const begins = target.posts.filter(message => message.type === 'beginModelLoad');
    const starts = target.posts.filter(message => message.type === 'modelChunkStart');
    assert.notEqual(begins[0].requestId, begins[1].requestId);
    assert.equal(starts.length, 1, 'A superseded read must never begin a transfer');
    assert.equal(starts[0].requestId, begins[1].requestId);
    validatePosts(target);
    target.dispose();
  }

  {
    read = async() => new Uint8Array(9 * 1024 * 1024);
    const pending = [];
    const target = await panel(uri('git'), message => {
      if (message.type !== 'modelChunkStart' && message.type !== 'modelChunk') return Promise.resolve(true);
      const gate = deferred(); pending.push({ message, gate }); return gate.promise;
    });
    const ready = target.receive({ type: 'ready' });
    await flush();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].message.type, 'modelChunkStart');
    pending[0].gate.resolve(true);
    await flush();
    assert.equal(pending.length, 2, 'Only one chunk may be pending delivery');
    assert.equal(pending[1].message.index, 0);
    pending[1].gate.resolve(true);
    await flush();
    assert.equal(pending.length, 3);
    assert.equal(pending[2].message.index, 1);
    target.dispose();
    pending[2].gate.resolve(true);
    await ready;
    assert.equal(pending.length, 3, 'Disposing a panel stops later chunks');
    validatePosts(target);
  }

  {
    read = async() => { throw new Error('file unavailable'); };
    const target = await panel(uri('git'));
    await target.receive({ type: 'ready' });
    assert.match(errors.at(-1), /Failed to read model: file unavailable/);
    assert.equal(target.posts.at(-1).type, 'cancelModelLoad');
    validatePosts(target);
    target.dispose();
  }
  console.log('Extension host contract, cancellation, chunk delivery and error checks passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
