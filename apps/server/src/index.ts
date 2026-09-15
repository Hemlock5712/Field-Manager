import { buildApp } from "./app.js";
import { createAppContext, createProductionAppContext } from "./context.js";

const mode = process.env.FIELD_MANAGER_MODE?.trim() || "mock";
if (mode !== "mock" && mode !== "production")
  throw new TypeError("FIELD_MANAGER_MODE must be mock or production");
const context =
  mode === "production"
    ? await createProductionAppContext()
    : await createAppContext();
const app = await buildApp(context);
const port = Number(process.env.PORT ?? 3000);

const shutdown = async () => {
  await app.close();
  context.database.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: process.env.HOST ?? "0.0.0.0", port });
