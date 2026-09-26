import "dotenv/config";
import { auth } from "../src/auth.js";
import { closeDatabases, connectDatabase, getMongoDatabase } from "../src/db.js";
import { rotateAuthEncryption } from "../src/services/auth-encryption.js";

try {
  await connectDatabase();
  const { secretConfig } = await auth.$context;
  const result = await rotateAuthEncryption(getMongoDatabase(), secretConfig, {
    apply: process.argv.includes("--apply"), verify: process.argv.includes("--verify"),
  });
  console.log(JSON.stringify({ event: "auth_encryption_scan", ...result }));
  if (!process.argv.includes("--apply") && !process.argv.includes("--verify")) {
    console.log("Dry run only. Keep old keys configured; use --apply to re-encrypt, then --verify before retiring a key.");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await closeDatabases();
}
