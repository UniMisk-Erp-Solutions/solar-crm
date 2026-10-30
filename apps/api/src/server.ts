import { createApp } from './app';
import { createDeps } from './bootstrap';
import { startJobs } from './jobs';

const deps = createDeps();
const app = createApp(deps);
const jobs = deps.config.RUN_JOBS ? startJobs(deps) : null;

const server = app.listen(deps.config.PORT, () => {
  deps.log.info(`Future Solar CRM API listening on :${deps.config.PORT} (${deps.config.demo ? 'demo mode' : 'live mode'})`);
});

const shutdown = (signal: string) => {
  deps.log.info(`${signal} received — shutting down`);
  jobs?.stop();
  server.close(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
