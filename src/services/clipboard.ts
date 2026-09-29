// The system clipboard, through the backend in the desktop app.
//
// The webview blocks the page from reading the clipboard (wry's clipboard
// access is off by default), so navigator.clipboard.readText() gave nothing:
// pasting text copied in a browser or any other program failed, on Linux and
// on Windows, and the vault's "clear the copied password after 25 s" check
// could never see its own password to clear it. The backend reads and writes
// the clipboard with Tauri's clipboard plugin instead. In the browser
// preview, the page's own clipboard API stands in.
import { isTauriEnvironment } from './tauriBridge';

export async function readClipboard(): Promise<string> {
  if (isTauriEnvironment()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('read_clipboard_text');
  }
  return navigator.clipboard ? navigator.clipboard.readText() : '';
}

export async function writeClipboard(text: string): Promise<void> {
  if (isTauriEnvironment()) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('write_clipboard_text', { text });
    return;
  }
  await navigator.clipboard?.writeText(text);
}
