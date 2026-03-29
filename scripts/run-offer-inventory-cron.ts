import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runOfferInventorySnapshotCron } from "../src/cron.ts";

type Env = {
  DATABASE_URL: string;
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
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const env: Env = { DATABASE_URL: databaseUrl };

  await runOfferInventorySnapshotCron(env);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Offer inventory snapshot cron failed:", err);
    process.exit(1);
  });
