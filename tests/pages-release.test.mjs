/**
 * Protects the static GitHub Pages artifact contract.
 */

import assert from "node:assert/strict";
import { access, readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";

const releaseRoot = new URL("../pages-dist/", import.meta.url);

test("GitHub Pages output is self-contained and uses relative runtime assets", async () => {
  const html = await readFile(new URL("index.html", releaseRoot), "utf8");

  assert.match(html, /<title>NeuroTrace — Clinical EEG Studio<\/title>/i);
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/amaynes\.github\.io\/neurotrace-eeg-studio\/"/i,
  );
  assert.match(
    html,
    /(?:src|href)="\.\/assets\/[^"/]+-[A-Za-z0-9_-]{8,}\.(?:js|css)"/i,
  );
  assert.doesNotMatch(html, /(?:src|href)="\/(?:_next|assets)\//i);
  assert.doesNotMatch(html, /__next_f|react-server-dom|\/api\//i);

  const localReferences = [...html.matchAll(/(?:src|href)="([^"]+)"/gi)]
    .map((match) => match[1])
    .filter((reference) => !/^(?:https?:|data:|#)/i.test(reference));

  assert.ok(localReferences.length >= 2, "the release links its JavaScript and CSS assets");
  for (const reference of localReferences) {
    assert.match(reference, /^\.\//, `${reference} must remain relative for a project Pages path`);
    await access(new URL(reference.slice(2), releaseRoot));
  }

  await access(new URL("og.png", releaseRoot));
  await assert.rejects(access(new URL("server/", releaseRoot)));

  const assetNames = await readdir(new URL("assets/", releaseRoot));
  const scripts = assetNames.filter((name) => /\.js$/i.test(name));
  assert.ok(scripts.length > 0, "the release contains a hashed JavaScript bundle");
  assert.ok(
    assetNames.some((name) => /\.css$/i.test(name)),
    "the release contains a hashed stylesheet",
  );

  const javascript = (
    await Promise.all(
      scripts.map((name) => readFile(new URL(`assets/${name}`, releaseRoot), "utf8")),
    )
  ).join("\n");
  assert.doesNotMatch(javascript, /next\/headers|react-server-dom|dist\/server|\/_next\//i);
});

test("macOS launcher hosts the static viewer on a chosen loopback port", async () => {
  const launcherUrl = new URL("../Launch NeuroTrace.command", import.meta.url);
  const [launcher, launcherStats, packageSource] = await Promise.all([
    readFile(launcherUrl, "utf8"),
    stat(launcherUrl),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.notEqual(launcherStats.mode & 0o111, 0, "the Finder launcher is executable");
  assert.match(launcher, /^#!\/bin\/zsh/);
  assert.match(launcher, /display dialog[\s\S]*default answer defaultPort[\s\S]*buttons \{"Cancel", "Start"\}/);
  assert.match(launcher, /numeric_port < 1024 \|\| numeric_port > 65535/);
  assert.match(launcher, /lsof -nP -iTCP:"\$PORT" -sTCP:LISTEN/);
  assert.match(launcher, /npm ci/);
  assert.match(launcher, /npm run build:pages/);
  assert.match(launcher, /LOCAL_URL="http:\/\/127\.0\.0\.1:\$PORT\/"/);
  assert.match(launcher, /\/usr\/bin\/open "\$LOCAL_URL"/);
  assert.match(launcher, /npm run preview:local -- --port "\$PORT"/);
  assert.equal(
    packageJson.scripts["preview:local"],
    "vite preview --config vite.pages.config.ts --host 127.0.0.1 --strictPort",
  );
});
