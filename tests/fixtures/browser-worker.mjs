/** Execute browser module-worker entry points in real Node worker threads. */
import { Worker as NodeWorker, isMainThread, parentPort, workerData } from "node:worker_threads";

export class BrowserWorker {
  constructor(url) {
    this.thread = new NodeWorker(new URL(import.meta.url), { workerData: { entry: String(url) } });
    this.thread.on("message", (data) => this.onmessage?.({ data }));
    this.thread.on("error", (error) => this.onerror?.({ message: error.message, preventDefault() {} }));
  }
  postMessage(message, transfer = []) { this.thread.postMessage(message, transfer); }
  terminate() { this.stopped = true; void this.thread.terminate(); }
}

if (!isMainThread) {
  globalThis.self = globalThis;
  globalThis.Worker = BrowserWorker;
  globalThis.postMessage = (message, transfer = []) => parentPort.postMessage(message, transfer);
  const queued = [];
  let loaded = false;
  parentPort.on("message", (data) => {
    if (loaded) globalThis.onmessage?.({ data });
    else queued.push(data);
  });
  await import(workerData.entry);
  loaded = true;
  for (const data of queued) globalThis.onmessage?.({ data });
}
