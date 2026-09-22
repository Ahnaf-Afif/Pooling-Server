const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export function getConfig() {
  return {
    port: Number(process.env.PORT) || 5000,
    mongoUri: required("MONGODB_URI"),
    clientOrigins: getClientOrigins(),
  };
}

export function getClientOrigins() {
  const configured = (process.env.CLIENT_ORIGINS || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return [...new Set([...configured, "https://pooling-client.vercel.app"])];
}
