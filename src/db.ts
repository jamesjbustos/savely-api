import { neon } from "@neondatabase/serverless";

export function getDb(env: { DATABASE_URL: string; HYPERDRIVE?: { connectionString: string } }) {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  return neon(connectionString);
}
