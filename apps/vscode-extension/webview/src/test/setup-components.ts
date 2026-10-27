import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Component tests (`*.test.tsx`) run in jsdom. Testing Library unmounts after each test only
// when the runner exposes globals; Vitest's are off, so do it here.
afterEach(cleanup);

// jsdom has no matchMedia; the ThemeEngine and reduced-motion checks read it.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// jsdom has <dialog> but not showModal/close; the real behaviour is covered by Playwright.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}
