/** Personal deployment access gate. Credentials stay in hosting environment settings. */
const COOKIE = "__Host-personal-phone-access";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_PATH = "/personal-access-login";

function equal(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return difference === 0;
}

async function signature(payload: string, username: string, password: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(["personal-phone-access-v1", username, payload])));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function loginPage(error = "", status = 200): Response {
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>小手机登录</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#f4f5f8;color:#222;font-family:system-ui,sans-serif;padding:24px}main{width:100%;max-width:380px;background:white;border-radius:24px;padding:28px;box-shadow:0 12px 50px #0001}h1{font-size:24px;margin-top:0}p{line-height:1.6;color:#555}label{display:block;margin-top:18px}input,button{width:100%;font:inherit;border-radius:12px;padding:14px;margin-top:8px}input{border:1px solid #ccc}button{border:0;background:#263858;color:white;margin-top:24px;cursor:pointer}.error{color:#b42318}
</style></head><body><main><h1>打开你的小手机</h1><p>填写部署时设置的访问账号和密码。</p><p class="error" role="alert">${error}</p><form method="post" action="${LOGIN_PATH}"><label>访问账号<input name="username" autocomplete="username" required maxlength="256" autocapitalize="none" spellcheck="false"></label><label>访问密码<input name="password" type="password" autocomplete="current-password" required maxlength="4096"></label><button type="submit">登录</button></form><p>登录后在本应用中保持登录 30 天。</p></main></body></html>`, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function personalAccessGate(request: Request, env: Record<string, string | undefined>): Promise<Response | null> {
  const enabled = env.NODE_ENV === "production" || env.VERCEL === "1" || env.NETLIFY === "true" || env.PERSONAL_ACCESS_ENABLED === "true";
  if (!enabled) return null;
  const username = env.PERSONAL_ACCESS_USERNAME;
  const password = env.PERSONAL_ACCESS_PASSWORD;
  const headers = { "Cache-Control": "no-store" };
  if (!username || !password) return new Response("请先在托管平台配置访问账号和密码。", { status: 503, headers });
  const url = new URL(request.url);

  if (url.pathname === LOGIN_PATH && request.method === "POST") {
    // Next may use an internal hostname in request.url behind the hosting proxy.
    const protocol = request.headers.get("x-forwarded-proto")?.split(",")[0].trim() || url.protocol.slice(0, -1);
    const publicOrigin = `${protocol}://${request.headers.get("host") || url.host}`;
    if (request.headers.get("origin") !== publicOrigin) return loginPage("请在小手机登录页重新提交。", 403);
    if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return loginPage("登录格式无效。", 400);
    const body = await request.text();
    if (body.length > 32768) return loginPage("登录内容过长。", 413);
    const form = new URLSearchParams(body);
    if (!equal(form.get("username") || "", username) || !equal(form.get("password") || "", password)) return loginPage("账号或密码不正确，请重新填写。", 401);
    const expires = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
    const token = `${expires}.${await signature(expires, username, password)}`;
    return new Response(null, { status: 303, headers: {
      ...headers,
      Location: new URL("/", publicOrigin).href,
      "Set-Cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`,
    } });
  }

  const token = (request.headers.get("cookie") || "").split(";").map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || "";
  const matchToken = /^(\d{10})\.([a-f0-9]{64})$/.exec(token);
  const now = Math.floor(Date.now() / 1000);
  if (matchToken && Number(matchToken[1]) > now && Number(matchToken[1]) <= now + SESSION_SECONDS && equal(matchToken[2], await signature(matchToken[1], username, password))) return null;

  // Keep existing Safari Basic sessions working while PWA uses its own form login.
  const matchBasic = /^Basic\s+(\S+)$/i.exec(request.headers.get("authorization") || "");
  if (matchBasic) {
    try {
      const bytes = Uint8Array.from(atob(matchBasic[1]), c => c.charCodeAt(0));
      const credentials = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (equal(credentials, `${username}:${password}`)) return null;
    } catch { /* Invalid credentials follow the normal login flow. */ }
  }

  if (request.method === "GET" && (request.headers.get("accept")?.includes("text/html") || url.pathname === "/" || url.pathname === LOGIN_PATH)) return loginPage();
  return new Response("请先打开小手机并登录。", { status: 401, headers });
}
