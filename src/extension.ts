import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentController } from './controller';
import { formatSize } from './desktop/files';
import { DesktopManager } from './desktop/manager';
import { ChatViewProvider } from './ui/chatView';
import { DesktopPanel } from './ui/desktopPanel';

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Deskfish');
  const desktop = new DesktopManager(ctx, output);
  const controller = new AgentController(ctx, output, desktop);
  await controller.init();
  const openDesktop = (opts?: { preserveFocus?: boolean }) => DesktopPanel.show(ctx, controller, output, opts);
  controller.setDesktopOpener(openDesktop);

  ctx.subscriptions.push(
    output,
    desktop,
    controller,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, new ChatViewProvider(ctx, controller, openDesktop), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('deskfish.openDesktop', openDesktop),
    vscode.commands.registerCommand('deskfish.setApiKey', () => controller.setApiKey()),
    vscode.commands.registerCommand('deskfish.changeModel', () => controller.changeModel()),
    vscode.commands.registerCommand('deskfish.startDesktop', () => desktop.start()),
    vscode.commands.registerCommand('deskfish.stopDesktop', () => controller.stopDesktop()),
    vscode.commands.registerCommand('deskfish.restartDesktop', () => controller.restartDesktop()),
    vscode.commands.registerCommand('deskfish.toggleDesktop', async () => {
      if ((await desktop.refresh()).state === 'on') await controller.stopDesktop();
      else await desktop.start();
    }),
    vscode.commands.registerCommand('deskfish.stopAgent', () => controller.stop()),
    vscode.commands.registerCommand('deskfish.newChat', () => controller.newConversation()),
    vscode.commands.registerCommand('deskfish.editMemory', async () => {
      const file = controller.memory.ensureFile();
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    }),
    vscode.commands.registerCommand('deskfish.clearMemory', async () => {
      const count = controller.memory.list().length;
      if (!count) {
        void vscode.window.showInformationMessage('Deskfish has no memories to forget.');
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Forget all ${count} ${count === 1 ? 'fact' : 'facts'} she remembers? Her self file and her journal are not touched.`,
        { modal: true },
        'Forget all',
      );
      if (choice !== 'Forget all') return;
      controller.memory.clear();
      output.appendLine('— memory cleared by the user —');
      void vscode.window.showInformationMessage('Deskfish: all memories forgotten.');
    }),
    vscode.commands.registerCommand('deskfish.showSelf', () => controller.showSelf()),
    vscode.commands.registerCommand('deskfish.openJournal', () => controller.openJournal()),
    vscode.commands.registerCommand('deskfish.openPlaybook', () => controller.openPlaybook()),
    vscode.commands.registerCommand('deskfish.editCharter', () => controller.editCharter()),
    vscode.commands.registerCommand('deskfish.pastChats', () => controller.pastChats()),
    vscode.commands.registerCommand('deskfish.deletePastChats', () => controller.deletePastChats()),
    vscode.commands.registerCommand('deskfish.reflect', () => controller.reflect(false)),
    vscode.commands.registerCommand('deskfish.scheduleTask', () => controller.scheduleTask()),
    vscode.commands.registerCommand('deskfish.scheduledTasks', () => controller.scheduledTasks()),
    vscode.commands.registerCommand('deskfish.exportMemory', () => controller.exportMemory()),
    vscode.commands.registerCommand('deskfish.importMemory', () => controller.importMemory()),
    vscode.commands.registerCommand('deskfish.showLog', () => output.show()),
    vscode.commands.registerCommand('deskfish.openDocs', () =>
      vscode.env.openExternal(vscode.Uri.file(path.join(ctx.extensionPath, 'docs', 'site', 'index.html'))),
    ),
    vscode.commands.registerCommand('deskfish.installRuntime', () => desktop.installRuntime()),
    vscode.commands.registerCommand('deskfish.saveFile', async () => {
      if ((await desktop.refresh()).state !== 'on') {
        void vscode.window.showInformationMessage('Deskfish: turn the desktop on first.');
        return;
      }
      try {
        const files = await controller.listDownloads();
        if (!files.length) {
          void vscode.window.showInformationMessage("Deskfish: there are no files in the desktop's Downloads folder.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          files.map((file) => ({ label: file.name, description: formatSize(file.size), file })),
          { title: "Save a file from the bot's desktop" },
        );
        if (pick) await controller.saveFile(pick.file);
      } catch (err) {
        void vscode.window.showErrorMessage(`Deskfish: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
}

export function deactivate(): void {
  // Disposables registered in activate() handle cleanup. The desktop container keeps running so
  // the next session starts instantly; turn it off from the sidebar if you want it gone.
}
