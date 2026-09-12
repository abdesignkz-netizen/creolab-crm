export class ApiError extends Error {
  public status: number;
  public code: string;
  public fieldErrors?: Record<string, string>;
  public details?: unknown;
  constructor(
    status: number,
    code: string,
    message: string,
    fieldErrors?: Record<string, string>,
    details?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
    this.details = details;
  }
}

export function errorBody(error: unknown, requestId: string) {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      body: {
        code: error.code,
        message: error.message,
        field_errors: error.fieldErrors,
        details: error.details,
        request_id: requestId,
      },
    };
  }
  return {
    status: 500,
    body: {
      code: "internal_error",
      message: "Внутренняя ошибка сервера",
      request_id: requestId,
    },
  };
}
