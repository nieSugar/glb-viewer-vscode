const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const nativeMessages = vscode.env.language.toLowerCase().startsWith('zh')
  ? {
      useViewer: '是否使用 GLTF 可视化查看器打开 .gltf 文件？',
      yes: '是',
      no: '否',
      readFailed: '读取模型失败：',
      loadFailed: '加载模型失败：',
      externalResources: '此来源的 glTF 外部资源暂不支持。请将模型和依赖下载到本地后打开。',
      blenderFailed: '启动 Blender 失败。请在设置中指定可执行文件路径。'
    }
  : {
      useViewer: 'Would you like to use the GLTF Visual Viewer for .gltf files?',
      yes: 'Yes',
      no: 'No',
      readFailed: 'Failed to read model: ',
      loadFailed: 'Failed to load model: ',
      externalResources: 'External glTF resources from this filesystem are not supported. Download the model and its dependencies before opening it.',
      blenderFailed: 'Error launching Blender. Make sure to set the executable path in settings.'
    };

// const _disposables = [];

function getHTML(panel)
{
  const publicPath = path.join(__dirname, 'public');
  const htmlPath = path.join(publicPath, 'webview', 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');

  // Replace all asset references with webview URIs
  html = html.replace(/(["'])(\/webview\/assets\/[^"']+\.(js|css))\1/g, (match, quote, assetPath) =>
  {
    const assetFullPath = path.join(publicPath, assetPath);

    // If it's a CSS file, also process it to replace font URLs
    if (assetPath.endsWith('.css'))
    {
      let css = fs.readFileSync(assetFullPath, 'utf8');

      // Replace font URLs in CSS
      css = css.replace(/url\((\/webview\/fonts\/[^)]+\.(woff2))\)/g, (match, fontPath) =>
      {
        const fontFullPath = path.join(publicPath, fontPath);
        const webviewUri = panel.webview.asWebviewUri(vscode.Uri.file(fontFullPath));
        return `url(${webviewUri.toString()})`;
      });

      // Create a data URI for the modified CSS
      const cssDataUri = `data:text/css;base64,${Buffer.from(css).toString('base64')}`;
      return `${quote}${cssDataUri}${quote}`;
    }

    const webviewUri = panel.webview.asWebviewUri(vscode.Uri.file(assetFullPath));
    return `${quote}${webviewUri.toString()}${quote}`;
  });

  // Also replace any relative paths to assets
  html = html.replace(/(["'])\.\/webview\/assets\/([^"']+\.(js|css))\1/g, (match, quote, assetFile) =>
  {
    const assetFullPath = path.join(publicPath, 'assets', assetFile);

    const webviewUri = panel.webview.asWebviewUri(vscode.Uri.file(assetFullPath));
    return `${quote}${webviewUri.toString()}${quote}`;
  });

  html = html.replace(
    '<!-- content-security-policy-replaced-on-extension-js-->',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none';
    img-src ${panel.webview.cspSource} https: data: blob:;
    script-src ${panel.webview.cspSource} 'wasm-unsafe-eval' blob:;
    worker-src ${panel.webview.cspSource} blob:;
    style-src ${panel.webview.cspSource} 'unsafe-inline' data:;
    font-src ${panel.webview.cspSource} data:;
    connect-src ${panel.webview.cspSource} https: data: blob:;
    ">`
  );

  return html;
}

class GLBDocument
{
  constructor(uri)
  {
    this.uri = uri;
  }

  dispose()
  {

  }
}

// function disposePanel(panel)
// {
//   console.log('Disposing panel:', panel.title);
//   // Clean up our resources
//   panel.dispose();

//   _disposables.forEach(d => d.dispose());
//   _disposables.length = 0; // Clear the disposables array
// }

function getWebViewPath(webviewPanel)
{
  // console.log('getWebViewPath');

  // Handle requests for library URIs
  const webviewPath = path.join(__dirname);
  const webviewUri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(webviewPath));

  return `${webviewUri.toString()}/public/webview`;
}

function checkFileExtensionDefaults(context)
{
  const gltfPromptedKey = 'gltfEditorPromptShown';

  // Reset question for testing
  // context.globalState.update('gltfEditorPromptShown', false);

  const disposable = vscode.workspace.onDidOpenTextDocument(async(document) =>
  {
    // Re-read each time so dismissing/answering takes effect immediately
    if (context.globalState.get(gltfPromptedKey)) return;
    if (!document.uri.fsPath.endsWith('.gltf')) return;

    // Remember the editor that opened this .gltf, instead of relying on
    // window.activeTextEditor later (which may have changed or been disposed).
    const targetUri = document.uri;

    let selection;
    try
    {
      selection = await vscode.window.showInformationMessage(
        nativeMessages.useViewer,
        nativeMessages.yes, nativeMessages.no
      );
    }
    catch (_e)
    {
      return;
    }

    // User dismissed the toast (X) -> don't mark as answered, ask again later.
    if (!selection) return;

    await context.globalState.update(gltfPromptedKey, true);
    if (selection !== nativeMessages.yes) return;

    try
    {
      const config = vscode.workspace.getConfiguration('workbench');
      const associations = { ...(config.get('editorAssociations') || {}) };
      associations['*.gltf'] = 'glbViewer.customEditor';
      await config.update('editorAssociations', associations, vscode.ConfigurationTarget.Global);

      // Only reopen if the file is still open somewhere; openWith is safe even
      // if the active editor has since changed or been disposed.
      await vscode.commands.executeCommand('vscode.openWith', targetUri, 'glbViewer.customEditor');
    }
    catch (err)
    {
      console.warn('[glbViewer] failed to switch .gltf association:', err);
    }
  });

  context.subscriptions.push(disposable);
}

async function sendModelAsChunks(panel, modelUri, requestId, isCurrent)
{
  const data = await vscode.workspace.fs.readFile(modelUri);
  if (!isCurrent()) return;
  const fileSize = data.byteLength;
  const extension = (path.extname(modelUri.fsPath).substring(1) || 'glb').toLowerCase();
  if (extension === 'gltf' && modelUri.scheme !== 'file')
  {
    const json = JSON.parse(Buffer.from(data).toString('utf8'));
    const resources = [...(json.buffers || []), ...(json.images || [])];
    if (resources.some(resource => resource.uri && !/^(data:|https?:)/i.test(resource.uri)))
    {
      throw new Error(nativeMessages.externalResources);
    }
  }
  // Chunking bounds each IPC message; the filesystem API still reads the full file.
  const CHUNK_SIZE = 4 * 1024 * 1024;
  const totalChunks = Math.max(1, Math.ceil(fileSize / CHUNK_SIZE));
  const transferId = requestId;
  if (!await panel.webview.postMessage({ type: 'modelChunkStart', requestId, transferId, extension, fileSize, totalChunks })) return;
  for (let i = 0; i < totalChunks && isCurrent(); i++)
  {
    const start = i * CHUNK_SIZE;
    const chunk = data.slice(start, Math.min(start + CHUNK_SIZE, fileSize));
    if (!await panel.webview.postMessage({ type: 'modelChunk', transferId, index: i, data: chunk })) return;
  }
}

function getViewerConfiguration()
{
  const configuration = vscode.workspace.getConfiguration('glbViewer');
  return {
    prettifyPropertyLabels: configuration.get('prettifyPropertyLabels', true),
    relevant3dObjectKeys: configuration.get('relevant3dObjectKeys', ['name', 'visible', 'type', 'position', 'rotation', 'scale', 'globalScale', 'userData'])
  };
}

function getDefaultBlenderPath()
{
  if (process.platform === 'darwin')
  {
    const macPath = '/Applications/Blender.app/Contents/MacOS/Blender';
    if (fs.existsSync(macPath)) return macPath;
    return 'blender'; // fallback to PATH
  }

  if (process.platform === 'win32')
  {
    const possiblePaths = [];

    for (let i = 5; i > 2; i--)
    {
      for (let j = 6; j > -1; j--)
      {
        possiblePaths.push(`C:\\Program Files\\Blender Foundation\\Blender ${i}.${j}\\blender.exe`);
      }
    }

    possiblePaths.push('C:\\Program Files\\Blender Foundation\\Blender\\blender.exe');

    for (const p of possiblePaths)
    {
      if (fs.existsSync(p)) return p;
    }
    return 'blender'; // fallback to PATH
  }

  return 'blender'; // Linux or others
}

function getBlenderPath()
{
  const config = vscode.workspace.getConfiguration('glbViewer');
  const customPath = config.get('blenderPath')?.trim();
  return customPath && customPath.length > 0 ? customPath : getDefaultBlenderPath();
}

function activate(context)
{
  const provider =
  {
    async openCustomDocument(uri, openContext, token)
    {
      return new GLBDocument(uri);
    },

    async resolveCustomEditor(document, webviewPanel, _token)
    {
      console.log('Resolving custom editor for:', document.uri.toString());

      const modelUri = webviewPanel.webview.asWebviewUri(document.uri);
      const modelUriString = modelUri.toString();

      webviewPanel.webview.options = {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(__dirname, 'public', 'webview')),
          vscode.Uri.file(path.dirname(document.uri.fsPath))
        ],
        enableFindWidget: true,
        retainContextWhenHidden: true
      };

      webviewPanel.webview.html = getHTML(webviewPanel, modelUriString);

      let disposed = false;
      let generation = 0;
      let activeRequestId;
      const messageListener = webviewPanel.webview.onDidReceiveMessage(async message =>
      {
        if (disposed || !message || typeof message !== 'object' || typeof message.type !== 'string') return;
        if (message.type === 'ready')
        {
          const requestId = `model-${++generation}`;
          activeRequestId = requestId;
          const isCurrent = () => !disposed && activeRequestId === requestId;
          webviewPanel.webview.postMessage({ type: 'updateConfig', config: getViewerConfiguration() });
          webviewPanel.webview.postMessage({ type: 'setWebViewPath', webview_path: getWebViewPath(webviewPanel) });
          webviewPanel.webview.postMessage({ type: 'updateLanguage', language: vscode.env.language.toLowerCase().startsWith('zh') ? 'zh' : 'en' });
          webviewPanel.webview.postMessage({ type: 'setHostCapabilities', capabilities: {
            openJson: true, openAsText: true, openInBlender: document.uri.scheme === 'file'
          } });
          webviewPanel.webview.postMessage({ type: 'beginModelLoad', requestId });
          const extension = (path.extname(document.uri.fsPath).substring(1) || 'glb').toLowerCase();
          try
          {
            let stats;
            try { stats = await vscode.workspace.fs.stat(document.uri); }
            catch { stats = null; }
            if (!isCurrent()) return;
            if (document.uri.scheme === 'file' && (extension === 'gltf' || (stats && stats.size <= 50 * 1024 * 1024)))
            {
              await webviewPanel.webview.postMessage({ type: 'loadModelFromUri', requestId,
                dataUri: modelUriString, extension, fileSize: stats?.size || 0 });
            }
            else await sendModelAsChunks(webviewPanel, document.uri, requestId, isCurrent);
          }
          catch (error)
          {
            if (!isCurrent()) return;
            webviewPanel.webview.postMessage({ type: 'cancelModelLoad', requestId });
            vscode.window.showErrorMessage(`${nativeMessages.readFailed}${error.message}`);
          }
          return;
        }
        if (message.type === 'modelLoadState')
        {
          if (message.requestId === activeRequestId && message.status === 'error' && typeof message.error === 'string')
          {
            vscode.window.showErrorMessage(`${nativeMessages.loadFailed}${message.error}`);
          }
          return;
        }
        if (message.type === 'openJson' && message.payload !== null && typeof message.payload === 'object')
        {
          const jsonContent = JSON.stringify(message.payload, null, 2);

          vscode.workspace.openTextDocument({
            content: jsonContent,
            language: 'json'
          }).then(doc =>
          {
            vscode.window.showTextDocument(doc, vscode.ViewColumn.Active, true);
          });
        }

        if (message.type === 'openAsText')
        {
          vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
        }

        if (message.type === 'openInBlender' && document.uri.scheme === 'file')
        {
          console.log('opening in blender', document.uri.fsPath);

          const filePath = document.uri.fsPath;

          // Path to Blender executable (customize this!)
          const blenderPath = getBlenderPath();

          const expression = 'import bpy, sys; bpy.ops.import_scene.gltf(filepath=sys.argv[-1])';
          execFile(blenderPath, ['--python-expr', expression, '--', filePath], (error, stdout, stderr) =>
          {
            if (error)
            {
              vscode.window.showErrorMessage(`${nativeMessages.blenderFailed}\n\n${error.message}`);
              return;
            }
            console.log(stdout || stderr);
          });
        }
      });

      const configurationListener = vscode.workspace.onDidChangeConfiguration((event) =>
      {
        if (event.affectsConfiguration('glbViewer.relevant3dObjectKeys'))
        {
          webviewPanel.webview.postMessage({
            type: 'updateConfig',
            config: getViewerConfiguration()
          });
        }
        if (event.affectsConfiguration('glbViewer.prettifyPropertyLabels'))
        {
          webviewPanel.webview.postMessage({
            type: 'updateConfig',
            config: getViewerConfiguration()
          });
        }
      });
      webviewPanel.onDidDispose(() =>
      {
        disposed = true;
        activeRequestId = null;
        configurationListener.dispose();
        messageListener.dispose();
      });
    }
  };

  const openAsTextCommand = vscode.commands.registerCommand('glbViewer.openAsText', async(uri) =>
  {
    if (!uri && vscode.window.activeTextEditor)
    {
      uri = vscode.window.activeTextEditor.document.uri;
    }
    if (!uri) return;

    // Force open with default text editor
    await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
  });

  context.subscriptions.push(openAsTextCommand);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'glbViewer.customEditor',
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );

  checkFileExtensionDefaults(context);
}

function deactivate()
{}

module.exports = {
  activate,
  deactivate
};
