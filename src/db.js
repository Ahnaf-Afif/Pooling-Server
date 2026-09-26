import mongoose from "mongoose";
import { MongoClient } from "mongodb";

mongoose.set("autoIndex", false);

let connectionPromise;
let mongoClient;

function getMongoUri() {
  return process.env.MONGODB_URI?.trim() || "mongodb://127.0.0.1:27017/what-do-you-think";
}

export function getMongoClient() {
  if (!mongoClient) {
    mongoClient = new MongoClient(getMongoUri(), {
      maxPoolSize: 10,
      maxIdleTimeMS: 60_000,
      connectTimeoutMS: 10_000,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 15_000,
    });
  }
  return mongoClient;
}

export function getMongoDatabase() {
  return getMongoClient().db();
}

export function connectDatabase() {
  if (mongoose.connection.readyState === 1) return Promise.resolve();

  if (!connectionPromise) {
    const uri = process.env.MONGODB_URI?.trim();
    if (!uri) return Promise.reject(new Error("MONGODB_URI is required"));

    connectionPromise = (async () => {
      const client = getMongoClient();
      await client.connect();
      mongoose.connection.setClient(client);
    })().finally(() => {
      connectionPromise = undefined;
    });
  }

  return connectionPromise;
}

export function withDatabaseTransaction(work) {
  return mongoose.connection.transaction(work, {
    readPreference: "primary",
    readConcern: { level: "snapshot" },
    writeConcern: { w: "majority" },
  });
}

export async function closeDatabases() {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  else await mongoClient?.close();
  connectionPromise = undefined;
  mongoClient = undefined;
}
