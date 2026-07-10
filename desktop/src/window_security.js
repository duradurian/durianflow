const trustedWebContentsIds = new Set();

function secureWebPreferences(options = {}) {
  return {
    ...options,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
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

function hasFileProtocol(value) {
  try {
    return new URL(String(value || "")).protocol === "file:";
  } catch {
    return false;
  }
}

function isMediaWindow(webContents, getMediaWindows) {
  return Boolean(webContents) && getMediaWindows().some((window) => (
    window
    && !window.isDestroyed()
    && window.webContents === webContents
    && hasFileProtocol(webContents.getURL())
  ));
}

function installPermissionPolicy(session, getMediaWindows) {
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details = {}) => {
    return permission === "media"
      && details.mediaType === "audio"
      && hasFileProtocol(requestingOrigin || details.securityOrigin || details.requestingUrl)
      && isMediaWindow(webContents, getMediaWindows);
  });
  session.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    const requestingUrl = details.requestingUrl || details.securityOrigin || webContents?.getURL();
    callback(
      permission === "media"
      && mediaTypes.length > 0
      && mediaTypes.every((mediaType) => mediaType === "audio")
      && hasFileProtocol(requestingUrl)
      && isMediaWindow(webContents, getMediaWindows),
    );
  });
}

module.exports = {
  assertTrustedFileSender,
  hasFileProtocol,
  installPermissionPolicy,
  isTrustedFileSender,
  registerTrustedWindow,
  secureWebPreferences,
};
