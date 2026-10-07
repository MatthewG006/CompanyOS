const errors = [];
const required = ["POSTGRES_PASSWORD", "DATABASE_URL", "APP_URL", "COMPANYOS_ENCRYPTION_KEY", "COMPANYOS_ADMIN_TOKEN", "COMPANYOS_INGEST_TOKEN"];

  for (const name of required) {
  if (!process.env[name]?.trim()) errors.push(`${name} must be set.`);
}

if (process.env.NODE_ENV === "production") {
  for (const name of required) {
    if (process.env[name]?.startsWith("REPLACE_WITH")) errors.push(`${name} still has its setup placeholder.`);
  }
  if (process.env.COMPANYOS_ENCRYPTION_KEY && !/^[a-f0-9]{64}$/i.test(process.env.COMPANYOS_ENCRYPTION_KEY)) {
    errors.push("COMPANYOS_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes). Keep the same key across upgrades and backups.");
  }
  if ((process.env.POSTGRES_PASSWORD ?? "").length < 32) errors.push("POSTGRES_PASSWORD must contain at least 32 characters.");
  for (const name of ["COMPANYOS_ADMIN_TOKEN", "COMPANYOS_INGEST_TOKEN"]) {
    const value = process.env[name] ?? "";
    if (value.length < 32) errors.push(`${name} must contain at least 32 characters.`);
  }
  try {
    const appUrl = new URL(process.env.APP_URL ?? "");
    if (appUrl.protocol !== "https:") errors.push("APP_URL must use https in production.");
    if (appUrl.hostname === "companyos.example.com") errors.push("Replace the example APP_URL with the production HTTPS origin.");
  } catch {
    errors.push("APP_URL must be a valid absolute HTTPS URL in production.");
  }
  try {
    const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
    if (!/^postgres(ql)?:$/.test(databaseUrl.protocol)) errors.push("DATABASE_URL must use the postgres or postgresql scheme.");
    if (databaseUrl.password !== process.env.POSTGRES_PASSWORD) errors.push("DATABASE_URL's password must match POSTGRES_PASSWORD.");
  } catch {
    errors.push("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
}

if (errors.length) {
  console.error("CompanyOS production configuration is incomplete:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
