import mongoose, { Document, Schema } from "mongoose";

/**
 * Device-authorization handshake shared with the main Whoogy API and the
 * Figma plugin's "sign in without leaving Figma" flow. This server creates
 * a pending session (status "pending") and points the user's browser at the
 * Whoogy web app's consent page; that page flips it to "approved" once the
 * user signs in. Model shape must stay identical to the main API's copy —
 * both services read/write the same MongoDB collection.
 */
export interface IPluginAuthSession extends Document {
  code: string;
  status: "pending" | "approved" | "expired";
  userId?: mongoose.Types.ObjectId;
  token?: string;
  name?: string;
  email?: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const pluginAuthSessionSchema = new Schema<IPluginAuthSession>(
  {
    code: { type: String, required: true, unique: true },
    status: { type: String, enum: ["pending", "approved", "expired"], default: "pending" },
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    token: { type: String },
    name: { type: String },
    email: { type: String },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// MongoDB sweeps expired codes itself — a one-time login code never lingers.
pluginAuthSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PluginAuthSession = mongoose.model<IPluginAuthSession>(
  "PluginAuthSession",
  pluginAuthSessionSchema,
);
