const express = require("express");
const { createAppAuth } = require("@octokit/auth-app");
const fs = require("fs");

const app = express();
const PORT = 3000;

// Read PEM at startup
const privateKey = fs.readFileSync("/secrets/github-app.pem", "utf8");
const appId = process.env.GITHUB_APP_ID;
const brokerSecret = process.env.BROKER_SECRET;

if (!appId) {
  console.error("GITHUB_APP_ID is required");
  process.exit(1);
}

if (!brokerSecret) {
  console.error("BROKER_SECRET is required");
  process.exit(1);
}

// Simple in-memory cache: installationId -> { token, expiresAt }
const cache = new Map();

app.get("/token", async (req, res) => {
  // Validate Bearer token
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.slice(7) !== brokerSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const installationId = req.query.installation_id;
  if (!installationId) {
    return res.status(400).json({ error: "installation_id required" });
  }

  // Check cache
  const cached = cache.get(installationId);
  if (cached && new Date(cached.expiresAt) > new Date(Date.now() + 5 * 60 * 1000)) {
    return res.json({ token: cached.token, expires_at: cached.expiresAt });
  }

  try {
    const auth = createAppAuth({ appId, privateKey, installationId: Number(installationId) });
    const { token, expiresAt } = await auth({ type: "installation" });
    cache.set(installationId, { token, expiresAt });
    res.json({ token, expires_at: expiresAt });
  } catch (err) {
    console.error(`Token error for installation ${installationId}:`, err.message);
    res.status(500).json({ error: "Failed to mint token" });
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Credential broker listening on port ${PORT}`);
});
