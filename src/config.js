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
  const configured = (process.env.CLIENT_ORIGINS || (process.env.NODE_ENV === "production" ? "" : "http://localhost:3000"))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  // Production origins must be explicit; never add a development or old hostname.
  return [...new Set(process.env.NODE_ENV === "production"
    ? configured
    : [...configured, "https://pooling-client.vercel.app"])];
}
