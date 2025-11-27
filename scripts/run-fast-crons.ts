import {
  runCardCenterCron,
  runCardDepotCron,
  runCardCookieCron,
  runGcxCron,
} from "../src/cron.ts";

type Env = {
  DATABASE_URL: string;
};

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const env: Env = { DATABASE_URL: databaseUrl };

  await Promise.all([
    runCardCenterCron(env),
    runCardDepotCron(env),
    runCardCookieCron(env),
    runGcxCron(env),
  ]);
}

main().catch((err) => {
  console.error("Fast provider crons failed:", err);
  process.exit(1);
});


