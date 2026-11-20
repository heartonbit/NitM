import { LLM_TUNING_FIELDS, llmBaseUrlIsValid, llmSecretsConfigured, llmTuningSettings, runDigest, scheduledDigest, sendTestDigest, validateExternalUrl, validateLlmTuningInput } from "./digest.js";
import { sendEmail } from "./mailer.js";

const SESSION_COOKIE = "nitm_session";
const OAUTH_COOKIE = "nitm_oauth_state";
const SESSION_DAYS = 30;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function isoNow() {
  return new Date().toISOString();
}

function validEmail(value) {
  return typeof value === "string" && value.length <= 254 && /^[^@\s,;<>"']+@[^@\s,;<>"']+\.[^@\s,;<>"']+$/.test(value);
}

function assertSameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(request.url).origin) throw new HttpError(403, "origin_rejected");
}

async function bodyJson(request) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > 32_000) throw new HttpError(413, "request_too_large");
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid_body");
    return body;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

function cookie(request, name) {
  const prefix = `${name}=`;
  const item = (request.headers.get("Cookie") || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : "";
}

function redirect(url, cookies = []) {
  const headers = new Headers({ Location: url, "Cache-Control": "no-store" });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status: 302, headers });
}

function setCookie(request, name, value, maxAge) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearCookie(request, name) {
  return setCookie(request, name, "", 0);
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hash(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function googleRedirectUri(request) {
  return `${new URL(request.url).origin}/auth/callback`;
}

async function authStart(request, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new HttpError(503, "google_login_not_configured");
  const state = randomToken();
  await env.DB.prepare("INSERT INTO oauth_states (state, expires_at) VALUES (?, ?)")
    .bind(state, new Date(Date.now() + 10 * 60_000).toISOString()).run();
  const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  target.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(request),
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  }).toString();
  return redirect(target.toString(), [setCookie(request, OAUTH_COOKIE, state, 600)]);
}

async function authCallback(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const cookieState = cookie(request, OAUTH_COOKIE);
  const stateRow = state && state === cookieState
    ? await env.DB.prepare("SELECT state FROM oauth_states WHERE state=? AND expires_at>?").bind(state, isoNow()).first()
    : null;
  if (!stateRow || !code) return redirect("/?auth=failed", [clearCookie(request, OAUTH_COOKIE)]);
  await env.DB.prepare("DELETE FROM oauth_states WHERE state=?").bind(state).run();

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: googleRedirectUri(request),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResponse.ok) return redirect("/?auth=failed", [clearCookie(request, OAUTH_COOKIE)]);
  const token = await tokenResponse.json();
  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!profileResponse.ok) return redirect("/?auth=failed", [clearCookie(request, OAUTH_COOKIE)]);
  const profile = await profileResponse.json();
  const email = String(profile.email || "").trim().toLowerCase();
  if (!profile.sub || !validEmail(email) || profile.email_verified !== true) {
    return redirect("/?auth=failed", [clearCookie(request, OAUTH_COOKIE)]);
  }

  const bootstrapEmail = String(env.BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();
  if (bootstrapEmail && email === bootstrapEmail) {
    await env.DB.prepare("INSERT OR IGNORE INTO admins (email, created_at) VALUES (?, ?)").bind(email, isoNow()).run();
  }
  const [existing, invitation, admin] = await Promise.all([
    env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first(),
    env.DB.prepare("SELECT email FROM invites WHERE email=?").bind(email).first(),
    env.DB.prepare("SELECT email FROM admins WHERE email=?").bind(email).first(),
  ]);
  if (!existing && !invitation && !admin) return redirect("/?auth=not-invited", [clearCookie(request, OAUTH_COOKIE)]);

  const userId = existing?.id || String(profile.sub);
  await env.DB.prepare(`INSERT INTO users (id, email, name, subscribed, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(email) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at`)
    .bind(userId, email, String(profile.name || "").slice(0, 120), isoNow(), isoNow()).run();

  const session = randomToken();
  const sessionHash = await hash(session);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60_000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(sessionHash, userId, expiresAt, isoNow()).run();
  return redirect("/", [clearCookie(request, OAUTH_COOKIE), setCookie(request, SESSION_COOKIE, session, SESSION_DAYS * 24 * 60 * 60)]);
}

async function currentUser(request, env) {
  const token = cookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await hash(token);
  const row = await env.DB.prepare(`SELECT u.id, u.email, u.name, u.subscribed,
      EXISTS (SELECT 1 FROM admins a WHERE a.email=u.email) AS is_admin
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?`).bind(tokenHash, isoNow()).first();
  if (!row) return null;
  return { ...row, subscribed: Boolean(row.subscribed), isAdmin: Boolean(row.is_admin) };
}

function requireUser(user) {
  if (!user) throw new HttpError(401, "authentication_required");
  return user;
}

function requireAdmin(user) {
  if (!user?.isAdmin) throw new HttpError(user ? 403 : 401, user ? "administrator_required" : "authentication_required");
  return user;
}

async function audit(env, actor, action, target) {
  await env.DB.prepare("INSERT INTO audit_logs (actor_email, action, target, created_at) VALUES (?, ?, ?, ?)")
    .bind(actor.email, action, String(target).slice(0, 200), isoNow()).run();
}

async function logout(request, env) {
  const token = cookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await hash(token)).run();
  return json({ ok: true }, 200, { "set-cookie": clearCookie(request, SESSION_COOKIE) });
}

function sourceInput(body, existing = {}) {
  const id = String(body.id ?? existing.id ?? "").trim();
  const name = String(body.name ?? existing.name ?? "").trim();
  const url = String(body.url ?? existing.url ?? "").trim();
  const order = Number(body.order ?? existing.sort_order ?? 0);
  const enabled = body.enabled === undefined ? Boolean(existing.enabled ?? true) : body.enabled === true;
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id) || !name || name.length > 80 || !Number.isInteger(order) || order < 0 || order > 10_000) {
    throw new HttpError(400, "invalid_source");
  }
  try {
    validateExternalUrl(url);
  } catch {
    throw new HttpError(400, "invalid_source_url");
  }
  return { id, name, url, enabled, order };
}

function configInput(body) {
  const timezone = String(body.timezone ?? "UTC").trim();
  const sendTime = String(body.send_time ?? "06:00");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new HttpError(400, "invalid_timezone");
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(sendTime)) {
    throw new HttpError(400, "invalid_schedule_or_model");
  }
  let tuning;
  try {
    tuning = validateLlmTuningInput(body);
  } catch {
    throw new HttpError(400, "invalid_llm_tuning");
  }
  return { timezone, send_time: sendTime, ...tuning };
}

async function settings(env) {
  const result = await env.DB.prepare("SELECT key, value FROM settings").all();
  return Object.fromEntries(result.results.map(({ key, value }) => [key, value]));
}

async function api(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health" && method === "GET") return json({ status: "ok" });
  if (method !== "GET" && method !== "HEAD") assertSameOrigin(request);
  if (path === "/auth/google" && method === "GET") return authStart(request, env);
  if (path === "/auth/callback" && method === "GET") return authCallback(request, env);
  if (path === "/auth/logout" && method === "POST") return logout(request, env);
  if (path === "/api/me" && method === "GET") return json({ user: await currentUser(request, env) });

  const user = await currentUser(request, env);
  requireUser(user);

  if (path === "/api/settings" && method === "GET") {
    const row = await env.DB.prepare("SELECT subscribed FROM users WHERE id=?").bind(user.id).first();
    return json({ subscribed: Boolean(row?.subscribed) });
  }
  if (path === "/api/settings" && method === "PUT") {
    const body = await bodyJson(request);
    if (typeof body.subscribed !== "boolean") throw new HttpError(400, "invalid_settings");
    await env.DB.prepare("UPDATE users SET subscribed=?, updated_at=? WHERE id=?").bind(body.subscribed ? 1 : 0, isoNow(), user.id).run();
    return json({ subscribed: body.subscribed });
  }
  if (path === "/api/history" && method === "GET") {
    const result = await env.DB.prepare(`SELECT date, status, subject, error_code, attempted_at, sent_at
      FROM deliveries WHERE user_id=? ORDER BY date DESC LIMIT 100`).bind(user.id).all();
    return json({ deliveries: result.results });
  }
  const historyMatch = /^\/api\/history\/(\d{4}-\d{2}-\d{2})$/.exec(path);
  if (historyMatch && method === "GET") {
    const delivery = await env.DB.prepare(`SELECT date, status, subject, body, attempted_at, sent_at
      FROM deliveries WHERE user_id=? AND date=?`).bind(user.id, historyMatch[1]).first();
    if (!delivery) throw new HttpError(404, "delivery_not_found");
    return json({ delivery });
  }

  if (path.startsWith("/api/admin/")) requireAdmin(user);
  if (path === "/api/admin/overview" && method === "GET") {
    const [users, invites, deliveries, runs, lessons] = await Promise.all([
      env.DB.prepare("SELECT id, email, name, subscribed, created_at FROM users ORDER BY email LIMIT 500").all(),
      env.DB.prepare("SELECT email, note, invited_by, created_at, email_sent_at FROM invites ORDER BY email LIMIT 500").all(),
      env.DB.prepare("SELECT id, date, recipient_email, status, error_code, subject, attempted_at, sent_at FROM deliveries ORDER BY attempted_at DESC LIMIT 100").all(),
      env.DB.prepare("SELECT date, status, counts_json, error_code, started_at, finished_at FROM runs ORDER BY id DESC LIMIT 30").all(),
      env.DB.prepare("SELECT date, title, created_at FROM lessons ORDER BY date DESC LIMIT 30").all(),
    ]);
    return json({ users: users.results.map((entry) => ({ ...entry, subscribed: Boolean(entry.subscribed) })), invites: invites.results, deliveries: deliveries.results, runs: runs.results, lessons: lessons.results });
  }
  const deliveryMatch = /^\/api\/admin\/deliveries\/(\d+)$/.exec(path);
  if (deliveryMatch && method === "GET") {
    const delivery = await env.DB.prepare(`SELECT date, recipient_email, status, subject, body, attempted_at, sent_at
      FROM deliveries WHERE id=?`).bind(Number(deliveryMatch[1])).first();
    if (!delivery) throw new HttpError(404, "delivery_not_found");
    return json({ delivery });
  }
  if (path === "/api/admin/invites" && method === "POST") {
    const body = await bodyJson(request);
    const email = String(body.email || "").trim().toLowerCase();
    const note = String(body.note || "").trim().slice(0, 200);
    if (!validEmail(email)) throw new HttpError(400, "invalid_email");
    await env.DB.prepare("INSERT INTO invites (email, note, invited_by, created_at, email_sent_at) VALUES (?, ?, ?, ?, NULL) ON CONFLICT(email) DO UPDATE SET note=excluded.note")
      .bind(email, note, user.email, isoNow()).run();
    let emailSent = false;
    try {
      await sendEmail(env, {
        to: email,
        subject: "NitM 뉴스 브리핑 초대",
        markdown: `# NitM에 초대합니다\n\n관리자가 이 이메일 주소를 NitM에 등록했습니다. 아래 링크를 열고 Google 계정 **${email}** 으로 로그인해 주세요.\n\n[Google로 로그인](${new URL("/auth/google", request.url).toString()})`,
        requestedModel: "미사용",
        responseModel: "미사용",
      });
      await env.DB.prepare("UPDATE invites SET email_sent_at=? WHERE email=?").bind(isoNow(), email).run();
      emailSent = true;
    } catch (error) {
      console.warn("Invitation email failed", error instanceof Error ? error.message : "unknown");
    }
    await audit(env, user, "inviteUser", email);
    return json({ ok: true, emailSent });
  }
  const inviteMatch = /^\/api\/admin\/invites\/(.+)$/.exec(path);
  if (inviteMatch && method === "DELETE") {
    const email = decodeURIComponent(inviteMatch[1]).trim().toLowerCase();
    if (!validEmail(email)) throw new HttpError(400, "invalid_email");
    await env.DB.prepare("DELETE FROM invites WHERE email=?").bind(email).run();
    await audit(env, user, "removeInvite", email);
    return json({ ok: true });
  }
  const userMatch = /^\/api\/admin\/users\/([^/]+)$/.exec(path);
  if (userMatch && method === "PATCH") {
    const body = await bodyJson(request);
    if (typeof body.subscribed !== "boolean") throw new HttpError(400, "invalid_user_state");
    await env.DB.prepare("UPDATE users SET subscribed=?, updated_at=? WHERE id=?").bind(body.subscribed ? 1 : 0, isoNow(), userMatch[1]).run();
    await audit(env, user, body.subscribed ? "enableUser" : "disableUser", userMatch[1]);
    return json({ ok: true });
  }
  if (path === "/api/admin/sources" && method === "GET") {
    const result = await env.DB.prepare("SELECT id, name, url, enabled, sort_order AS 'order' FROM sources ORDER BY sort_order, name").all();
    return json({ sources: result.results.map((source) => ({ ...source, enabled: Boolean(source.enabled) })) });
  }
  if (path === "/api/admin/sources" && method === "POST") {
    const source = sourceInput(await bodyJson(request));
    await env.DB.prepare(`INSERT INTO sources (id, name, url, enabled, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, url=excluded.url, enabled=excluded.enabled, sort_order=excluded.sort_order, updated_at=excluded.updated_at`)
      .bind(source.id, source.name, source.url, source.enabled ? 1 : 0, source.order, isoNow(), isoNow()).run();
    await audit(env, user, "upsertSource", source.id);
    return json({ ok: true, source });
  }
  const sourceMatch = /^\/api\/admin\/sources\/([a-zA-Z0-9_-]{1,40})$/.exec(path);
  if (sourceMatch && method === "PUT") {
    const old = await env.DB.prepare("SELECT id, name, url, enabled, sort_order FROM sources WHERE id=?").bind(sourceMatch[1]).first();
    if (!old) throw new HttpError(404, "source_not_found");
    const source = sourceInput({ ...(await bodyJson(request)), id: old.id }, old);
    await env.DB.prepare("UPDATE sources SET name=?, url=?, enabled=?, sort_order=?, updated_at=? WHERE id=?")
      .bind(source.name, source.url, source.enabled ? 1 : 0, source.order, isoNow(), source.id).run();
    await audit(env, user, "updateSource", source.id);
    return json({ ok: true, source });
  }
  if (sourceMatch && method === "DELETE") {
    await env.DB.prepare("DELETE FROM sources WHERE id=?").bind(sourceMatch[1]).run();
    await audit(env, user, "deleteSource", sourceMatch[1]);
    return json({ ok: true });
  }
  if (path === "/api/admin/settings" && method === "GET") {
    const values = await settings(env);
    return json({
      timezone: values.timezone || "UTC",
      send_time: values.send_time || "06:00",
      summary_language: "Korean",
      llmSecrets: {
        apiKey: Boolean(env.LLM_API_KEY),
        baseUrl: Boolean(env.LLM_BASE_URL),
        baseUrlValid: llmBaseUrlIsValid(env.LLM_BASE_URL),
        model: Boolean(env.LLM_MODEL),
      },
      llmConfigured: llmSecretsConfigured(env),
      llmTuning: llmTuningSettings(values),
      llmTuningFields: LLM_TUNING_FIELDS,
    });
  }
  if (path === "/api/admin/settings" && method === "PUT") {
    const values = configInput(await bodyJson(request));
    const statements = Object.entries(values).map(([key, value]) =>
      env.DB.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
        .bind(key, value, isoNow()),
    );
    await env.DB.batch(statements);
    await audit(env, user, "updateSettings", Object.keys(values).join(","));
    return json({ ok: true });
  }
  if (path === "/api/admin/test-email" && method === "POST") {
    try {
      await sendTestDigest(env, user.email);
    } catch (error) {
      const code = error instanceof Error ? error.message : "test_email_failed";
      const status = {
        no_news: 422,
        llm_not_configured: 400,
        lesson_generation_error: 502,
        invalid_llm_url: 400,
        llm_connection_error: 502,
        llm_timeout: 504,
  llm_output_truncated: 502,
        llm_invalid_response: 502,
        llm_auth_error: 502,
        llm_endpoint_not_found: 502,
        llm_rate_limited: 503,
        llm_provider_error: 502,
        prompt_not_found: 500,
        mail_not_configured: 503,
        email_error: 502,
      }[code];
      if (status) throw new HttpError(status, code);
      console.error("Test email failed", error instanceof Error ? error.name : "unknown");
      throw new HttpError(500, "test_email_failed");
    }
    await audit(env, user, "sendTestEmail", user.email);
    return json({ ok: true });
  }
  if (path === "/api/admin/run" && method === "POST") {
    const result = await runDigest(env, { manual: true });
    await audit(env, user, "manualDigest", result.date);
    return json(result);
  }
  if (path === "/api/admin/audit" && method === "GET") {
    const result = await env.DB.prepare("SELECT actor_email, action, target, created_at FROM audit_logs ORDER BY id DESC LIMIT 100").all();
    return json({ entries: result.results });
  }
  const lessonMatch = /^\/api\/admin\/lessons\/(\d{4}-\d{2}-\d{2})$/.exec(path);
  if (lessonMatch && method === "GET") {
    const lesson = await env.DB.prepare("SELECT date, title, markdown, sources_json, model, created_at FROM lessons WHERE date=?").bind(lessonMatch[1]).first();
    if (!lesson) throw new HttpError(404, "lesson_not_found");
    return json({ lesson: { ...lesson, sources: JSON.parse(lesson.sources_json) } });
  }

  throw new HttpError(404, "not_found");
}

async function handle(request, env = {}) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
    try {
      return await api(request, env);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error("Request failed", error instanceof Error ? error.name : "unknown");
      return json({ error: "internal_error" }, 500);
    }
  }
  if (!env.ASSETS) return new Response("NitM frontend assets are not configured.", { status: 503 });
  return env.ASSETS.fetch(request);
}

export default {
  fetch: handle,
  async scheduled(controller, env, context) {
    context.waitUntil(scheduledDigest(env, controller.scheduledTime).catch((error) => {
      console.error("Scheduled Worker failed", error instanceof Error ? error.name : "unknown");
    }));
  },
};

export const __test__ = { api, handle, validateExternalUrl };