/**
 * `vi.mock` and `vi.hoisted` at build time. vitest hoists them above a test file's imports; here
 * they move to a module of their own (`__qf_mocks__<file>.js`, next to the test file so relative
 * specifiers still resolve) that the runtime evaluates before the test file. Importers of a mocked
 * module get a facade whose bindings the runtime points at the mock or the real module, per test
 * file (see runtime/mocks.ts).
 */

/** Marks an import that must reach the real module, never its mock (`vi.importActual`). */
export const ACTUAL = "?__qf_actual";

export interface MockSplit {
	/** The test file without the hoisted statements; line numbers are kept. */
	rest: string;
	/** The hoisted statements in order; each `vi.mock` specifier is replaced by `mockKey(i)`. */
	hoisted: string;
	/** The specifiers passed to `vi.mock`, by index. */
	specs: string[];
	/** Bindings that `vi.hoisted` declarations create, which the test file imports back. */
	names: string[];
}

export const mockKey = (i: number) => `__QF_MOCK_${i}__`;

// Statements that start a line; only those at the top level of the file count.
const HOISTED = /^[ \t]*(?:(const|let|var)\s+([^=]+?)\s*=\s*(?:await\s+)?)?vi\s*\.\s*(mock|hoisted)\s*\(/gm;

/** Splits a test file's hoisted statements from the rest; undefined when it has none. */
export function splitMocks(js: string): MockSplit | undefined {
	const code = blankStrings(js);
	const parts: string[] = [];
	const specs: string[] = [];
	const names: string[] = [];
	let rest = "";
	let last = 0;
	let depth = 0;
	let scanned = 0;
	for (const m of code.matchAll(HOISTED)) {
		if (m.index < last) continue;
		for (; scanned < m.index; scanned++) {
			const c = code[scanned];
			if (c === "{" || c === "(" || c === "[") depth++;
			else if (c === "}" || c === ")" || c === "]") depth--;
		}
		if (depth !== 0) continue;
		const open = m.index + m[0].length - 1;
		const close = matchingParen(code, open);
		if (close === undefined) continue;
		let end = close + 1;
		const semicolon = /^[ \t]*;/.exec(code.slice(end));
		if (semicolon) end += semicolon[0].length;
		let statement = js.slice(m.index, end);
		if (m[3] === "mock") {
			const spec = /^\s*(["'`])([^"'`$]*)\1/.exec(js.slice(open + 1, close));
			if (spec) {
				const at = open + 1 - m.index;
				statement = `${statement.slice(0, at)}${mockKey(specs.length)}${statement.slice(at + spec[0].length)}`;
				specs.push(spec[2]);
			}
		}
		if (m[2]) names.push(...bindingNames(m[2]));
		parts.push(statement);
		rest += js.slice(last, m.index) + js.slice(m.index, end).replace(/[^\n]/g, " ");
		last = end;
		scanned = end;
	}
	if (!parts.length) return undefined;
	return { rest: rest + js.slice(last), hoisted: parts.join("\n"), specs, names };
}

/** `vi.importActual("x")` → `import("x?__qf_actual")`, so the bundle links it to the real module. */
export function rewriteImportActual(js: string): string {
	return js.replace(/\bvi\s*\.\s*importActual\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g, (_, _q, spec: string) => `import(${JSON.stringify(spec + ACTUAL)})`);
}

/** The names a declaration pattern binds: `a`, `{ a, b: c, ...d }`, `[a, , b]`. */
export function bindingNames(pattern: string): string[] {
	const text = pattern.trim();
	if (/^[A-Za-z_$][\w$]*$/.test(text)) return [text];
	if (!/^[{[]/.test(text)) return [];
	const object = text.startsWith("{");
	const names: string[] = [];
	for (const part of splitTopLevel(text.slice(1, -1))) {
		const item = part.trim().replace(/^\.\.\./, "");
		if (!item) continue;
		const colon = object ? topLevel(item, ":") : -1;
		const target = item.slice(colon + 1);
		const equals = topLevel(target, "=");
		names.push(...bindingNames(equals === -1 ? target : target.slice(0, equals)));
	}
	return names;
}

function splitTopLevel(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if ("{[(".includes(c)) depth++;
		else if ("}])".includes(c)) depth--;
		else if (c === "," && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(text.slice(start));
	return parts;
}

function topLevel(text: string, char: string): number {
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if ("{[(".includes(c)) depth++;
		else if ("}])".includes(c)) depth--;
		else if (c === char && depth === 0) return i;
	}
	return -1;
}

/** The index of the `)` closing the `(` at `open`, in code whose strings and comments are blank. */
function matchingParen(code: string, open: number): number | undefined {
	let depth = 0;
	for (let i = open; i < code.length; i++) {
		const c = code[i];
		if (c === "(" || c === "{" || c === "[") depth++;
		else if (c === ")" || c === "}" || c === "]") {
			depth--;
			if (depth === 0) return c === ")" ? i : undefined;
		}
	}
	return undefined;
}

/**
 * The code with comments and the insides of strings blanked out, offsets kept. Template
 * literals keep their `${…}` expressions. Regular expression literals are not recognized.
 */
function blankStrings(js: string): string {
	let out = "";
	// Open template literals, innermost last: "text" inside one, or the brace depth of a `${…}`.
	const stack: ("text" | number)[] = [];
	const blank = (c: string) => (c === "\n" ? "\n" : " ");
	for (let i = 0; i < js.length; i++) {
		const c = js[i];
		const top = stack[stack.length - 1];
		if (top === "text") {
			if (c === "`") {
				out += c;
				stack.pop();
			} else if (c === "$" && js[i + 1] === "{") {
				out += "${";
				i++;
				stack.push(0);
			} else if (c === "\\") {
				out += blank(c) + blank(js[i + 1] ?? "");
				i++;
			} else out += blank(c);
			continue;
		}
		if (c === "`") {
			out += c;
			stack.push("text");
		} else if (c === "{" && typeof top === "number") {
			stack[stack.length - 1] = top + 1;
			out += c;
		} else if (c === "}" && typeof top === "number") {
			if (top === 0) stack.pop();
			else stack[stack.length - 1] = top - 1;
			out += c;
		} else if (c === "/" && js[i + 1] === "/") {
			const end = js.indexOf("\n", i);
			const stop = end === -1 ? js.length : end;
			out += " ".repeat(stop - i);
			i = stop - 1;
		} else if (c === "/" && js[i + 1] === "*") {
			const end = js.indexOf("*/", i + 2);
			const stop = end === -1 ? js.length : end + 2;
			out += js.slice(i, stop).replace(/[^\n]/g, " ");
			i = stop - 1;
		} else if (c === '"' || c === "'") {
			let j = i + 1;
			while (j < js.length && js[j] !== c && js[j] !== "\n") j += js[j] === "\\" ? 2 : 1;
			const closed = js[j] === c;
			out += c + " ".repeat(Math.min(j, js.length) - i - 1) + (closed ? c : "");
			i = closed ? j : j - 1;
		} else out += c;
	}
	return out;
}
