'use strict';

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const badRequest = (msg, details) => new HttpError(400, msg, details);
const notFound = (msg = 'Not found') => new HttpError(404, msg);
const conflict = (msg, details) => new HttpError(409, msg, details);

/** Wraps an async route handler so rejections reach the error middleware. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  // Postgres constraint violations map to something the UI can act on.
  if (err.code === '23505') {
    return res.status(409).json({ error: 'That value already exists', details: err.detail });
  }
  if (err.code === '23503') {
    return res.status(409).json({ error: 'Referenced record does not exist', details: err.detail });
  }
  if (err.code === '23514') {
    return res.status(400).json({ error: 'Value failed a validation constraint', details: err.detail });
  }
  console.error('[error]', err);
  return res.status(500).json({ error: 'Internal server error' });
}

module.exports = { HttpError, badRequest, notFound, conflict, asyncHandler, errorHandler };
