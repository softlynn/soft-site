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
  twitchChannelLogin: process.env.TWITCH_CHANNEL_LOGIN || "",
  twitchUserTokenPath: process.env.TWITCH_USER_TOKEN_PATH || path.join(repoRoot, "secrets", "twitch_user_token.json"),
  scopes: ["channel:manage:videos"],
};
const TWITCH_DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

const fail = (message) => {
  throw new Error(message);
};

const openUrl = (url) => {
  if (process.platform === "win32") {
    spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
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

const requestDeviceCode = async () => {
  const params = new URLSearchParams({
    client_id: config.twitchClientId,
    scopes: config.scopes.join(" "),
  });

  const response = await fetch("https://id.twitch.tv/oauth2/device", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    fail(`Twitch device code request failed (${response.status}): ${text}`);
  }

  return response.json();
};

const pollDeviceToken = async (deviceCode) => {
  const params = new URLSearchParams({
    client_id: config.twitchClientId,
    client_secret: config.twitchClientSecret,
    grant_type: TWITCH_DEVICE_GRANT_TYPE,
    device_code: String(deviceCode || ""),
  });

  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (response.ok) {
    return { status: "success", payload: await response.json() };
  }

  const text = await response.text();
  let message = "";
  try {
    const parsed = JSON.parse(text);
    message = String(parsed?.message || parsed?.error || "");
  } catch {
    message = String(text || "");
  }

  const normalized = message.trim().toLowerCase().replace(/\s+/g, "_");
  if (normalized === "authorization_pending") return { status: "pending" };
  if (normalized === "slow_down") return { status: "slow_down" };
  if (normalized === "access_denied") return { status: "denied" };
  if (normalized === "expired_token" || normalized === "invalid_device_code") return { status: "expired" };

  return { status: "error", error: `Twitch device token poll failed (${response.status}): ${text}` };
};

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const run = async () => {
  const device = await requestDeviceCode();
  const authUrl = String(device?.verification_uri || "");
  const userCode = String(device?.user_code || "");
  if (!device?.device_code) fail("Twitch device authorization did not return device_code");
  if (!authUrl) fail("Twitch device authorization did not return verification_uri");

  console.log(`Authorize Twitch at:\n${authUrl}`);
  if (userCode) console.log(`Use code: ${userCode}`);
  openUrl(authUrl);

  const expiresAtMs = Date.now() + Math.max(30, Number(device?.expires_in || 1800)) * 1000;
  let pollIntervalSeconds = Math.max(1, Number(device?.interval || 5));

  while (Date.now() < expiresAtMs) {
    await sleep(pollIntervalSeconds * 1000);
    const polled = await pollDeviceToken(device.device_code);
    if (polled.status === "pending") continue;
    if (polled.status === "slow_down") {
      pollIntervalSeconds = Math.min(pollIntervalSeconds + 5, 30);
      continue;
    }
    if (polled.status === "denied") fail("Twitch authorization was denied.");
    if (polled.status === "expired") fail("Twitch authorization expired. Run the command again.");
    if (polled.status === "error") fail(polled.error);

    const tokenPayload = polled.payload;
    const validation = await validateToken(tokenPayload.access_token);
    const expiresAtTokenMs = Date.now() + Number(tokenPayload.expires_in || 0) * 1000;

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
      expires_at_ms: expiresAtTokenMs,
    };

    await fs.mkdir(path.dirname(config.twitchUserTokenPath), { recursive: true });
    await fs.writeFile(config.twitchUserTokenPath, `${JSON.stringify(tokenRecord, null, 2)}\n`, "utf8");
    console.log(`Twitch OAuth token saved to ${config.twitchUserTokenPath}`);
    return;
  }

  fail("Timed out waiting for Twitch authorization.");
};

run().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
