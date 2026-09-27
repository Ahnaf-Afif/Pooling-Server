import { productionConfigErrors } from "../src/production-config.js";

// Deliberately do not load .env: inspect exactly the deployment environment.
const errors = productionConfigErrors();
if (process.versions.node.split(".")[0] !== "22") errors.push("Use the supported Node 22 runtime");

if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  process.env.NODE_ENV = "production";
  try {
    const { default: app } = await import("../src/app.js");
    const { auth } = await import("../src/auth.js");
    await auth.$context;
    if (typeof app !== "function") throw new Error();
    console.log("Production configuration and Express entrypoint passed. Database, provider credentials and historical voter-key compatibility are NOT verified.");
  } catch {
    // Auth/library initialization errors may contain configuration values.
    console.error("Production entrypoint could not initialize; inspect it securely before deployment");
    process.exitCode = 1;
  } finally {
    const { closeDatabases } = await import("../src/db.js");
    await closeDatabases();
  }
}
