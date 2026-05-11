'use strict';

/**
 * auditMiddleware.js
 *
 * Automatically logs every completed API request to the audit trail.
 *
 * Runs on res.on('finish') so it captures the final HTTP status code.
 * Does NOT log:
 *   - GET /api/health  (noise)
 *   - OPTIONS          (CORS preflight)
 *   - 4xx on static    (irrelevant)
 *
 * The route-level audit calls (SIGN, UPLOAD, etc.) remain in place for
 * rich context. This middleware fills the gaps — it catches actions that
 * routes don't explicitly log (unexpected errors, rate-limit hits, etc.).
 *
 * It maps HTTP method + path pattern to an action string so the audit
 * trail has consistent action names rather than raw paths.
 */

const { log, ACTIONS } = require('../services/auditService');

// Maps [method, pathPattern] → action
// Checked in order — first match wins.
const ROUTE_ACTION_MAP = [
  [/^POST$/,   /\/auth\/signup$/,           ACTIONS.SIGNUP],
  [/^POST$/,   /\/auth\/login$/,            ACTIONS.LOGIN],
  [/^POST$/,   /\/auth\/logout-all$/,       ACTIONS.LOGOUT_ALL],
  [/^POST$/,   /\/auth\/logout$/,           ACTIONS.LOGOUT],
  [/^POST$/,   /\/auth\/refresh$/,          ACTIONS.TOKEN_REFRESH],
  [/^POST$/,   /\/auth\/mfa\/verify$/,      ACTIONS.MFA_ENABLED],
  [/^POST$/,   /\/auth\/mfa\/authenticate$/,ACTIONS.MFA_AUTH],
  [/^POST$/,   /\/documents\/upload$/,      ACTIONS.UPLOAD],
  [/^GET$/,    /\/documents\/[^/]+\/file\/public$/, ACTIONS.DOWNLOAD_PUBLIC],
  [/^GET$/,    /\/documents\/[^/]+\/file$/, ACTIONS.DOWNLOAD],
  [/^GET$/,    /\/documents\/[^/]+$/,       ACTIONS.VIEW],
  [/^POST$/,   /\/documents\/[^/]+\/sign$/, ACTIONS.SIGN],
  [/^GET$/,    /\/signatures\/[^/]+\/verify/, ACTIONS.VERIFY],
];

function resolveAction(method, path) {
  for (const [methodRe, pathRe, action] of ROUTE_ACTION_MAP) {
    if (methodRe.test(method) && pathRe.test(path)) return action;
  }
  return null;   // unmapped routes are not auto-logged
}

module.exports = function auditMiddleware(req, res, next) {
  // Skip health check and preflight
  if (req.path === '/api/health' || req.method === 'OPTIONS') return next();

  res.on('finish', () => {
    const action = resolveAction(req.method, req.path);
    if (!action) return;

    // Only log if route-level logging won't already cover this
    // (route-level logs have richer context — don't double-log successes)
    // We auto-log: failures (4xx/5xx) and rate limit hits (429)
    const isFailure = res.statusCode >= 400;
    const isSuccess = res.statusCode < 300;

    // For sensitive auth actions always log failures
    // For other actions only log if not already logged by route handler
    const alwaysLog = [
      ACTIONS.LOGIN, ACTIONS.SIGNUP, ACTIONS.MFA_AUTH,
      ACTIONS.TOKEN_REFRESH,
    ].includes(action);

    if (!isFailure && !alwaysLog) return;

    const userId = req.user?.id || null;

    log({
      userId,
      action:     isFailure ? `${action}_FAILED` : action,
      ipAddress:  req.ip,
      deviceInfo: req.headers['user-agent'],
      metadata: {
        status:  res.statusCode,
        method:  req.method,
        path:    req.path,    // never req.originalUrl — no query strings
      },
    }).catch(() => {});   // non-blocking
  });

  next();
};