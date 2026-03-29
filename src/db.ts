import postgres from "postgres";

export function getDb(env: { DATABASE_URL: string; HYPERDRIVE?: { connectionString: string } }) {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  return postgres(connectionString, {
    prepare: false, // Required for Supabase transaction-mode pooler
    max: 1,         // Single connection per Worker invocation
  });
}
