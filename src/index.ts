import { startServer } from "./server";
import { materializeEnvFiles } from "./envFiles";
import { log } from "./logger";

process.on("unhandledRejection", (err) => {
  log("unhandled_rejection", { error: String(err) });
});
process.on("uncaughtException", (err) => {
  log("uncaught_exception", { error: String(err) });
});

materializeEnvFiles(); // drop each project's env vars as .env files into its repo folders
startServer();
