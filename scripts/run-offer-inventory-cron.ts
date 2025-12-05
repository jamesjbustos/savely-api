import { runOfferInventorySnapshotCron } from "../src/cron.ts";

type Env = {
  DATABASE_URL: string;
};

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const env: Env = { DATABASE_URL: databaseUrl };

  await runOfferInventorySnapshotCron(env);
}

main().catch((err) => {
  console.error("Offer inventory snapshot cron failed:", err);
  process.exit(1);
});

