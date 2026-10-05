/** One read-only event-metadata request at a time; the client owns cancellation by termination. */
import { readDirectoryEventIndex, type DirectoryEventRequest, type DirectoryEventIndex } from "./directory-event-index.ts";

export type DirectoryEventResponse = { id: string; result: DirectoryEventIndex };
self.onmessage = async (event: MessageEvent<{ id: string; request: DirectoryEventRequest }>) => {
  const { id, request } = event.data;
  try {
    self.postMessage({ id, result: await readDirectoryEventIndex(request) } satisfies DirectoryEventResponse);
  } catch (error) {
    self.postMessage({ id, result: { state: "error", labels: [], warnings: [error instanceof Error ? error.message : "Could not check event labels."] } } satisfies DirectoryEventResponse);
  }
};
