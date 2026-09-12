import { buildApp } from "./app.js";
import { createAppContext } from "./context.js";

const context = await createAppContext();
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
