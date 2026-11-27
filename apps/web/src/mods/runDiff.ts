/**
 * Run the diff in a Web Worker so the page stays responsive; on the page itself when a
 * worker cannot start (tests, an old browser, a worker that failed to load).
 */
import type { DiffPayload } from "./loader";
import type { DiffResult } from "./prepare";

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, { resolve: (r: DiffResult) => void; reject: (e: Error) => void; payload: DiffPayload }>();

async function inline(payload: DiffPayload): Promise<DiffResult> {
  const { runPayload } = await import("./prepare");
  return runPayload(payload);
}

function startWorker(): Worker | null {
  if (workerBroken || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./diff.worker.ts", import.meta.url), { type: "module" });
  } catch {
    workerBroken = true;
    return null;
  }
  worker.onmessage = (ev: MessageEvent<{ id: number; result?: DiffResult; error?: string }>) => {
    const job = pending.get(ev.data.id);
    if (!job) return;
    pending.delete(ev.data.id);
    if (ev.data.result) job.resolve(ev.data.result);
    else job.reject(new Error(ev.data.error ?? "diff failed"));
  };
  worker.onerror = (ev) => {
    // the worker itself broke (it did not load): finish its jobs here
    ev.preventDefault();
    workerBroken = true;
    worker?.terminate();
    worker = null;
    const jobs = [...pending.values()];
    pending.clear();
    for (const job of jobs) inline(job.payload).then(job.resolve, job.reject);
  };
  return worker;
}

export function runDiff(payload: DiffPayload): Promise<DiffResult> {
  const w = startWorker();
  if (!w) return inline(payload);
  const id = ++seq;
  return new Promise<DiffResult>((resolve, reject) => {
    pending.set(id, { resolve, reject, payload });
    // the bytes are copied, not transferred: the page keeps them for the next pair
    w.postMessage({ id, payload });
  });
}
