import "dotenv/config";

import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";

import { auth } from "../src/auth.js";
import { closeDatabases, connectDatabase, getMongoDatabase } from "../src/db.js";

const apply = process.argv.includes("--apply");
const tokenFields = ["accessToken", "refreshToken", "idToken"];

async function plaintextToken(value, secretConfig) {
  if (!value || value.startsWith("$ba$")) return null;
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) return value;
  try {
    return await symmetricDecrypt({ key: secretConfig, data: value });
  } catch {
    return value;
  }
}

try {
  await connectDatabase();
  const { secretConfig } = await auth.$context;
  const accounts = getMongoDatabase().collection("account");
  const cursor = accounts.find({}, { projection: Object.fromEntries(tokenFields.map((field) => [field, 1])) });
  let accountCount = 0;
  let tokenCount = 0;

  for await (const account of cursor) {
    const encrypted = {};
    for (const field of tokenFields) {
      const plaintext = await plaintextToken(account[field], secretConfig);
      if (!plaintext) continue;
      encrypted[field] = await symmetricEncrypt({ key: secretConfig, data: plaintext });
      tokenCount += 1;
    }
    if (!Object.keys(encrypted).length) continue;
    accountCount += 1;
    if (apply) await accounts.updateOne({ _id: account._id }, { $set: encrypted });
  }

  console.log(`${apply ? "Encrypted" : "Found"} ${tokenCount} OAuth token fields across ${accountCount} accounts`);
  if (!apply) console.log("Dry run complete; add --apply after deploying token encryption support");
} finally {
  await closeDatabases();
}
