const trustedWebContentsIds = new Set();

function secureWebPreferences(options = {}) {
  return {
    ...options,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
  };
}

function registerTrustedWindow(window) {
  if (window && !window.isDestroyed()) {
    trustedWebContentsIds.add(window.webContents.id);
    window.on("closed", () => {
      trustedWebContentsIds.delete(window.webContents.id);
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => {
      event.preventDefault();
    });
  }
}

function isTrustedFileSender(event) {
  return trustedWebContentsIds.has(event?.sender?.id);
}

function assertTrustedFileSender(event) {
  if (!isTrustedFileSender(event)) {
    throw new Error("Untrusted renderer IPC sender");
  }
}

function installPermissionPolicy(session, getMediaWindows) {
  session.setPermissionRequestHandler((webContents, permission, callback) => {
    const windows = getMediaWindows();
    callback(permission === "media" && windows.some((window) => window?.webContents === webContents));
  });
}

module.exports = {
  assertTrustedFileSender,
  installPermissionPolicy,
  isTrustedFileSender,
  registerTrustedWindow,
  secureWebPreferences,
};
