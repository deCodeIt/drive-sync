import * as winston from 'winston';
import * as path from 'path';
import * as fs from 'fs';

// Ensure logs directory exists
const logsDir = path.resolve(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Custom format for structured logging
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Console format for human-readable output
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
  })
);

// Create logger instance
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: { service: 'drive-sync' },
  transports: [
    // Write all logs to combined.log
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 104857600, // 100MB
      maxFiles: 5,
    }),
    // Write errors to error.log
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 104857600, // 100MB
      maxFiles: 5,
    }),
    // Write failures to failures.log for easy tracking
    new winston.transports.File({
      filename: path.join(logsDir, 'failures.log'),
      level: 'error',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.json()
      ),
      maxsize: 104857600, // 100MB
      maxFiles: 10,
    }),
  ],
});

// Add console transport in development or if LOG_CONSOLE is set
if (process.env.NODE_ENV !== 'production' || process.env.LOG_CONSOLE === 'true') {
  logger.add(
    new winston.transports.Console({
      format: consoleFormat,
    })
  );
}

// Helper functions for structured logging with context
export const logWithContext = {
  info: (message: string, context?: Record<string, unknown>) => {
    logger.info(message, context);
  },
  warn: (message: string, context?: Record<string, unknown>) => {
    logger.warn(message, context);
  },
  error: (message: string, error?: Error | unknown, context?: Record<string, unknown>) => {
    const errorContext = {
      ...context,
      error: error instanceof Error ? {
        message: error.message,
        stack: error.stack,
        name: error.name,
      } : error,
    };
    logger.error(message, errorContext);
  },
  debug: (message: string, context?: Record<string, unknown>) => {
    logger.debug(message, context);
  },
};

export default logger;

