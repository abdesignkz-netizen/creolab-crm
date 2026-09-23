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

export function controlClientStatus(httpStatus: number, code?: string) {
  const reason = String(code || "");
  if (
    httpStatus === 401 ||
    reason === "unauthorized" ||
    reason === "replay_protection" ||
    reason === "identity_not_linked"
  ) {
    return "UNAUTHORIZED";
  }
  if (httpStatus === 403) return "PERMISSION_DENIED";
  if (httpStatus === 404 || reason === "not_found") return "NOT_FOUND";
  if (reason === "ambiguous") return "AMBIGUOUS";
  if (httpStatus === 409 || httpStatus === 422) return "AMBIGUOUS";
  if (httpStatus === 410) return "NOT_FOUND";
  return "CRM_UNAVAILABLE";
}

export function withControlClientFields(
  path: string | undefined,
  httpStatus: number,
  body: Record<string, unknown>,
) {
  if (!String(path || "").includes("/ai-control/")) return body;
  const code = String(body.code || "");
  return {
    ...body,
    status: body.status || controlClientStatus(httpStatus, code),
    errorType: body.errorType || code,
  };
}

export function errorBody(error: unknown, requestId: string) {
  const quota = error instanceof Error ? error.message.match(/BASQAR_LIMIT:([A-Z_]+)/)?.[1] : null;
  if (quota) return { status: 403, body: { code: "limit_exceeded", message: "Достигнут лимит тарифа. Перейдите на Start или увеличьте ресурсы в разделе «Тарифы».", details: { limit: quota, billingPath: "/billing" }, request_id: requestId } };
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
