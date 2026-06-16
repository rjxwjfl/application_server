class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
  }
}

class BadRequestError extends AppError {
  constructor(message = '잘못된 요청입니다') {
    super(message, 400);
  }
}

class UnauthorizedError extends AppError {
  constructor(message = '인증이 필요합니다') {
    super(message, 401);
  }
}

class ForbiddenError extends AppError {
  constructor(message = '권한이 없습니다') {
    super(message, 403);
  }
}

class NotFoundError extends AppError {
  constructor(message = '리소스를 찾을 수 없습니다') {
    super(message, 404);
  }
}

class ConflictError extends AppError {
  constructor(message = '충돌이 발생했습니다') {
    super(message, 409);
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
