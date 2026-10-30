import pino, { type Logger } from 'pino';

export type { Logger };

/** PII never reaches logs: mobile, e-mail, tokens and addresses are redacted. */
const REDACT = [
  'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]',
  '*.mobile', '*.phone', '*.email', '*.password', '*.token', '*.access_token', '*.billing_address', '*.shipping_address', '*.aadhaar*',
  'body.mobile', 'body.email', 'body.phone',
];

export function createLogger(level = 'info', pretty = false): Logger {
  return pino({
    level,
    redact: { paths: REDACT, censor: '[redacted]' },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } } : {}),
  });
}
