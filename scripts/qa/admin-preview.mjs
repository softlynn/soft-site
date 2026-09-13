// Disposable browser QA fixture. Production data and credentials are never loaded.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "soft-admin-browser-"));
const links = ["node_modules", "build", "public"];
let child;
let closing = false;
const finish = async () => {
  if (closing) return;
  closing = true;
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
  for (const name of links) await fs.rm(path.join(directory, name), { force: true });
  await fs.rm(directory, { recursive: true, force: true });
  console.log("Fixture stopped and temporary files removed.");
  process.exit(0);
};
process.on("SIGINT", finish);
process.on("SIGTERM", finish);
process.stdin.on("data", (data) => { if (String(data).includes("stop")) void finish(); });

try {
  await fs.mkdir(path.join(directory, "scripts"));
  for (const name of ["run_local_admin_api.mjs", "admin_console.mjs", "pipeline_file_io.mjs"]) {
    await fs.copyFile(path.join(repo, "scripts", name), path.join(directory, "scripts", name));
  }
  for (const name of links) await fs.symlink(path.join(repo, name), path.join(directory, name), process.platform === "win32" ? "junction" : "dir");
  if (spawnSync("git", ["init", "--quiet"], { cwd: directory, windowsHide: true }).status !== 0) throw new Error("Fixture git init failed");
  const vodsPath = path.join(directory, "vods.json");
  await fs.writeFile(vodsPath, JSON.stringify([
    { id: "qa-one", title: "Synthetic dance night", createdAt: "2026-09-12T12:00:00Z", youtube: [], chatReplayAvailable: true },
    { id: "qa-two", title: "Synthetic cozy stream", createdAt: "2026-09-11T12:00:00Z", youtube: [], chatReplayAvailable: false },
    { id: "qa-three", title: "Synthetic hidden archive", createdAt: "2026-09-10T12:00:00Z", youtube: [], unpublished: true },
  ]));
  child = spawn(process.execPath, [path.join(directory, "scripts", "run_local_admin_api.mjs")], {
    windowsHide: true,
    env: { ...process.env, ADMIN_API_HOST: "127.0.0.1", ADMIN_API_PORT: "49813", ADMIN_PANEL_PASSWORD: "fixture-password",
      AUTO_GIT_PUSH: "false", ARCHIVE_VODS_PATH: vodsPath, SITE_DESIGN_PATH: path.join(directory, "design.json"),
      SITE_DESIGN_ASSETS_PATH: path.join(directory, "assets"), ADMIN_API_IDLE_TIMEOUT_MINUTES: "0",
      TWITCH_CLIENT_ID: "", TWITCH_CLIENT_SECRET: "", TWITCH_USER_ACCESS_TOKEN: "", TWITCH_USER_REFRESH_TOKEN: "",
      YOUTUBE_CLIENT_SECRET_PATH: path.join(directory, "absent-client.json"), YOUTUBE_TOKEN_PATH: path.join(directory, "absent-token.json"),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.once("error", (error) => { console.error(error.message); void finish(); });
  console.log(`Fixture directory: ${directory}`);
  console.log("Type stop to remove this fixture.");
} catch (error) {
  console.error(error.message);
  await finish();
}
