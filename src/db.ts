import mongoose from "mongoose";

let connected = false;

/**
 * Connects to the SAME MongoDB the main Whoogy API uses — this server only
 * owns the OAuthClient/OAuthGrant/PluginAuthSession collections, it doesn't
 * duplicate any product data.
 */
export async function connectDb() {
  if (connected) return;

  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) {
    console.warn("[db] MONGODB_URI not set — skipping MongoDB connection.");
    return;
  }

  await mongoose.connect(uri, { dbName: process.env.DB_NAME });
  connected = true;
  console.log("[db] Connected to MongoDB.");
}
