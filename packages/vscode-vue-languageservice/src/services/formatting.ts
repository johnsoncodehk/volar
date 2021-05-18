import * as prettyhtml from '@starptech/prettyhtml';
import { notEmpty } from '@volar/shared';
import { transformTextEdit } from '@volar/transforms';
import * as prettier from 'prettier';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
	FormattingOptions,
	Range,
	TextEdit
} from 'vscode-languageserver/node';
import { createSourceFile } from '../sourceFile';
import type { HtmlApiRegisterOptions } from '../types';
import * as sharedServices from '../utils/languageServices';

export function register({ ts }: HtmlApiRegisterOptions) {
	let stringDocMap = new Map();
	return (_document: TextDocument, options: FormattingOptions) => {

		const tsService2 = sharedServices.getCheapTsService2(ts, _document);
		let document = TextDocument.create(tsService2.uri, _document.languageId, _document.version, _document.getText()); // TODO: high cost

		const sourceFile = createSourceFile(document, tsService2.service, ts, 'format', undefined, stringDocMap);
		let newDocument = document;

		const pugEdits = getPugFormattingEdits();
		const htmlEdits = getHtmlFormattingEdits();
		if (pugEdits.length + htmlEdits.length > 0) {
			newDocument = applyTextEdits(document, [
				...pugEdits,
				...htmlEdits,
			]);
			sourceFile.update(newDocument); // TODO: high cost
		}

		const tsEdits = getTsFormattingEdits();
		const cssEdits = getCssFormattingEdits();
		if (tsEdits.length + cssEdits.length > 0) {
			newDocument = applyTextEdits(newDocument, [
				...tsEdits,
				...cssEdits,
			]);
			sourceFile.update(newDocument); // TODO: high cost
		}

		const indentTextEdits = patchInterpolationIndent();
		newDocument = applyTextEdits(newDocument, indentTextEdits);
		if (newDocument.getText() === document.getText()) return;

		const editRange = Range.create(
			document.positionAt(0),
			document.positionAt(document.getText().length),
		);
		const textEdit = TextEdit.replace(editRange, newDocument.getText());
		return [textEdit];

		function patchInterpolationIndent() {
			const indentTextEdits: TextEdit[] = [];
			const tsSourceMap = sourceFile.getTemplateScriptFormat().sourceMap;
			if (!tsSourceMap) return indentTextEdits;

			for (const maped of tsSourceMap) {
				if (!maped.data.capabilities.formatting)
					continue;

				const textRange = {
					start: newDocument.positionAt(maped.sourceRange.start),
					end: newDocument.positionAt(maped.sourceRange.end),
				};
				const text = newDocument.getText(textRange);
				if (text.indexOf('\n') === -1)
					continue;
				const lines = text.split('\n');
				const removeIndent = getRemoveIndent();
				const baseIndent = getBaseIndent();
				for (let i = 1; i < lines.length; i++) {
					const line = lines[i];
					if (line.startsWith(removeIndent)) {
						lines[i] = line.replace(removeIndent, baseIndent);
					}
					else {
						lines[i] = baseIndent.replace(removeIndent, '') + line;
					}
				}
				indentTextEdits.push({
					newText: lines.join('\n'),
					range: textRange,
				});

				function getRemoveIndent() {
					const lastLine = lines[lines.length - 1];
					return lastLine.substr(0, lastLine.length - lastLine.trimStart().length);
				}
				function getBaseIndent() {
					const startPos = newDocument.positionAt(maped.sourceRange.start);
					const startLineText = newDocument.getText({ start: startPos, end: { line: startPos.line, character: 0 } });
					return startLineText.substr(0, startLineText.length - startLineText.trimStart().length);
				}
			}
			return indentTextEdits;
		}
		function getCssFormattingEdits() {
			const textEdits: TextEdit[] = [];
			for (const sourceMap of sourceFile.getCssSourceMaps()) {
				if (!sourceMap.capabilities.formatting) continue;
				for (const maped of sourceMap) {

					const languageId = sourceMap.mappedDocument.languageId;
					if (
						languageId !== 'css'
						&& languageId !== 'less'
						&& languageId !== 'scss'
						&& languageId !== 'postcss'
					) continue;

					const newStyleText = prettier.format(sourceMap.mappedDocument.getText(), {
						tabWidth: options.tabSize,
						useTabs: !options.insertSpaces,
						parser: languageId,
					});

					const vueRange = {
						start: sourceMap.sourceDocument.positionAt(maped.sourceRange.start),
						end: sourceMap.sourceDocument.positionAt(maped.sourceRange.end),
					};
					const textEdit = TextEdit.replace(
						vueRange,
						'\n' + newStyleText
					);
					textEdits.push(textEdit);
				}
			}
			return textEdits;
		}
		function getHtmlFormattingEdits() {
			const result: TextEdit[] = [];
			for (const sourceMap of sourceFile.getHtmlSourceMaps()) {
				for (const maped of sourceMap) {

					const prefixes = '<template>';
					const suffixes = '</template>';

					let newHtml = prettyhtml(prefixes + sourceMap.mappedDocument.getText() + suffixes, {
						tabWidth: options.tabSize,
						useTabs: !options.insertSpaces,
						printWidth: 100,
					}).contents;
					newHtml = newHtml.trim();
					newHtml = newHtml.substring(prefixes.length, newHtml.length - suffixes.length);

					const vueRange = {
						start: sourceMap.sourceDocument.positionAt(maped.sourceRange.start),
						end: sourceMap.sourceDocument.positionAt(maped.sourceRange.end),
					};
					const textEdit = TextEdit.replace(vueRange, newHtml);
					result.push(textEdit);
				}
			}
			return result;
		}
		function getPugFormattingEdits() {
			let result: TextEdit[] = [];
			for (const sourceMap of sourceFile.getPugSourceMaps()) {
				const pugEdits = sharedServices.pug.format(sourceMap.pugDocument, options);
				const vueEdits = pugEdits
					.map(pugEdit => transformTextEdit(
						pugEdit,
						pugRange => sourceMap.getSourceRange(pugRange.start, pugRange.end),
					))
					.filter(notEmpty);
				result = result.concat(vueEdits);
			}
			return result;
		}
		function getTsFormattingEdits() {
			const result: TextEdit[] = [];
			const tsSourceMaps = [
				...sourceFile.getTsSourceMaps(),
				sourceFile.getTemplateScriptFormat().sourceMap,
				...sourceFile.getScriptsRaw().sourceMaps,
			].filter(notEmpty);

			for (const sourceMap of tsSourceMaps) {
				if (!sourceMap.capabilities.formatting) continue;
				const cheapTs = sharedServices.getCheapTsService2(ts, sourceMap.mappedDocument);
				const textEdits = cheapTs.service.doFormatting(cheapTs.uri, options);
				for (const textEdit of textEdits) {
					for (const vueRange of sourceMap.getSourceRanges(textEdit.range.start, textEdit.range.end)) {
						if (!vueRange.data.capabilities.formatting) continue;
						result.push({
							newText: textEdit.newText,
							range: vueRange,
						});
					}
				}
			}
			return result;
		}
		function applyTextEdits(document: TextDocument, textEdits: TextEdit[]) {

			textEdits = textEdits.sort((a, b) => document.offsetAt(b.range.start) - document.offsetAt(a.range.start));

			let newDocumentText = document.getText();
			for (const textEdit of textEdits) {
				newDocumentText = editText(
					newDocumentText,
					document.offsetAt(textEdit.range.start),
					document.offsetAt(textEdit.range.end),
					textEdit.newText
				)
			}

			return TextDocument.create(document.uri.toString(), document.languageId, document.version + 1, newDocumentText);

			function editText(sourceText: string, startOffset: number, endOffset: number, newText: string) {
				return sourceText.substring(0, startOffset)
					+ newText
					+ sourceText.substring(endOffset, sourceText.length)
			}
		}
	};
}
