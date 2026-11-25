import type { ErrorRequestHandler } from "express";

class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function httpError(statusCode: number, message: string): HttpError {
  return new HttpError(statusCode, message);
}

export const errorMiddleware: ErrorRequestHandler = (error, _req, res, _next) => {
  void _next;

  if (error instanceof HttpError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }

  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number" &&
    error.status >= 400 &&
    error.status < 500
      ? error.status
      : 500;

  res
    .status(status)
    .json({ error: status < 500 ? "Invalid request" : "Internal server error" });
};
