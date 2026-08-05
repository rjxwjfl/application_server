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

class PaymentRequiredError extends AppError {
  constructor(message = '결제가 필요합니다', errorCode = null) {
    super(message, 402, errorCode);
  }
}

class GoneError extends AppError {
  constructor(message = '더 이상 지원되지 않는 요청입니다', errorCode = null) {
    super(message, 410, errorCode);
  }
}

class NotImplementedError extends AppError {
  constructor(message = '아직 지원되지 않는 기능입니다', errorCode = null) {
    super(message, 501, errorCode);
  }
}

// RLY-20260806-015 — media.md §4-3(confirm 실제 크기 재확인 계약)의 "±10% 초과 시 422" 명시값.
class UnprocessableEntityError extends AppError {
  constructor(message = '요청을 처리할 수 없습니다', errorCode = null) {
    super(message, 422, errorCode);
  }
}

// RLY-20260806-015 — GCS 메타데이터 조회 실패(네트워크·권한 등 일시적 장애) 시 선언값으로
// 조용히 대체하지 않고 클라이언트가 재시도할 수 있도록 명시적으로 알린다.
class ServiceUnavailableError extends AppError {
  constructor(message = '일시적으로 처리할 수 없습니다. 잠시 후 다시 시도해주세요', errorCode = null) {
    super(message, 503, errorCode);
  }
}

module.exports = {
  AppError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  PaymentRequiredError,
  GoneError,
  NotImplementedError,
  UnprocessableEntityError,
  ServiceUnavailableError,
};
