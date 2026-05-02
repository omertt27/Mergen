import pino from 'pino';

/**
 * All logs go to stderr (fd 2) so they never pollute the MCP stdio transport
 * that runs on stdout.
 */
const logger = pino(
  {
    name: 'mergen',
    level: process.env.LOG_LEVEL ?? 'info',
  },
  pino.destination(2) // stderr
);

export default logger;
