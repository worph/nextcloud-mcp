import { normalizeNextcloudUrl } from "./config.js";

export interface NextcloudTestResult {
  ok: boolean;
  serverVersion?: string;
  error?: string;
  status?: number;
}

export async function testNextcloudConnection(
  urlRaw: string,
  username: string,
  appPassword: string,
): Promise<NextcloudTestResult> {
  const url = normalizeNextcloudUrl(urlRaw);
  if (!url) return { ok: false, error: "Nextcloud URL is empty" };
  if (!username) return { ok: false, error: "Username is empty" };
  if (!appPassword) return { ok: false, error: "App password is empty" };

  const endpoint = `${url}/remote.php/dav/files/${encodeURIComponent(username)}/`;
  const basic = Buffer.from(`${username}:${appPassword}`).toString("base64");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);

  try {
    const res = await fetch(endpoint, {
      method: "PROPFIND",
      headers: {
        Authorization: `Basic ${basic}`,
        Depth: "0",
        Accept: "application/xml",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });

    // Nextcloud returns 207 Multi-Status on a successful PROPFIND.
    if (res.status === 207 || res.ok) {
      const serverVersion = res.headers.get("server") ?? undefined;
      return { ok: true, serverVersion };
    }

    const body = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      error: `${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
