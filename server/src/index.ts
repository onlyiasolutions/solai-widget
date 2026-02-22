

import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";

// Load env from common locations (supports running from monorepo root or /server)
const envCandidates = [
  path.resolve(process.cwd(), ".env.local"),
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "server/.env.local"),
  path.resolve(process.cwd(), "server/.env"),
];

for (const p of envCandidates) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p, override: false });
  }
}

// eslint-disable-next-line no-console
console.log(
  "[server] cwd=",
  process.cwd(),
  "ELEVENLABS_API_KEY loaded=",
  !!process.env.ELEVENLABS_API_KEY
);

import express from "express";
import cors from "cors";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { widgetRouter } from "./routes/widget.js";
import { rateLimiter } from "./middleware/rateLimit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

const app = express();
const isDev = process.env.NODE_ENV !== "production";

// CORS: solo localhost en dev
app.use(
  cors({
    origin: isDev
      ? [/^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/]
      : false,
    credentials: true,
  })
);

app.use(express.json());
app.use(rateLimiter);

// API
app.use("/api/widget", widgetRouter);

// Preview: servir demo y widget built
const rootDir = join(__dirname, "..", "..");
app.use(
  "/solai-widget.js",
  express.static(join(rootDir, "widget", "dist", "solai-widget.js"))
);
app.use(express.static(join(rootDir, "demo")));

// Health check
app.get("/health", (_req, res) =>
  res.json({ status: "ok", hasElevenKey: !!process.env.ELEVENLABS_API_KEY })
);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[server] Listening on http://localhost:${PORT}`);
});