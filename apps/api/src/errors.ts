export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fieldErrors?: Record<string, string>,
    public details?: unknown,
  ) {
    super(message);
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
