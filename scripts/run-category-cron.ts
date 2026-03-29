import { runBrandCategoryCron } from "../src/cron.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Env = {
  DATABASE_URL: string;
  GOOGLE_SEARCH_API_KEY: string;
  GOOGLE_SEARCH_CX: string;
  ANTHROPIC_API_KEY: string;
};

function loadEnvFile(filename: string) {
  const filePath = resolve(process.cwd(), filename);
  try {
    const raw = readFileSync(filePath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed === "---") continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // ignore missing file
  }
}

function loadDevVarsIfPresent() {
  loadEnvFile(".env");
  loadEnvFile(".dev.vars");
}

async function main() {
  loadDevVarsIfPresent();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const googleSearchApiKey = process.env.GOOGLE_SEARCH_API_KEY;
  if (!googleSearchApiKey) {
    throw new Error("GOOGLE_SEARCH_API_KEY is required");
  }

  const googleSearchCx = process.env.GOOGLE_SEARCH_CX;
  if (!googleSearchCx) {
    throw new Error("GOOGLE_SEARCH_CX is required");
  }

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required");
  }

  const env: Env = {
    DATABASE_URL: databaseUrl,
    GOOGLE_SEARCH_API_KEY: googleSearchApiKey,
    GOOGLE_SEARCH_CX: googleSearchCx,
    ANTHROPIC_API_KEY: anthropicApiKey,
  };

  await runBrandCategoryCron(env);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Brand category cron failed:", err);
    process.exit(1);
  });
