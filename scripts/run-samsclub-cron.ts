import { runSamsClubCron } from "../src/cron.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Env = {
  DATABASE_URL: string;
  RAKUTEN_CLIENT_ID: string;
  RAKUTEN_CLIENT_SECRET: string;
  RAKUTEN_SID: string;
};

function loadDevVarsIfPresent() {
  const devVarsPath = resolve(process.cwd(), ".dev.vars");
  try {
    const raw = readFileSync(devVarsPath, "utf8");
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
    // ignore missing .dev.vars
  }
}

async function main() {
  loadDevVarsIfPresent();

  const required = [
    "DATABASE_URL",
    "RAKUTEN_CLIENT_ID",
    "RAKUTEN_CLIENT_SECRET",
    "RAKUTEN_SID",
  ] as const;
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }

  const env: Env = {
    DATABASE_URL: process.env.DATABASE_URL!,
    RAKUTEN_CLIENT_ID: process.env.RAKUTEN_CLIENT_ID!,
    RAKUTEN_CLIENT_SECRET: process.env.RAKUTEN_CLIENT_SECRET!,
    RAKUTEN_SID: process.env.RAKUTEN_SID!,
  };

  await runSamsClubCron(env);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Sam's Club cron failed:", err);
    process.exit(1);
  });
