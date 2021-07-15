import * as ts2 from 'vscode-typescript-languageservice';
import { hyphenate } from '@vue/shared';
import * as html from 'vscode-html-languageservice';
import {
	CancellationToken,
	Range,
	ResultProgressReporter,
	SemanticTokensBuilder,
	SemanticTokensLegend,
	SemanticTokensPartialResult
} from 'vscode-languageserver/node';
import type { SourceFile } from '../sourceFile';
import type { ApiLanguageServiceContext } from '../types';

type TokenData = [number, number, number, number, number | undefined];

const tsLegend = ts2.getSemanticTokenLegend();
const tokenTypesLegend = [
	...tsLegend.types,
	'componentTag',
	'refLabel',
	'refVariable',
	'refVariableRaw',
];
const tokenTypes = new Map(tokenTypesLegend.map((t, i) => [t, i]));

export const semanticTokenLegend: SemanticTokensLegend = {
	tokenTypes: tokenTypesLegend,
	tokenModifiers: tsLegend.modifiers,
};

export function register({ sourceFiles, getTsLs, htmlLs, pugLs }: ApiLanguageServiceContext) {
	return (uri: string, range?: Range, cancle?: CancellationToken, resultProgress?: ResultProgressReporter<SemanticTokensPartialResult>) => {

		const sourceFile = sourceFiles.get(uri);
		if (!sourceFile) return;

		const document = sourceFile.getTextDocument();
		const offsetRange = range ?
			{
				start: document.offsetAt(range.start),
				end: document.offsetAt(range.end),
			} : {
				start: 0,
				end: document.getText().length,
			};
		const templateScriptData = sourceFile.getTemplateScriptData();
		const htmlElementsSet = new Set(templateScriptData.htmlElements);
		const components = new Set([
			...templateScriptData.components,
			...templateScriptData.components.map(hyphenate),
		].filter(name => !htmlElementsSet.has(name)));

		let tokens: TokenData[] = [];

		if (cancle?.isCancellationRequested) return;
		const htmlResult = getHtmlResult(sourceFile);
		if (htmlResult.length) {
			tokens = tokens.concat(htmlResult);
			resultProgress?.report(buildTokens(tokens));
		}

		if (cancle?.isCancellationRequested) return;
		const scriptSetupResult = getScriptSetupResult(sourceFile);
		if (scriptSetupResult.length) {
			tokens = tokens.concat(scriptSetupResult);
			resultProgress?.report(buildTokens(tokens));
		}

		if (cancle?.isCancellationRequested) return;
		let tsResult = getTsResult(sourceFile);
		tsResult = tsResult.filter(tsToken => {
			for (const setupToken of scriptSetupResult) {
				if (setupToken[0] === tsToken[0]
					&& setupToken[1] >= tsToken[1]
					&& setupToken[2] <= tsToken[2]) {
					return false;
				}
			}
			return true;
		});
		if (tsResult.length) {
			tokens = tokens.concat(tsResult);
		}

		return buildTokens(tokens);

		function buildTokens(tokens: TokenData[]) {
			const builder = new SemanticTokensBuilder();
			for (const token of tokens.sort((a, b) => a[0] - b[0] === 0 ? a[1] - b[1] : a[0] - b[0])) {
				builder.push(token[0], token[1], token[2], token[3], token[4] ?? 0);
			}

			return builder.build();
		}
		function getScriptSetupResult(sourceFile: SourceFile) {
			const result: TokenData[] = [];
			const scriptSetupGen = sourceFile.getScriptSetupData();
			const scriptSetup = sourceFile.getDescriptor().scriptSetup;
			if (scriptSetupGen && scriptSetup) {
				const genData = scriptSetupGen;
				for (const label of genData.labels) {
					const labelPos = document.positionAt(scriptSetup.loc.start + label.label.start);
					result.push([labelPos.line, labelPos.character, label.label.end - label.label.start + 1, tokenTypes.get('refLabel') ?? -1, undefined]);
					// for (const binary of label.binarys) {
					// 	for (const _var of binary.vars) {
					// 		const varPos = document.positionAt(scriptSetup.loc.start + _var.start);
					// 		result.push([varPos.line, varPos.character, _var.end - _var.start, tokenTypes.get('refVariable') ?? -1, undefined]);
					// 		for (const reference of _var.references) {
					// 			const referencePos = document.positionAt(scriptSetup.loc.start + reference.start);
					// 			result.push([referencePos.line, referencePos.character, reference.end - reference.start, tokenTypes.get('refVariable') ?? -1, undefined]);
					// 		}
					// 	}
					// }
				}
			}
			return result;
		}
		function getTsResult(sourceFile: SourceFile) {
			const result: TokenData[] = [];
			for (const sourceMap of sourceFile.getTsSourceMaps()) {

				const tsLs = getTsLs(sourceMap.lsType);
				let searchRange: {
					start: number,
					end: number,
				} | undefined;

				for (const maped of sourceMap) {
					if (
						maped.data.capabilities.semanticTokens
						&& maped.sourceRange.end > offsetRange.start
						&& maped.sourceRange.start < offsetRange.end
					) {
						if (!searchRange) {
							searchRange = {
								start: maped.sourceRange.start,
								end: maped.sourceRange.end,
							};
						}
						else {
							searchRange.start = Math.min(maped.sourceRange.start, searchRange.start);
							searchRange.end = Math.max(maped.sourceRange.end, searchRange.end);
						}
					}
				}

				if (searchRange) {
					console.log(searchRange);
					const tsRange = {
						start: sourceMap.mappedDocument.positionAt(searchRange.start),
						end: sourceMap.mappedDocument.positionAt(searchRange.end),
					};
					const tokens = tsLs.getDocumentSemanticTokens(sourceMap.mappedDocument.uri, tsRange, cancle);
					if (!tokens)
						continue;
					for (const token of tokens) {
						const tsStart = sourceMap.mappedDocument.offsetAt({ line: token[0], character: token[1] });
						const tsEnd = sourceMap.mappedDocument.offsetAt({ line: token[0], character: token[1] + token[2] });
						const vueRange = sourceMap.getSourceRange2(tsStart, tsEnd);
						if (!vueRange || !vueRange.data.capabilities.semanticTokens)
							continue;
						const vuePos = document.positionAt(vueRange.start);
						result.push([vuePos.line, vuePos.character, vueRange.end - vueRange.start, token[3], token[4]]);
					}
				}
			}
			return result;
		}
		function getHtmlResult(sourceFile: SourceFile) {
			const result: TokenData[] = [];

			for (const sourceMap of [...sourceFile.getHtmlSourceMaps(), ...sourceFile.getPugSourceMaps()]) {

				const docText = sourceMap.mappedDocument.getText();
				const scanner = sourceMap.language === 'html'
					? htmlLs.createScanner(docText, offsetRange.start)
					: pugLs.createScanner(sourceMap.pugDocument, offsetRange.start)
				if (!scanner) continue;

				let token = scanner.scan();
				while (token !== html.TokenType.EOS) {
					if (token === html.TokenType.StartTag || token === html.TokenType.EndTag) {
						const tokenText = scanner.getTokenText();
						if (components.has(tokenText)) {
							const tokenOffset = scanner.getTokenOffset();
							const tokenLength = scanner.getTokenLength();
							const vueRange = sourceMap.getSourceRange2(tokenOffset);
							if (vueRange) {
								const vueOffset = vueRange.start;
								if (vueOffset > offsetRange.end) break; // TODO: fix source map perf and break in while condition
								const vuePos = sourceMap.sourceDocument.positionAt(vueOffset);
								result.push([vuePos.line, vuePos.character, tokenLength, tokenTypes.get('componentTag') ?? -1, undefined]);
							}
						}
					}
					token = scanner.scan();
				}
			}

			return result;
		}
	}
}
