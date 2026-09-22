import mongoose from "mongoose";

let connectionPromise;

export function connectDatabase() {
  if (mongoose.connection.readyState === 1) return Promise.resolve();

  if (!connectionPromise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) return Promise.reject(new Error("MONGODB_URI is required"));

    connectionPromise = mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10000,
      maxPoolSize: 10,
    }).finally(() => {
      connectionPromise = undefined;
    });
  }

  return connectionPromise;
}
