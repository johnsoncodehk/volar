import * as vscode from 'vscode';
import * as shared from '@volar/shared';
import type { LanguageClient } from 'vscode-languageclient/node';

export async function activate(context: vscode.ExtensionContext, languageClient: LanguageClient) {
	await languageClient.onReady();
	context.subscriptions.push(vscode.commands.registerCommand('volar.action.writeTemplateLsVirtualFiles', () => {
		languageClient.sendRequest(shared.WriteVirtualFilesRequest.type, { lsType: 'template' });
	}));
	context.subscriptions.push(vscode.commands.registerCommand('volar.action.writeScriptLsVirtualFiles', () => {
		languageClient.sendRequest(shared.WriteVirtualFilesRequest.type, { lsType: 'script' });
	}));
}
