export const config = { runtime: "edge" };

// ==========================================
// SETTINGS — CHANGE THESE WHENEVER YOU WANT
// ==========================================

// Change this to whatever subpath your backend uses (e.g. "/web2", "/syndex", "")
const SUBPATH = "/5kjd";

// true = send visitor logs to Discord
// false = disable ALL visitor logging
const ENABLE_VISITOR_LOGGING = false;

// true = limit each IP to one log every 30 minutes
// false = log every eligible visit
const ENABLE_LOG_COOLDOWN = true;

const COOLDOWN_MS = 30 * 60 * 1000;

// Discord webhook URL from Vercel Environment Variables
const DISCORD_WEBHOOK_URL =
  process.env.DISCORD_WEBHOOK_URL || "";

// ==========================================
// INTERNAL SETTINGS
// ==========================================

const FAILURE_STATUSES = new Set([
  502, 503, 504, 520, 521, 522, 523, 524, 525, 526
]);

const STATIC_FILE_PATTERN =
  /\.(?:avif|bmp|css|csv|eot|gif|ico|jpe?g|js|json|map|m4a|mp3|mp4|ogg|otf|pdf|png|svg|ttf|txt|wav|webm|webp|woff2?|xml|zip)$/i;

// Best-effort in-memory cooldown.
// Entries may reset when Vercel restarts or uses another instance.
const visitorCooldowns = new Map();

// ==========================================
// VISITOR FILTER
// ==========================================

function shouldLogVisit(request, pathname) {
  if (request.method !== "GET") return false;

  const accept = request.headers.get("accept") || "";

  if (!accept.toLowerCase().includes("text/html")) {
    return false;
  }

  if (
    STATIC_FILE_PATTERN.test(pathname) ||
    pathname.startsWith("/api/") ||
    pathname === "/api" ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/uploads/") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    pathname === "/tunnel.json" ||
    pathname === "/server-offline.html"
  ) {
    return false;
  }

  return true;
}

// ==========================================
// VISITOR IP
// ==========================================

function getVisitorIP(request) {
  const realIP = request.headers.get("x-real-ip");

  if (realIP) {
    return realIP.slice(0, 100);
  }

  const forwardedFor =
    request.headers.get("x-forwarded-for");

  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim().slice(0, 100);
  }

  return "Unavailable";
}

// ==========================================
// DEVICE & BROWSER DETECTION
// Edit this function if you want to change detection.
// Browser detection is best-effort.
// ==========================================

function getDeviceBrowser(request) {
  const ua = request.headers.get("user-agent") || "";
  const hints = request.headers.get("sec-ch-ua") || "";
  const platformHint =
    request.headers.get("sec-ch-ua-platform") || "";

  const platform = platformHint.replace(/"/g, "");

  let device = "Unknown OS";
  let browser = "Unknown Browser";

  if (/Brave/i.test(hints) || /Brave/i.test(ua)) {
    browser = "Brave";
  } else if (
    /EdgA?\//i.test(ua) ||
    /EdgiOS\//i.test(ua) ||
    /Edg\//i.test(ua)
  ) {
    browser = "Edge";
  } else if (/OPR\//i.test(ua)) {
    browser = "Opera";
  } else if (
    /Firefox\//i.test(ua) ||
    /FxiOS\//i.test(ua)
  ) {
    browser = "Firefox";
  } else if (/CriOS\//i.test(ua)) {
    browser = "Chrome (iOS)";
  } else if (/Chrome\//i.test(ua)) {
    browser = "Chrome";
  } else if (/Safari\//i.test(ua)) {
    browser = "Safari";
  }

  if (/ChromeOS/i.test(platform) || /CrOS/i.test(ua)) {
    device = "ChromeOS";
  } else if (
    /Android/i.test(platform) ||
    /Android/i.test(ua)
  ) {
    device = "Android";
  } else if (/iPhone|iPad|iPod/i.test(ua)) {
    device = "iOS";
  } else if (
    /Windows/i.test(platform) ||
    /Windows/i.test(ua)
  ) {
    device = "Windows";
  } else if (
    /macOS/i.test(platform) ||
    /Macintosh|Mac OS X/i.test(ua)
  ) {
    device = "macOS";
  } else if (
    /Linux/i.test(platform) ||
    /Linux/i.test(ua)
  ) {
    device = "Linux";
  }

  return `${device} ·${browser}`;
}

// ==========================================
// TEXT LIMITER
// ==========================================

function truncate(value, maxLength) {
  return String(value || "Not provided").slice(0, maxLength);
}

// ==========================================
// DISCORD VISITOR LOGGER
// ==========================================

async function logVisit(request, pathname) {
  // Global logging switch
  if (!ENABLE_VISITOR_LOGGING) return;

  if (!DISCORD_WEBHOOK_URL) return;

  const ip = getVisitorIP(request);

  // Cooldown applies only when enabled.
  if (ENABLE_LOG_COOLDOWN) {
    const now = Date.now();
    const lastLogged = visitorCooldowns.get(ip);

    if (
      lastLogged !== undefined &&
      now - lastLogged < COOLDOWN_MS
    ) {
      return;
    }

    // Record this attempt to prevent repeated rapid requests.
    visitorCooldowns.set(ip, now);

    // Remove expired entries to limit memory growth.
    for (const [storedIP, timestamp] of visitorCooldowns) {
      if (now - timestamp >= COOLDOWN_MS) {
        visitorCooldowns.delete(storedIP);
      }
    }
  }

  const deviceBrowser = getDeviceBrowser(request);
  const referrer = request.headers.get("referer") || "Unavailable";

  const embed = {
    title: "🌐 New Visitor",
    description: "**All Information**",
    color: 0x0B1F3A,
    fields: [
      {
        name: "🌐 IP Address",
        value: `\`${truncate(ip, 100)}\``,
        inline: true
      },
      {
        name: "🔧 Method",
        value: `\`${truncate(request.method, 20)}\``,
        inline: true
      },
      {
        name: "📄 Requested Page",
        value: `\`${truncate(pathname, 1000)}\``,
        inline: false
      },
      {
        name: "💻 Device & Browser",
        value: truncate(deviceBrowser, 100),
        inline: false
      },
      {
        name: "🔗 Referrer",
        value: truncate(referrer, 1000),
        inline: false
      }
    ],
    timestamp: new Date().toISOString(),
    footer: {
      text: "Visitor Logger"
    }
  };

  try {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 1500);

    try {
      await fetch(DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          embeds: [embed],
          allowed_mentions: {
            parse: []
          }
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // Logging failures must not break the proxy.
  }
}

// ==========================================
// OFFLINE PAGE
// Loads your existing server-offline.html file.
// ==========================================

async function offlinePage(request) {
  try {
    const page = await fetch(
      new URL("/server-offline.html", request.url),
      { cache: "no-store" }
    );

    if (page.ok) {
      return new Response(await page.text(), {
        status: 503,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate"
        }
      });
    }
  } catch {
    // Use the text fallback below.
  }

  return new Response("Server Offline", {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate"
    }
  });
}

// ==========================================
// MAIN VERCEL PROXY
// ==========================================

export default async function handler(request) {
  try {
    const incomingUrl = new URL(request.url);

    // Logging switches do not affect proxy operation.
    if (
      ENABLE_VISITOR_LOGGING &&
      shouldLogVisit(request, incomingUrl.pathname)
    ) {
      await logVisit(request, incomingUrl.pathname);
    }

    const tunnelResponse = await fetch(
      new URL("/tunnel.json", request.url),
      { cache: "no-store" }
    );

    if (!tunnelResponse.ok) {
      return offlinePage(request);
    }

    const tunnelData = await tunnelResponse.json();

    const tunnelUrl = String(tunnelData.url || "")
      .replace(/\/+$/, "");

    if (!tunnelUrl) {
      return offlinePage(request);
    }

    // Clean up SUBPATH format (ensure it starts with / and has no trailing slash)
    const cleanSubpath = SUBPATH ? "/" + SUBPATH.replace(/^\/+|\/+$/g, "") : "";

    // Map Vercel's incoming path to include the configured SUBPATH for the backend
    let backendPath = incomingUrl.pathname;
    if (cleanSubpath) {
      if (backendPath === "/") {
        backendPath = cleanSubpath + "/";
      } else if (!backendPath.startsWith(cleanSubpath + "/") && backendPath !== cleanSubpath) {
        backendPath = cleanSubpath + backendPath;
      }
    }

    const targetUrl =
      tunnelUrl + backendPath + incomingUrl.search;

    const headers = new Headers(request.headers);

    headers.delete("host");
    headers.delete("content-length");

    headers.set("X-Forwarded-Host", incomingUrl.host);
    headers.set("X-Forwarded-Proto", "https");

    let response;

    try {
      response = await fetch(targetUrl, {
        method: request.method,
        headers,
        body:
          request.method === "GET" ||
          request.method === "HEAD"
            ? undefined
            : request.body,
        redirect: "manual"
      });
    } catch {
      return offlinePage(request);
    }

    if (
      FAILURE_STATUSES.has(response.status) ||
      (response.status >= 500 && response.status <= 599)
    ) {
      return offlinePage(request);
    }

    const responseHeaders = new Headers(response.headers);

    // Rewrite backend redirects back to clean Vercel root paths.
    const location = responseHeaders.get("location");

    if (location) {
      try {
        const redirectUrl = new URL(location);
        const tunnel = new URL(tunnelUrl);

        if (redirectUrl.host === tunnel.host) {
          redirectUrl.protocol = incomingUrl.protocol;
          redirectUrl.host = incomingUrl.host;

          // Strip SUBPATH so it maps cleanly back to Vercel's root
          if (cleanSubpath) {
            const subpathWithSlash = cleanSubpath + "/";
            if (redirectUrl.pathname.startsWith(subpathWithSlash)) {
              redirectUrl.pathname = redirectUrl.pathname.slice(cleanSubpath.length);
              if (redirectUrl.pathname === "") redirectUrl.pathname = "/";
            } else if (redirectUrl.pathname === cleanSubpath) {
              redirectUrl.pathname = "/";
            }
          }

          responseHeaders.set(
            "location",
            redirectUrl.toString()
          );
        }
      } catch {
        // Leave unparseable locations unchanged.
      }
    }

    // Rewrite tunnel cookie domains to the public host.
    const setCookie = responseHeaders.get("set-cookie");

    if (setCookie) {
      responseHeaders.delete("set-cookie");

      responseHeaders.append(
        "set-cookie",
        setCookie.replace(
          new RegExp(
            `Domain=${new URL(tunnelUrl).hostname}`,
            "gi"
          ),
          `Domain=${incomingUrl.hostname}`
        )
      );
    }

    responseHeaders.delete("content-length");
    responseHeaders.delete("transfer-encoding");
    responseHeaders.delete("connection");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });
  } catch {
    return offlinePage(request);
  }
}
