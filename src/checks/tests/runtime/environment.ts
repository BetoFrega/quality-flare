/**
 * vitest's `jsdom` environment, per test file: a fresh JSDOM whose window's DOM globals are
 * installed on globalThis while the file is collected and while its tests run, and removed for
 * files in the `node` environment. Mirrors vitest's populateGlobal (bindFunctions on).
 */

// vitest's KEYS (LIVING_KEYS + OTHER_KEYS): the window members that replace globals of the same name.
const KEYS = new Set(
	`DOMException EventTarget NamedNodeMap Node Attr Element DocumentFragment DOMImplementation Document XMLDocument CharacterData Text CDATASection ProcessingInstruction Comment DocumentType NodeList RadioNodeList HTMLCollection HTMLOptionsCollection DOMStringMap DOMTokenList StyleSheetList HTMLElement HTMLHeadElement HTMLTitleElement HTMLBaseElement HTMLLinkElement HTMLMetaElement HTMLStyleElement HTMLBodyElement HTMLHeadingElement HTMLParagraphElement HTMLHRElement HTMLPreElement HTMLUListElement HTMLOListElement HTMLLIElement HTMLMenuElement HTMLDListElement HTMLDivElement HTMLAnchorElement HTMLAreaElement HTMLBRElement HTMLButtonElement HTMLCanvasElement HTMLDataElement HTMLDataListElement HTMLDetailsElement HTMLDialogElement HTMLDirectoryElement HTMLFieldSetElement HTMLFontElement HTMLFormElement HTMLHtmlElement HTMLImageElement HTMLInputElement HTMLLabelElement HTMLLegendElement HTMLMapElement HTMLMarqueeElement HTMLMediaElement HTMLMeterElement HTMLModElement HTMLOptGroupElement HTMLOptionElement HTMLOutputElement HTMLPictureElement HTMLProgressElement HTMLQuoteElement HTMLScriptElement HTMLSelectElement HTMLSlotElement HTMLSourceElement HTMLSpanElement HTMLTableCaptionElement HTMLTableCellElement HTMLTableColElement HTMLTableElement HTMLTimeElement HTMLTableRowElement HTMLTableSectionElement HTMLTemplateElement HTMLTextAreaElement HTMLUnknownElement HTMLFrameElement HTMLFrameSetElement HTMLIFrameElement HTMLEmbedElement HTMLObjectElement HTMLParamElement HTMLVideoElement HTMLAudioElement HTMLTrackElement HTMLFormControlsCollection SVGElement SVGGraphicsElement SVGSVGElement SVGTitleElement SVGAnimatedString SVGNumber SVGStringList Event CloseEvent CustomEvent MessageEvent ErrorEvent HashChangeEvent PopStateEvent StorageEvent ProgressEvent PageTransitionEvent SubmitEvent UIEvent FocusEvent InputEvent MouseEvent KeyboardEvent TouchEvent CompositionEvent WheelEvent BarProp External Location History Screen Crypto Performance Navigator PluginArray MimeTypeArray Plugin MimeType FileReader FormData Blob File FileList ValidityState DOMParser XMLSerializer XMLHttpRequestEventTarget XMLHttpRequestUpload XMLHttpRequest WebSocket NodeFilter NodeIterator TreeWalker AbstractRange Range StaticRange Selection Storage CustomElementRegistry ShadowRoot MutationObserver MutationRecord Uint8Array Uint16Array Uint32Array Uint8ClampedArray Int8Array Int16Array Int32Array Float32Array Float64Array ArrayBuffer DOMRectReadOnly DOMRect Image Audio Option CSS addEventListener alert blur cancelAnimationFrame close confirm createPopup dispatchEvent document focus frames getComputedStyle history innerHeight innerWidth length localStorage location matchMedia moveBy moveTo name navigator open outerHeight outerWidth pageXOffset pageYOffset parent postMessage print prompt removeEventListener requestAnimationFrame resizeBy resizeTo screen screenLeft screenTop screenX screenY scroll scrollBy scrollLeft scrollTo scrollTop scrollX scrollY self sessionStorage stop top Window window`.split(
		" ",
	),
);
const SELF_KEYS = ["window", "self", "top", "parent"];

/** Written by the bundle for each environment package; a variable, so the runtime's bundler leaves it alone. */
const environmentModule = (name: string): string => `/__qf/env/${name}.js`;

type Window = Record<string, unknown> & { close?(): void };
const windows = new Map<string, Window>();
let installed: { keys: string[]; originals: Map<string, PropertyDescriptor> } | undefined;
const scope = globalThis as unknown as Record<string, unknown>;

/** Creates the file's environment and installs it; `node` (or none) leaves globalThis alone. */
export async function setUpEnvironment(file: string, environment: string | undefined): Promise<void> {
	uninstall();
	if (!environment || environment === "node") return;
	const window = await createWindow(environment);
	windows.set(file, window);
	install(window);
}

/** Installs the environment `file` was collected in, before its tests run. */
export function activateEnvironment(file: string): void {
	uninstall();
	const window = windows.get(file);
	if (window) install(window);
}

async function createWindow(environment: string): Promise<Window> {
	if (environment !== "jsdom" && environment !== "happy-dom") {
		throw new Error(`O ambiente de teste "${environment}" não é suportado no quality-flare (use node, jsdom ou happy-dom).`);
	}
	const ns = (await import(environmentModule(environment))) as { default: Record<string, any> };
	const pkg = ns.default;
	if (environment === "jsdom") {
		const JSDOM = pkg.JSDOM ?? pkg.default?.JSDOM;
		return new JSDOM("<!DOCTYPE html>", { pretendToBeVisual: true, url: "http://localhost:3000" }).window;
	}
	const Window = pkg.Window ?? pkg.default?.Window;
	return new Window({ url: "http://localhost:3000" });
}

function install(window: Window) {
	const originals = new Map<string, PropertyDescriptor>();
	const keys = [...new Set([...KEYS, ...Object.getOwnPropertyNames(window)])].filter(
		(key) => !SELF_KEYS.includes(key) && (!(key in scope) || KEYS.has(key)),
	);
	for (const key of [...keys, ...SELF_KEYS]) {
		const original = Object.getOwnPropertyDescriptor(scope, key);
		if (original) originals.set(key, original);
	}
	const overrides = new Map<string, unknown>();
	for (const key of keys) {
		const value = window[key];
		const bound = typeof value === "function" && key[0] !== key[0].toUpperCase() ? (value as (...a: unknown[]) => unknown).bind(window) : undefined;
		Object.defineProperty(scope, key, {
			get: () => (overrides.has(key) ? overrides.get(key) : (bound ?? window[key])),
			set: (v) => {
				overrides.set(key, v);
				window[key] = v;
			},
			configurable: true,
		});
	}
	for (const key of SELF_KEYS) Object.defineProperty(scope, key, { value: scope, configurable: true, writable: true });
	const document = window.document as { defaultView?: unknown } | undefined;
	if (document?.defaultView) Object.defineProperty(document, "defaultView", { get: () => scope, configurable: true });
	installed = { keys: [...keys, ...SELF_KEYS], originals };
}

function uninstall() {
	if (!installed) return;
	for (const key of installed.keys) {
		const original = installed.originals.get(key);
		if (original) Object.defineProperty(scope, key, original);
		else delete scope[key];
	}
	installed = undefined;
}
