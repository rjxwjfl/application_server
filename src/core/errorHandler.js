const logger = require('../utils/logger');

function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode || err.status || 500;
  const message = err.message || 'Internal Server Error';
  const isOperational = err.isOperational === true;

  if (isOperational) {
    logger.warn(message, {
      endpoint: `${req.method} ${req.originalUrl}`,
      statusCode,
    });
  } else {
    logger.error(message, {
      endpoint: `${req.method} ${req.originalUrl}`,
      statusCode,
      stack: err.stack,
    });
  }

  res.status(statusCode).json({
    success: false,
    statusCode,
    message,
    ...(process.env.NODE_ENV !== 'production' && !isOperational && { stack: err.stack }),
  });
}

module.exports = errorHandler;
