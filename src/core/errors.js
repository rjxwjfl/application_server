class AppError extends Error {
  constructor(message, statusCode, errorCode = null) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.isOperational = true;
  }
}

class BadRequestError extends AppError {
  constructor(message = '잘못된 요청입니다', errorCode = null) {
    super(message, 400, errorCode);
  }
}

class UnauthorizedError extends AppError {
  constructor(message = '인증이 필요합니다', errorCode = 'UNAUTHORIZED') {
    super(message, 401, errorCode);
  }
}

class ForbiddenError extends AppError {
  constructor(message = '권한이 없습니다', errorCode = null) {
    super(message, 403, errorCode);
  }
}

class NotFoundError extends AppError {
  constructor(message = '리소스를 찾을 수 없습니다', errorCode = null) {
    super(message, 404, errorCode);
  }
}

class ConflictError extends AppError {
  constructor(message = '충돌이 발생했습니다', errorCode = null) {
    super(message, 409, errorCode);
  }
}

module.exports = {
  AppError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
};
