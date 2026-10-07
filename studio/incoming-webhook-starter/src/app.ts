import cookieParser from "cookie-parser";
import express, { type Express } from "express";
import { authRouter } from "./auth/oauth.js";
import { studioRouter } from "./studio/routes.js";
import { webhookRouter } from "./webhook/routes.js";

export function createApp(): Express {
	const app = express();

	// Trust proxy headers (X-Forwarded-Proto, X-Forwarded-Host) for Cloud Run / reverse proxies
	app.set("trust proxy", true);

	// Cookie secret for signed OAuth CSRF & PKCE session cookies
	const cookieSecret =
		process.env.COOKIE_SECRET || "dev-webhook-bridge-cookie-secret-key";
	app.use(cookieParser(cookieSecret));

	// Public webhook endpoint uses its own strict 1 KB raw body parser
	app.use("/webhook", webhookRouter);

	// JSON and URL-encoded parsers for Studio add-on and OAuth web app endpoints
	app.use(express.json({ limit: "100kb" }));
	app.use(express.urlencoded({ extended: false, limit: "10kb" }));

	app.use("/auth", authRouter);
	app.use("/studio", studioRouter);

	app.get("/healthz", (_req, res) => {
		res.json({ status: "ok" });
	});

	return app;
}
