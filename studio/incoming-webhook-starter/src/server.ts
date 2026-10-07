import { createApp } from "./app.js";
import { getDb } from "./db/index.js";

const PORT = Number(process.env.PORT || 3000);

// Initialize SQLite database & Drizzle tables on startup
getDb();

const app = createApp();

app.listen(PORT, () => {
	console.log(`🚀 Webhook Bridge Add-on listening on http://localhost:${PORT}`);
});
