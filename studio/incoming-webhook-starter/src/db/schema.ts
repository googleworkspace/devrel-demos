import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Stores user OAuth credentials keyed by their immutable Google Account ID
 * (`sub` claim from Google ID tokens). Email is intentionally omitted to minimize
 * scope requirements.
 */
export const users = sqliteTable("users", {
	userId: text("user_id").primaryKey(),
	refreshToken: text("refresh_token").notNull(),
	accessToken: text("access_token"),
	accessTokenExpiry: integer("access_token_expiry"),
	updatedAt: integer("updated_at").notNull(),
});

/**
 * Stores Workspace Studio starter subscriptions keyed by `triggerId`.
 *
 * Note on `instanceId`:
 * - `instanceId` is persisted in a hidden widget on the configuration card and used
 *   as the public webhook URL path (`/webhook/:instanceId`) so the user can see their
 *   webhook URL immediately before enabling the workflow.
 * - `instanceId` is intentionally NOT unique because when a user updates configuration
 *   on an active workflow, Studio creates the new trigger (`triggerCreation`) first
 *   and deletes the old trigger (`triggerDeletion`) second.
 * - When a webhook arrives for `:instanceId`, the most recently updated active row
 *   (`ORDER BY updated_at DESC`) is selected.
 */
export const subscriptions = sqliteTable(
	"subscriptions",
	{
		triggerId: text("trigger_id").primaryKey(),
		instanceId: text("instance_id").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => users.userId, { onDelete: "cascade" }),
		notifyUri: text("notify_uri").notNull(),
		requireApiKey: integer("require_api_key", { mode: "boolean" })
			.notNull()
			.default(false),
		status: text("status").notNull().default("ACTIVE"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [
		index("idx_subscriptions_instance_updated").on(
			table.instanceId,
			table.updatedAt,
		),
	],
);

/**
 * Stores SHA-256 hashed API key secrets and display labels tied to `instanceId`.
 *
 * Why no foreign key to `subscriptions.instance_id`:
 * 1. Secrets can be created immediately on the starter configuration card before
 *    any workflow subscription (`triggerCreation`) exists.
 * 2. When a workflow configuration is updated, Studio creates a new `subscriptions`
 *    row and deletes the old one.
 * Secrets for an `instance_id` are automatically cleaned up only when the last
 * `subscriptions` record for that `instance_id` is deleted.
 */
export const secrets = sqliteTable(
	"secrets",
	{
		secretId: text("secret_id").primaryKey(),
		instanceId: text("instance_id").notNull(),
		userId: text("user_id").notNull(),
		label: text("label").notNull(),
		secretHash: text("secret_hash").notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(table) => [index("idx_secrets_instance").on(table.instanceId)],
);

export type UserRecord = typeof users.$inferSelect;
export type NewUserRecord = typeof users.$inferInsert;

export type SubscriptionRecord = typeof subscriptions.$inferSelect;
export type NewSubscriptionRecord = typeof subscriptions.$inferInsert;

export type SecretRecord = typeof secrets.$inferSelect;
export type NewSecretRecord = typeof secrets.$inferInsert;
