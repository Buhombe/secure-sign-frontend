'use strict';

/**
 * logger.js — HakikiSign Structured JSON Logger
 *
 * Extracted from index.js so redis.js and rateLimiter.js can share it
 * without creating a circular dependency through index.js.
 *
 * All logs are emitted as newline-delimited JSON to stdout/stderr,
 * which Railway's log aggregation system ingests natively. This format
 * is also compatible with Datadog, Logtail, and any SIEM that speaks NDJSON.
 *
 * Log levels: http | info | warn | error
 *
 * SECURITY: never log passwords, tokens, or secrets. Callers are responsible
 * for sanitising `meta` before passing it here.
 */

const ENV = process.env.NODE_ENV || 'development';

const logger = {
  info: (msg, meta = {}) =>
    console.log(JSON.stringify({ level: 'info',  msg, ...meta, time: new Date().toISOString(), env: ENV })),

  warn: (msg, meta = {}) =>
    console.warn(JSON.stringify({ level: 'warn',  msg, ...meta, time: new Date().toISOString(), env: ENV })),

  error: (msg, meta = {}) =>
    console.error(JSON.stringify({ level: 'error', msg, ...meta, time: new Date().toISOString(), env: ENV })),

  http: (method, path, status, ms) =>
    console.log(JSON.stringify({ level: 'http', method, path, status, ms, time: new Date().toISOString() })),

  /**
   * security() — dedicated channel for abuse and rate-limit events.
   *
   * These are the events you'd want to route to a SIEM or PagerDuty alert:
   *   - brute-force detected
   *   - rate limit triggered on auth endpoints
   *   - IP blocked
   *   - suspicious MFA activity
   *
   * They always include: event, ip, path, userId (if available), and a
   * human-readable description.
   */
  security: (event, meta = {}) =>
    console.warn(JSON.stringify({
      level:  'security',
      event,
      ...meta,
      time:   new Date().toISOString(),
      env:    ENV,
    })),
};

module.exports = logger;
