import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(repoRoot, ".env.local") });

const config = {
  twitchClientId: process.env.TWITCH_CLIENT_ID || "",
  twitchClientSecret: process.env.TWITCH_CLIENT_SECRET || "",
  twitchChannelLogin: process.env.TWITCH_CHANNEL_LOGIN || "softu1",
  twitchUserTokenPath: process.env.TWITCH_USER_TOKEN_PATH || path.join(repoRoot, "secrets", "twitch_user_token.json"),
  redirectPort: Number(process.env.TWITCH_AUTH_REDIRECT_PORT || "49724"),
  redirectPath: "/twitch/callback",
  scopes: ["channel:manage:videos"],
};

const fail = (message) => {
  throw new Error(message);
};

const openUrl = (url) => {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
};

const exchangeCodeForToken = async (code, redirectUri) => {
  const params = new URLSearchParams({
    client_id: config.twitchClientId,
    client_secret: config.twitchClientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    fail(`Twitch OAuth token exchange failed (${response.status}): ${text}`);
  }

  return response.json();
};

const validateToken = async (accessToken) => {
  const response = await fetch("https://id.twitch.tv/oauth2/validate", {
    method: "GET",
    headers: {
      Authorization: `OAuth ${accessToken}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    fail(`Twitch OAuth token validation failed (${response.status}): ${text}`);
  }

  return response.json();
};

const ensureConfig = () => {
  if (!config.twitchClientId) fail("TWITCH_CLIENT_ID is missing in .env.local");
  if (!config.twitchClientSecret) fail("TWITCH_CLIENT_SECRET is missing in .env.local");
};

ensureConfig();

const redirectUri = `http://127.0.0.1:${config.redirectPort}${config.redirectPath}`;
const authUrl = new URL("https://id.twitch.tv/oauth2/authorize");
authUrl.searchParams.set("client_id", config.twitchClientId);
authUrl.searchParams.set("redirect_uri", redirectUri);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", config.scopes.join(" "));
authUrl.searchParams.set("force_verify", "true");

const htmlSuccess = `
<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Twitch Auth Complete</title></head>
  <body style="font-family: sans-serif; background: #111; color: #fff; padding: 2rem;">
    <h2>soft archive Twitch auth complete.</h2>
    <p>You can close this window.</p>
  </body>
</html>
`;

const htmlError = (message) => `
<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Twitch Auth Failed</title></head>
  <body style="font-family: sans-serif; background: #111; color: #fff; padding: 2rem;">
    <h2>Twitch auth failed.</h2>
    <p>${message}</p>
  </body>
</html>
`;

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://127.0.0.1:${config.redirectPort}`);
    if (requestUrl.pathname !== config.redirectPath) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const code = requestUrl.searchParams.get("code");
    const oauthError = requestUrl.searchParams.get("error");
    const oauthDescription = requestUrl.searchParams.get("error_description");

    if (oauthError) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(htmlError(`${oauthError}: ${oauthDescription || "Unknown OAuth error"}`));
      console.error(`Twitch OAuth error: ${oauthError} ${oauthDescription || ""}`.trim());
      process.exitCode = 1;
      setTimeout(() => server.close(), 300);
      return;
    }

    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(htmlError("Missing authorization code"));
      process.exitCode = 1;
      setTimeout(() => server.close(), 300);
      return;
    }

    const tokenPayload = await exchangeCodeForToken(code, redirectUri);
    const validation = await validateToken(tokenPayload.access_token);
    const expiresAtMs = Date.now() + Number(tokenPayload.expires_in || 0) * 1000;

    if (
      config.twitchChannelLogin &&
      validation.login &&
      validation.login.toLowerCase() !== config.twitchChannelLogin.toLowerCase()
    ) {
      fail(`Authorized Twitch login "${validation.login}" does not match TWITCH_CHANNEL_LOGIN "${config.twitchChannelLogin}"`);
    }

    const tokenRecord = {
      ...tokenPayload,
      scopes: validation.scopes || tokenPayload.scope || [],
      user_id: validation.user_id,
      user_login: validation.login,
      obtained_at: new Date().toISOString(),
      expires_at_ms: expiresAtMs,
    };

    await fs.mkdir(path.dirname(config.twitchUserTokenPath), { recursive: true });
    await fs.writeFile(config.twitchUserTokenPath, `${JSON.stringify(tokenRecord, null, 2)}\n`, "utf8");

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(htmlSuccess);
    console.log(`Twitch OAuth token saved to ${config.twitchUserTokenPath}`);
    setTimeout(() => server.close(), 300);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(htmlError(error.message));
    console.error(error.message);
    process.exitCode = 1;
    setTimeout(() => server.close(), 300);
  }
});

server.listen(config.redirectPort, "127.0.0.1", () => {
  console.log(`Authorize Twitch at:\n${authUrl.toString()}`);
  openUrl(authUrl.toString());
});

