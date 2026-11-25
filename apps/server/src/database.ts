import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { z } from "zod";

export const databaseUrl = z.url().parse(process.env.DATABASE_URL);
export const pool = new pg.Pool({
	connectionString: databaseUrl,
	connectionTimeoutMillis: 2_000,
	query_timeout: 2_000,
});
export const db = drizzle(pool);
