import Database from "better-sqlite3";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import {
	type BetterSQLite3Database,
	drizzle,
} from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import {
	type SecretRecord,
	type SubscriptionRecord,
	secrets,
	subscriptions,
	type UserRecord,
	users,
} from "./schema.js";

let dbInstance: BetterSQLite3Database<typeof schema> | null = null;

/**
 * Initializes or returns the singleton Drizzle SQLite database connection using better-sqlite3.
 * Supports `:memory:` for isolated unit and integration tests.
 */
export function getDb(dbPath?: string): BetterSQLite3Database<typeof schema> {
	if (dbInstance && !dbPath) {
		return dbInstance;
	}

	const resolvedPath =
		dbPath || process.env.DATABASE_URL || "./webhook-bridge.sqlite";
	const sqlite = new Database(resolvedPath);
	sqlite.pragma("journal_mode = WAL;");
	sqlite.pragma("foreign_keys = ON;");

	// Ensure tables and indexes exist matching the Drizzle schema
	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      refresh_token TEXT NOT NULL,
      access_token TEXT,
      access_token_expiry INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      trigger_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      notify_uri TEXT NOT NULL,
      require_api_key INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_subscriptions_instance_updated
      ON subscriptions(instance_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS secrets (
      secret_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      label TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_secrets_instance
      ON secrets(instance_id);
  `);

	const initializedDb = drizzle(sqlite, { schema });
	if (!dbPath) {
		dbInstance = initializedDb;
	}
	return initializedDb;
}

/**
 * Replaces the singleton database instance (used in tests with `:memory:`).
 */
export function setDbForTesting(
	db: BetterSQLite3Database<typeof schema>,
): void {
	dbInstance = db;
}

// ---------------------------------------------------------------------------
// User Credential Queries (OAuth 2.0 Tokens)
// ---------------------------------------------------------------------------

/**
 * Retrieves a user's stored OAuth tokens by their Google Account ID (`sub`).
 */
export function getUserById(
	userId: string,
	db = getDb(),
): UserRecord | undefined {
	return db.select().from(users).where(eq(users.userId, userId)).get();
}

/**
 * Upserts a user's OAuth tokens (refresh token + cached access token + expiry).
 */
export function upsertUserTokens(
	params: {
		userId: string;
		refreshToken: string;
		accessToken?: string | null;
		accessTokenExpiry?: number | null;
	},
	db = getDb(),
): void {
	const now = Date.now();
	db.insert(users)
		.values({
			userId: params.userId,
			refreshToken: params.refreshToken,
			accessToken: params.accessToken ?? null,
			accessTokenExpiry: params.accessTokenExpiry ?? null,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: users.userId,
			set: {
				refreshToken: params.refreshToken,
				accessToken: params.accessToken ?? null,
				accessTokenExpiry: params.accessTokenExpiry ?? null,
				updatedAt: now,
			},
		})
		.run();
}

/**
 * Updates only the cached short-lived access token and expiry timestamp for a user.
 */
export function updateCachedAccessToken(
	userId: string,
	accessToken: string,
	accessTokenExpiry: number,
	db = getDb(),
): void {
	db.update(users)
		.set({
			accessToken,
			accessTokenExpiry,
			updatedAt: Date.now(),
		})
		.where(eq(users.userId, userId))
		.run();
}

// ---------------------------------------------------------------------------
// Subscription Queries (Studio Workflows)
// ---------------------------------------------------------------------------

/**
 * Looks up the most recently updated active subscription for a card `instanceId`.
 */
export function getActiveSubscriptionByInstanceId(
	instanceId: string,
	userId: string,
	db = getDb(),
): SubscriptionRecord | undefined {
	return db
		.select()
		.from(subscriptions)
		.where(
			and(
				eq(subscriptions.instanceId, instanceId),
				eq(subscriptions.userId, userId),
				eq(subscriptions.status, "ACTIVE"),
			),
		)
		.orderBy(desc(subscriptions.updatedAt), desc(subscriptions.createdAt))
		.get();
}

/**
 * Looks up the active subscription and owner credentials for an incoming webhook.
 * When a workflow is reconfigured in Studio, the new trigger is created before
 * the old one is deleted; ordering by `updatedAt DESC` ensures the latest trigger wins.
 */
export function getActiveSubscriptionWithUserByInstanceId(
	instanceId: string,
	db = getDb(),
): { subscription: SubscriptionRecord; user: UserRecord } | undefined {
	const rows = db
		.select({
			subscription: subscriptions,
			user: users,
		})
		.from(subscriptions)
		.innerJoin(users, eq(subscriptions.userId, users.userId))
		.where(
			and(
				eq(subscriptions.instanceId, instanceId),
				eq(subscriptions.status, "ACTIVE"),
			),
		)
		.orderBy(desc(subscriptions.updatedAt), desc(subscriptions.createdAt))
		.limit(1)
		.all();

	return rows[0];
}

/**
 * Legacy lookup helper used in tests (keyed by triggerId).
 */
export function getActiveSubscriptionWithUser(
	triggerId: string,
	db = getDb(),
): { subscription: SubscriptionRecord; user: UserRecord } | undefined {
	const rows = db
		.select({
			subscription: subscriptions,
			user: users,
		})
		.from(subscriptions)
		.innerJoin(users, eq(subscriptions.userId, users.userId))
		.where(
			and(
				eq(subscriptions.triggerId, triggerId),
				eq(subscriptions.status, "ACTIVE"),
			),
		)
		.limit(1)
		.all();

	return rows[0];
}

/**
 * Creates or updates a starter subscription keyed by `triggerId` when Workspace Studio
 * activates a workflow (`onManageFunction` with `triggerCreation`).
 */
export function createSubscription(
	params: {
		triggerId: string;
		instanceId: string;
		userId: string;
		notifyUri: string;
		requireApiKey: boolean;
		timestampMs?: number;
	},
	db = getDb(),
): SubscriptionRecord {
	const now = params.timestampMs ?? Date.now();

	db.insert(subscriptions)
		.values({
			triggerId: params.triggerId,
			instanceId: params.instanceId,
			userId: params.userId,
			notifyUri: params.notifyUri,
			requireApiKey: params.requireApiKey,
			status: "ACTIVE",
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: subscriptions.triggerId,
			set: {
				instanceId: params.instanceId,
				userId: params.userId,
				notifyUri: params.notifyUri,
				requireApiKey: params.requireApiKey,
				status: "ACTIVE",
				updatedAt: now,
			},
		})
		.run();

	const subscription = db
		.select()
		.from(subscriptions)
		.where(eq(subscriptions.triggerId, params.triggerId))
		.get();

	if (!subscription)
		throw new Error("Failed to retrieve inserted subscription.");
	return subscription;
}

/**
 * Deletes a subscription by `triggerId` (idempotent).
 * Cleans up associated `secrets` once no subscriptions remain for the `instanceId`.
 */
export function deleteSubscriptionByTriggerId(
	triggerId: string,
	db = getDb(),
): boolean {
	const existing = db
		.select()
		.from(subscriptions)
		.where(eq(subscriptions.triggerId, triggerId))
		.get();

	const result = db
		.delete(subscriptions)
		.where(eq(subscriptions.triggerId, triggerId))
		.run();

	if (existing) {
		const remainingForInstance = db
			.select()
			.from(subscriptions)
			.where(eq(subscriptions.instanceId, existing.instanceId))
			.all();

		if (remainingForInstance.length === 0) {
			db.delete(secrets)
				.where(eq(secrets.instanceId, existing.instanceId))
				.run();
		}
	}

	return Number(result.changes) > 0;
}

// ---------------------------------------------------------------------------
// Secret Management Queries (Optional Webhook API Keys)
// ---------------------------------------------------------------------------

/**
 * Lists all stored (hashed) secrets for an `instanceId`, scoped by `userId`.
 */
export function listSecretsByInstanceId(
	instanceId: string,
	userId: string,
	db = getDb(),
): SecretRecord[] {
	return db
		.select()
		.from(secrets)
		.where(and(eq(secrets.instanceId, instanceId), eq(secrets.userId, userId)))
		.orderBy(asc(secrets.createdAt))
		.all();
}

/**
 * Stores a new hashed secret + label for an `instanceId`, ensuring ownership.
 */
export function addSecretForInstance(
	params: {
		secretId: string;
		instanceId: string;
		userId: string;
		label: string;
		secretHash: string;
	},
	db = getDb(),
): SecretRecord {
	// Prevent cross-user hijacking: ensure the instance does not belong to another user
	const conflictSub = db
		.select()
		.from(subscriptions)
		.where(
			and(
				eq(subscriptions.instanceId, params.instanceId),
				ne(subscriptions.userId, params.userId),
			),
		)
		.get();

	const conflictSecret = db
		.select()
		.from(secrets)
		.where(
			and(
				eq(secrets.instanceId, params.instanceId),
				ne(secrets.userId, params.userId),
			),
		)
		.get();

	if (conflictSub || conflictSecret) {
		throw new Error("Unauthorized: Instance belongs to another user.");
	}

	const now = Date.now();
	db.insert(secrets)
		.values({
			secretId: params.secretId,
			instanceId: params.instanceId,
			userId: params.userId,
			label: params.label,
			secretHash: params.secretHash,
			createdAt: now,
		})
		.run();

	const secret = db
		.select()
		.from(secrets)
		.where(eq(secrets.secretId, params.secretId))
		.get();

	if (!secret) throw new Error("Failed to retrieve inserted secret.");
	return secret;
}

/**
 * Deletes a specific secret by `secretId`, scoped to `instanceId` and `userId`.
 */
export function deleteSecretById(
	params: {
		secretId: string;
		instanceId: string;
		userId: string;
	},
	db = getDb(),
): boolean {
	const result = db
		.delete(secrets)
		.where(
			and(
				eq(secrets.secretId, params.secretId),
				eq(secrets.instanceId, params.instanceId),
				eq(secrets.userId, params.userId),
			),
		)
		.run();
	return Number(result.changes) > 0;
}
