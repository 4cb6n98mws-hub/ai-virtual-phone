/** Personal deployment access gate. Credentials belong in hosting environment settings. */
export function personalAccessGate(
  request: Request,
  env: Record<string, string | undefined>,
): Response | null {
  const enabled = env.VERCEL === "1" || env.PERSONAL_ACCESS_ENABLED === "true";
  if (!enabled) return null;

  const username = env.PERSONAL_ACCESS_USERNAME;
  const password = env.PERSONAL_ACCESS_PASSWORD;
  const headers = { "Cache-Control": "no-store" };
  if (!username || !password) {
    return new Response("请先在托管平台配置访问账号和密码。", { status: 503, headers });
  }

  const authorization = request.headers.get("authorization") || "";
  const match = /^Basic\s+(\S+)$/i.exec(authorization);
  if (match) {
    try {
      const bytes = Uint8Array.from(atob(match[1]), c => c.charCodeAt(0));
      const credentials = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const expected = `${username}:${password}`;
      // Compare every character without an early return on a mismatch.
      let difference = credentials.length ^ expected.length;
      for (let i = 0; i < Math.max(credentials.length, expected.length); i++) {
        difference |= (credentials.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
      }
      if (difference === 0) return null;
    } catch {
      // Malformed credentials receive the same challenge as missing ones.
    }
  }
  return new Response("请输入你自己的小手机访问账号和密码。", {
    status: 401,
    headers: { ...headers, "WWW-Authenticate": 'Basic realm="Personal AI Phone", charset="UTF-8"' },
  });
}
