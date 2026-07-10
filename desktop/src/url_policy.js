const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function parseUrl(value) {
  try {
    return new URL(String(value || "").trim());
  } catch {
    return null;
  }
}

function isLocalHost(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return LOCAL_HOSTS.has(normalized);
}

function sanitizeUrl(value, fallback, options) {
  const url = parseUrl(value) || parseUrl(fallback);
  const fallbackUrl = parseUrl(fallback);
  if (!url || !fallbackUrl) {
    return String(fallback || "");
  }

  const protocolAllowed = options.protocols.includes(url.protocol);
  const hostAllowed = options.allowRemote || isLocalHost(url.hostname);
  if (!protocolAllowed || !hostAllowed) {
    return fallbackUrl.toString();
  }

  return url.toString();
}

function sanitizeHttpServiceUrl(value, fallback, allowRemote) {
  return sanitizeUrl(value, fallback, {
    protocols: ["http:", "https:"],
    allowRemote,
  });
}

module.exports = {
  isLocalHost,
  sanitizeHttpServiceUrl,
};
