import { startServer } from "./server";
import { log } from "./logger";

process.on("unhandledRejection", (err) => {
  log("unhandled_rejection", { error: String(err) });
});
process.on("uncaughtException", (err) => {
  log("uncaught_exception", { error: String(err) });
});

startServer();
