/**
 * The diff of two mods, off the page's thread: a full pair takes one to two seconds.
 * In: { id, payload: DiffPayload }. Out: { id, result: DiffResult } or { id, error }.
 */
import type { DiffPayload } from "./loader";
import { runPayload } from "./prepare";

interface Scope {
  postMessage(message: unknown): void;
  onmessage: ((ev: MessageEvent<{ id: number; payload: DiffPayload }>) => void) | null;
}

const scope = self as unknown as Scope;

scope.onmessage = (ev) => {
  const { id, payload } = ev.data;
  try {
    scope.postMessage({ id, result: runPayload(payload) });
  } catch (e) {
    scope.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
