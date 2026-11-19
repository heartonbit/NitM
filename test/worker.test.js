import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

test("health endpoint returns JSON from the Worker", async () => {
  const response = await worker.fetch(new Request("https://nitm.example/api/health"));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("session endpoint returns an anonymous user without a session", async () => {
  const response = await worker.fetch(new Request("https://nitm.example/api/me"));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { user: null });
});

test("private API routes still require an app session", async () => {
  const response = await worker.fetch(new Request("https://nitm.example/api/settings"));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "authentication_required" });
});

test("Google OAuth start creates state and redirects to Google's consent screen", async () => {
  let insertedState = "";
  const env = {
    GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "client-secret",
    DB: {
      prepare() {
        return { bind(state) { insertedState = state; return { async run() {} }; } };
      },
    },
  };
  const response = await worker.fetch(new Request("https://nitm.example/auth/google"), env);
  const location = new URL(response.headers.get("location"));

  assert.equal(response.status, 302);
  assert.equal(location.origin, "https://accounts.google.com");
  assert.equal(location.searchParams.get("client_id"), env.GOOGLE_CLIENT_ID);
  assert.equal(location.searchParams.get("redirect_uri"), "https://nitm.example/auth/callback");
  assert.equal(location.searchParams.get("state"), insertedState);
  assert.match(response.headers.get("set-cookie"), /nitm_oauth_state=/);
});

test("Google OAuth callback rejects missing or mismatched state", async () => {
  const env = {
    DB: {
      prepare() {
        return { bind() { return { async first() { return null; } }; } };
      },
    },
  };
  const response = await worker.fetch(new Request("https://nitm.example/auth/callback?code=unused&state=attacker"), env);

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/?auth=failed");
  assert.match(response.headers.get("set-cookie"), /nitm_oauth_state=/);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
});

test("logout clears the app session cookie", async () => {
  const env = { DB: { prepare() { return { bind() { return { async run() {} }; } }; } } };
  const response = await worker.fetch(new Request("https://nitm.example/auth/logout", { method: "POST", headers: { Origin: "https://nitm.example" } }), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.match(response.headers.get("set-cookie"), /nitm_session=/);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
});