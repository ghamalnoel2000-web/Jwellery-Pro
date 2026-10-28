'use strict';

/** An error whose message is safe to show to the user. */
class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = {
  AppError,
  badRequest: (message) => new AppError(400, message),
  unauthorized: (message) => new AppError(401, message),
  forbidden: (message) => new AppError(403, message),
  notFound: (message) => new AppError(404, message),
  rule: (message) => new AppError(422, message)
};
