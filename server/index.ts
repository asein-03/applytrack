import { startServer } from './runtime.js';

const services = await startServer({ production: process.argv.includes('--production') });
console.info(`Apply API: http://127.0.0.1:${process.env.PORT ?? 4318}`);
const shutdown = () => {
  void services.stop().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
