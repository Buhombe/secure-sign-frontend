'use strict';
module.exports = function httpsOnly(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();
  return res.redirect(301, 'https://' + req.headers.host + req.url);
};
