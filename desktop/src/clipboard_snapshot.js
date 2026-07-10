"use strict";

function captureClipboard(clipboard) {
  const formats = clipboard.availableFormats();
  const data = {};
  const text = clipboard.readText();
  const html = clipboard.readHTML();
  const rtf = clipboard.readRTF();
  const image = clipboard.readImage();
  const bookmark = clipboard.readBookmark();

  if (text) data.text = text;
  if (html) data.html = html;
  if (rtf) data.rtf = rtf;
  if (image && !image.isEmpty()) data.image = image;
  if (bookmark?.url) {
    data.text ||= bookmark.url;
    data.bookmark = bookmark.title || "";
  }

  return {
    data: Object.keys(data).length ? data : null,
    wasEmpty: formats.length === 0,
  };
}

function restoreClipboard(clipboard, snapshot) {
  if (snapshot?.data) {
    clipboard.write(snapshot.data);
    return true;
  }
  if (snapshot?.wasEmpty) {
    clipboard.clear();
    return true;
  }
  // Unknown/custom-only formats cannot be reconstructed through Electron's
  // structured clipboard API. Leave the transcript in place instead of
  // replacing it with an empty clipboard.
  return false;
}

module.exports = { captureClipboard, restoreClipboard };
