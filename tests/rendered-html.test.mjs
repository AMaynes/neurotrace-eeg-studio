import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("https://neurotrace.test/", { headers: { accept: "text/html", host: "neurotrace.test" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders the NeuroTrace clinical EEG workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>NeuroTrace — Clinical EEG Studio<\/title>/i);
  assert.match(html, /NEUROTRACE/);
  assert.match(html, /Clinical EEG Studio/);
  assert.match(html, /Context palette/);
  assert.match(html, /Entire-session context/);
  assert.match(html, /Window context/);
  assert.match(html, /Label palette/);
  assert.match(html, /GPDs/);
  assert.match(html, /LPDs/);
  assert.match(html, /BIPDs/);
  assert.match(html, /GRDA/);
  assert.match(html, /LRDA/);
  assert.match(html, /N1 sleep/);
  assert.match(html, /N2 sleep/);
  assert.match(html, /N3 sleep/);
  assert.match(html, /REM sleep/);
  assert.match(html, /Windowed Labels/);
  assert.match(html, /Instance Labels/);
  assert.match(html, /Controls/);
  assert.match(html, /og\.png/);
  assert.doesNotMatch(html, /Mark seizure|PHI stays here|Source \/ reliability|IIIC pattern|Ictal seizure|NREM sleep/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("ships product source without starter preview artifacts", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(page, /EDFSource/);
  assert.match(page, /MatSource/);
  assert.match(page, /createStoredZip/);
  assert.match(page, /aria-label="Delete annotation"/);
  assert.match(page, /aria-label="Close controls"/);
  assert.match(page, /data-track-id=/);
  assert.match(page, /context-resize-handle/);
  assert.match(page, /wave-cursor pinned/);
  assert.match(page, /Converted to a windowed duration label/);
  assert.match(page, /Context palette/);
  assert.match(page, /Entire-session context/);
  assert.match(page, /Window context/);
  assert.match(page, /candidate_events\.tsv/);
  assert.match(page, /source_content_sha256/);
  assert.match(page, /entire_session_context/);
  assert.match(page, /timed_context/);
  assert.match(page, /sha256Blob/);
  assert.match(page, /status === "committed"/);
  assert.doesNotMatch(page, /fileFingerprint/);
  assert.doesNotMatch(page, /> Cursor<\/button>|> Select<\/button>|Manage ontology/);
  assert.doesNotMatch(page, /Source \/ reliability|Candidate queue|Event labels/);
  assert.match(layout, /NeuroTrace — Clinical EEG Studio/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await access(new URL("../public/og.png", import.meta.url));
  await access(new URL(".openai/hosting.json", root));
});
