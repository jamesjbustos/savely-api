import { runArbitrageCron } from "../src/cron.ts";

type Env = {
  DATABASE_URL: string;
};

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const env: Env = { DATABASE_URL: databaseUrl };

  await runArbitrageCron(env);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("ArbitrageCard cron failed:", err);
    process.exit(1);
  });
