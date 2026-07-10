"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { installPermissionPolicy, secureWebPreferences } = require("../src/window_security");

test("secure web preferences cannot be weakened by callers", () => {
  assert.deepEqual(secureWebPreferences({ nodeIntegration: true, sandbox: false, preload: "preload.js" }), {
    nodeIntegration: false,
    sandbox: true,
    preload: "preload.js",
    contextIsolation: true,
  });
});

test("permission policy grants only audio media to trusted file windows", () => {
  let checkHandler;
  let requestHandler;
  const session = {
    setPermissionCheckHandler(handler) { checkHandler = handler; },
    setPermissionRequestHandler(handler) { requestHandler = handler; },
  };
  const webContents = { getURL: () => "file:///app/recorder.html" };
  const window = { isDestroyed: () => false, webContents };
  installPermissionPolicy(session, () => [window]);

  assert.equal(checkHandler(webContents, "media", "file://", { mediaType: "audio" }), true);
  assert.equal(checkHandler(webContents, "media", "file://", { mediaType: "video" }), false);
  assert.equal(checkHandler(webContents, "geolocation", "file://", {}), false);
  assert.equal(checkHandler(webContents, "media", "https://example.com", { mediaType: "audio" }), false);

  const request = (contents, permission, details) => {
    let result;
    requestHandler(contents, permission, (granted) => { result = granted; }, details);
    return result;
  };
  assert.equal(request(webContents, "media", { requestingUrl: webContents.getURL(), mediaTypes: ["audio"] }), true);
  assert.equal(request(webContents, "media", { requestingUrl: webContents.getURL(), mediaTypes: ["video"] }), false);
  assert.equal(request(webContents, "media", { requestingUrl: webContents.getURL(), mediaTypes: [] }), false);
  assert.equal(request({ getURL: webContents.getURL }, "media", { requestingUrl: webContents.getURL(), mediaTypes: ["audio"] }), false);
});
