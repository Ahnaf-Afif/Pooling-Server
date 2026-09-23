import mongoose from "mongoose";
import { MongoClient } from "mongodb";

let connectionPromise;
let mongoClient;

function getMongoUri() {
  return process.env.MONGODB_URI?.trim() || "mongodb://127.0.0.1:27017/what-do-you-think";
}

export function getMongoClient() {
  if (!mongoClient) {
    mongoClient = new MongoClient(getMongoUri(), {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000,
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

    connectionPromise = mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10000,
      maxPoolSize: 10,
    }).finally(() => {
      connectionPromise = undefined;
    });
  }

  return connectionPromise;
}

export async function closeDatabases() {
  await Promise.all([
    mongoose.disconnect(),
    mongoClient?.close(),
  ]);
  mongoClient = undefined;
}
