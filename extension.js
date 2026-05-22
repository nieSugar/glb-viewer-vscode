const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

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
    `<meta http-equiv="Content-Security-Policy"
    default-src 'none';
    img-src ${panel.webview.cspSource} https: data: blob:;
    script-src ${panel.webview.cspSource} 'wasm-unsafe-eval' blob:;
    worker-src ${panel.webview.cspSource} blob:;
    style-src ${panel.webview.cspSource} 'unsafe-inline' data:;
    font-src ${panel.webview.cspSource} data:;
    connect-src ${panel.webview.cspSource} https: data: blob:;
    >`
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
        'Would you like to use the GLTF Visual Viewer for .gltf files?',
        'Yes', 'No'
      );
    }
    catch (_e)
    {
      return;
    }

    // User dismissed the toast (X) -> don't mark as answered, ask again later.
    if (!selection) return;

    await context.globalState.update(gltfPromptedKey, true);
    if (selection !== 'Yes') return;

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

async function sendModelAsChunks(panel, modelUri)
{
  try
  {
    const data = await vscode.workspace.fs.readFile(modelUri); // Uint8Array, works for git+ etc.

    const fileSize = data.byteLength;
    const extension = path.extname(modelUri.fsPath).substring(1) || 'glb';

    // VS Code's webview IPC serializes messages and is unhappy with extremely
    // large payloads (~100MB+ tends to stall or fail). Stream the buffer in
    // chunks of 4MB so each postMessage stays small. Sending Uint8Array via
    // structured clone avoids the 33% base64 overhead too.
    const CHUNK_SIZE = 4 * 1024 * 1024;
    const totalChunks = Math.max(1, Math.ceil(fileSize / CHUNK_SIZE));
    const transferId = `glb-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    panel.webview.postMessage({
      type: 'modelChunkStart',
      transferId,
      extension,
      fileSize,
      totalChunks
    });

    for (let i = 0; i < totalChunks; i++)
    {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, fileSize);
      // Slice into a fresh Uint8Array so structured clone copies just this chunk.
      const chunk = new Uint8Array(data.buffer, data.byteOffset + start, end - start).slice();

      panel.webview.postMessage({
        type: 'modelChunk',
        transferId,
        index: i,
        data: chunk
      });
    }
  }
  catch (err)
  {
    vscode.window.showErrorMessage(`Failed to read GLB: ${err}`);
  }
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

      // Listen for messages from the WebView
      webviewPanel.webview.onDidReceiveMessage(message =>
      {
        if (message.type === 'ready')
        {
          // console.log('WebView is ready');
          webviewPanel.webview.postMessage({
            type: 'updateConfig',
            config: vscode.workspace.getConfiguration('glbViewer')
          });

          webviewPanel.webview.postMessage({
            type: 'setWebViewPath',
            webview_path: getWebViewPath(webviewPanel)
          });

          webviewPanel.webview.postMessage({
            type: 'showOpenOnBlenderButton'
          });

          console.log('Sending modelUri to WebView:', modelUriString);

          // VS Code's webview-resource fetch path can stall or fail for very
          // large files because the bytes are shuttled through IPC. Anything
          // not on the regular file system (e.g. git:) or above the size
          // threshold goes through chunked binary transfer instead.
          const LARGE_FILE_THRESHOLD = 50 * 1024 * 1024; // 50 MB
          const isVirtualFs = modelUriString.includes('git') || document.uri.scheme !== 'file';

          const extension = path.extname(document.uri.fsPath).substring(1) || 'glb';

          vscode.workspace.fs.stat(document.uri).then(stats =>
          {
            if (isVirtualFs || stats.size > LARGE_FILE_THRESHOLD)
            {
              sendModelAsChunks(webviewPanel, document.uri);
              return;
            }

            webviewPanel.webview.postMessage({
              type: 'loadModelFromUri',
              dataUri: modelUriString,
              extension,
              fileSize: stats.size
            });
          }).catch(_err =>
          {
            // If stat fails, fall back to chunked transfer (safest path).
            sendModelAsChunks(webviewPanel, document.uri);
          });
        }
        if (message.type === 'openJson')
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

        if (message.type === 'openInBlender')
        {
          console.log('opening in blender', document.uri.fsPath);

          const filePath = document.uri.fsPath;

          // Path to Blender executable (customize this!)
          const blenderPath = getBlenderPath();

          const command = `"${blenderPath}" --python-expr "import bpy; bpy.ops.import_scene.gltf(filepath='${filePath.replace(/\\/g, '\\\\')}')"`; // escape backslashes on Windows

          console.log('RUNNING', command);

          exec(command, (error, stdout, stderr) =>
          {
            if (error)
            {
              vscode.window.showErrorMessage(`Error launching Blender. Make sure to set the executable path in settings. \n\n${error.message}`);
              return;
            }
            console.log(stdout || stderr);
          });
        }
      });

      // webviewPanel.onDidChangeViewState(e =>
      // {
      //   console.log('onDidChangeViewState', e.webviewPanel.title);

      //   if (e.webviewPanel.visible)
      //   {
      //     console.log('WebView is now visible');

      //     webviewPanel.webview.postMessage({
      //       type: 'startRenderLoop'
      //     });
      //   }
      //   else
      //   {
      //     webviewPanel.webview.postMessage({
      //       type: 'stopRenderLoop'
      //     });
      //   }
      // });

      // webviewPanel.onDidDispose(() => disposePanel(webviewPanel), null, _disposables);

      vscode.workspace.onDidChangeConfiguration((event) =>
      {
        if (event.affectsConfiguration('glbViewer.relevant3dObjectKeys'))
        {
          webviewPanel.webview.postMessage({
            type: 'updateConfig',
            config: vscode.workspace.getConfiguration('glbViewer')
          });
        }
        if (event.affectsConfiguration('glbViewer.prettifyPropertyLabels'))
        {
          webviewPanel.webview.postMessage({
            type: 'updateConfig',
            config: vscode.workspace.getConfiguration('glbViewer')
          });
        }
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
