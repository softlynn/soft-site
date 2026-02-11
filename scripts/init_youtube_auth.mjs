import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { authenticate } from "@google-cloud/local-auth";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(repoRoot, ".env.local") });

const clientSecretPath = process.env.YOUTUBE_CLIENT_SECRET_PATH || "C:/Users/Alex2/Documents/youtube_client_secret.json";
const tokenPath = process.env.YOUTUBE_TOKEN_PATH || path.join(repoRoot, "secrets", "youtube_token.json");

const scopes = ["https://www.googleapis.com/auth/youtube", "https://www.googleapis.com/auth/youtube.upload"];

const run = async () => {
  const authClient = await authenticate({
    scopes,
    keyfilePath: clientSecretPath,
  });

  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  await fs.writeFile(tokenPath, `${JSON.stringify(authClient.credentials, null, 2)}\n`, "utf8");
  console.log(`YouTube OAuth token saved to ${tokenPath}`);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
