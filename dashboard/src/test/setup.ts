import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom does no layout: report a desktop-sized box so width-dependent charts render.
class FixedResizeObserver implements ResizeObserver {
	private readonly callback: ResizeObserverCallback;
	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
	}
	observe(target: Element) {
		this.callback([{ target, contentRect: { width: 960, height: 300 } } as unknown as ResizeObserverEntry], this);
	}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver = FixedResizeObserver;
Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 960 });

afterEach(() => {
	cleanup();
	window.history.replaceState({}, "", "/");
});
