import { createHash, randomBytes } from "node:crypto";
import type { Request } from "express";

/**
 * Infers and materializes the public base URL (e.g. "https://my-addon.a.run.app")
 * directly from the incoming HTTP request headers, with fallback to process.env.BASE_URL.
 * Ensures all URLs shown to the user on configuration cards are real, copy-ready URLs.
 */
export function getBaseUrl(req: Request): string {
	const configuredUrl = process.env.PUBLIC_BASE_URL || process.env.BASE_URL;
	if (configuredUrl && /^https?:\/\//i.test(configuredUrl)) {
		return configuredUrl.replace(/\/+$/, "");
	}

	const forwardedProto = req.headers["x-forwarded-proto"];
	const proto = Array.isArray(forwardedProto)
		? forwardedProto[0]
		: forwardedProto?.split(",")[0]?.trim() || req.protocol || "https";

	const forwardedHost = req.headers["x-forwarded-host"];
	const host = Array.isArray(forwardedHost)
		? forwardedHost[0]
		: forwardedHost?.split(",")[0]?.trim() ||
			req.headers.host ||
			"localhost:3000";

	return `${proto}://${host}`;
}

/**
 * Generates a cryptographically strong webhook secret with a standard prefix.
 */
export function generateWebhookSecret(): string {
	return `whsec_${randomBytes(24).toString("hex")}`;
}

/**
 * Computes a SHA-256 hex digest of a raw webhook secret so plaintext secrets
 * are never stored in SQLite.
 */
export function hashWebhookSecret(rawSecret: string): string {
	return createHash("sha256").update(rawSecret, "utf8").digest("hex");
}

/**
 * Formats a human-readable label combining an optional user-provided label
 * with a masked preview of the secret (e.g. "Prod Key (whsec_1a2b...8e9f)" or "whsec_1a2b...8e9f").
 */
export function formatSecretLabel(
	rawSecret: string,
	customLabel?: string,
): string {
	const masked =
		rawSecret.length > 14
			? `${rawSecret.slice(0, 10)}...${rawSecret.slice(-4)}`
			: "whsec_...";
	const trimmedLabel = customLabel?.trim();
	return trimmedLabel ? `${trimmedLabel} (${masked})` : masked;
}
