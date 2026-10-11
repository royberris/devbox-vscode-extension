import * as crypto from 'crypto';
import * as vscode from 'vscode';

export interface PastedImage {
  mime: string;
  /** base64 */
  data: string;
  /** How the webview got it (paste event, clipboard.read, drop, file picker); logged to compare. */
  how: string;
}

/**
 * The extension runs on the server and `vscode.env.clipboard` is text only, so it cannot read the
 * laptop's clipboard. A webview is always rendered on the laptop: it reads the image there (paste
 * event, `navigator.clipboard.read()`, drop or file picker) and posts it to the extension.
 *
 * `onImage` handles the image; if it throws, the panel shows the error and stays open.
 * Resolves with true once an image was handled, false when the panel was closed.
 */
export function pickImage(title: string, log: vscode.OutputChannel, onImage: (img: PastedImage) => Promise<void>): Promise<boolean> {
  const panel = vscode.window.createWebviewPanel('devboxAgents.paste', title, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, { enableScripts: true });
  panel.iconPath = new vscode.ThemeIcon('file-media');
  panel.webview.html = html(crypto.randomBytes(16).toString('base64'), panel.webview.cspSource);
  return new Promise((resolve) => {
    let done = false;
    panel.webview.onDidReceiveMessage(async (m: { type: string; message?: string } & Partial<PastedImage>) => {
      if (m.type === 'log') return log.appendLine(`[paste] ${m.message}`);
      if (m.type !== 'image' || done) return;
      try {
        await onImage({ mime: String(m.mime), data: String(m.data), how: String(m.how) });
        done = true;
        resolve(true);
        panel.dispose();
      } catch (e) {
        void panel.webview.postMessage({ type: 'error', message: (e as Error).message });
      }
    });
    panel.onDidDispose(() => done || resolve(false));
  });
}

function html(nonce: string, cspSource: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data: blob:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); display: flex; align-items: center; justify-content: center; min-height: 90vh; margin: 0; }
  #zone { border: 2px dashed var(--vscode-focusBorder); border-radius: 8px; padding: 32px 40px; text-align: center; max-width: 440px; outline: none; }
  #zone.over { background: var(--vscode-list-hoverBackground); }
  h2 { margin: 0 0 8px; font-weight: 600; }
  p { color: var(--vscode-descriptionForeground); margin: 8px 0; }
  kbd { font-family: var(--vscode-editor-font-family); border: 1px solid var(--vscode-widget-border, #888); border-radius: 3px; padding: 1px 5px; }
  #status { min-height: 1.4em; margin-top: 16px; color: var(--vscode-foreground); }
  #status.error { color: var(--vscode-errorForeground); }
  button { margin-top: 12px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 12px; border-radius: 2px; cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>
<div id="zone" tabindex="0">
  <h2>Paste a screenshot</h2>
  <p>Press <kbd>⌘V</kbd> / <kbd>Ctrl+V</kbd>, or drop an image here.</p>
  <p>It is saved on the server and its path is pasted into the session.</p>
  <button id="pick">Choose File…</button>
  <input id="file" type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden>
  <div id="status"></div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const zone = document.getElementById('zone');
  const statusEl = document.getElementById('status');
  const log = (message) => vscode.postMessage({ type: 'log', message });
  const status = (text, error) => { statusEl.textContent = text; statusEl.className = error ? 'error' : ''; };
  let busy = false;

  async function send(blob, how) {
    if (busy) return;
    if (!blob || !/^image\\//.test(blob.type)) return status('That is not an image' + (blob && blob.type ? ' (' + blob.type + ')' : '') + '.', true);
    busy = true;
    status('Uploading ' + Math.round(blob.size / 1024) + ' KB…');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    log('got ' + blob.type + ' (' + bytes.length + ' bytes) via ' + how);
    vscode.postMessage({ type: 'image', mime: blob.type, data: btoa(bin), how });
  }

  document.addEventListener('paste', (e) => {
    const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
    log('paste event: ' + (items.map((i) => i.kind + ':' + i.type).join(', ') || 'no items'));
    const item = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    e.preventDefault();
    if (item) send(item.getAsFile(), 'paste event');
    else status('No image on the clipboard. Take a screenshot to the clipboard first (⌘⇧⌃4 on macOS).', true);
  });

  // Reading the clipboard directly saves a keypress, where the webview allows it.
  async function readClipboard(trigger) {
    if (busy) return;
    if (!navigator.clipboard || !navigator.clipboard.read) return log('clipboard.read not available');
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) return send(await item.getType(type), 'clipboard.read on ' + trigger);
      }
      log('clipboard.read on ' + trigger + ': no image');
    } catch (e) {
      log('clipboard.read on ' + trigger + ' failed: ' + e);
    }
  }

  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    send(e.dataTransfer.files[0], 'drop');
  });
  const file = document.getElementById('file');
  document.getElementById('pick').addEventListener('click', () => file.click());
  file.addEventListener('change', () => file.files[0] && send(file.files[0], 'file picker'));

  window.addEventListener('message', (e) => {
    if (e.data.type === 'error') { busy = false; status(e.data.message, true); }
  });
  window.addEventListener('focus', () => readClipboard('focus'));
  zone.focus();
  readClipboard('load');
</script>
</body>
</html>`;
}
