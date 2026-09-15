import * as vscode from 'vscode';
import type { GatewayClient } from '../gateway/client';

/**
 * Her files as VS Code documents, read and written through the gateway (which may run on another
 * machine): `deskfish:/memory.md` and `deskfish:/charter.md` are editable (saving sends them back),
 * `deskfish:/journal.md`, `deskfish:/playbook.md` and `deskfish:/chats/<name>` are read-only. The
 * gateway stays the only process that writes her files.
 */
export class HerFilesProvider implements vscode.FileSystemProvider {
  static readonly scheme = 'deskfish';
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  /** What each file looked like when last read or written, so `stat` has a stable mtime and size. */
  private readonly seen = new Map<string, { text: string; mtime: number }>();

  constructor(private readonly client: GatewayClient) {}

  static uri(file: string): vscode.Uri {
    return vscode.Uri.from({ scheme: HerFilesProvider.scheme, path: `/${file}` });
  }

  private static editable(p: string): 'memory.md' | 'charter.md' | undefined {
    return p === '/memory.md' ? 'memory.md' : p === '/charter.md' ? 'charter.md' : undefined;
  }

  private async fetch(uri: vscode.Uri): Promise<string> {
    const p = uri.path;
    const editable = HerFilesProvider.editable(p);
    let text: string;
    if (editable) text = (await this.client.call('memory.read', { file: editable })).text;
    else if (p === '/journal.md') text = await this.client.call('journal.read');
    else if (p === '/playbook.md') text = await this.client.call('playbook.read');
    else if (p.startsWith('/chats/')) text = await this.client.call('chats.read', { name: p.slice('/chats/'.length) });
    else throw vscode.FileSystemError.FileNotFound(uri);
    const before = this.seen.get(p);
    if (!before || before.text !== text) this.seen.set(p, { text, mtime: Date.now() });
    return text;
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const known = this.seen.get(uri.path);
    const text = known?.text ?? (await this.fetch(uri));
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: this.seen.get(uri.path)?.mtime ?? 0,
      size: Buffer.byteLength(text),
      permissions: HerFilesProvider.editable(uri.path) ? undefined : vscode.FilePermission.Readonly,
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return Buffer.from(await this.fetch(uri), 'utf8');
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const file = HerFilesProvider.editable(uri.path);
    if (!file) throw vscode.FileSystemError.NoPermissions(uri);
    const text = Buffer.from(content).toString('utf8');
    await this.client.call('memory.write', { file, text });
    this.seen.set(uri.path, { text, mtime: Date.now() });
    this.changes.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}
