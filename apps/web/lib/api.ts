const API_BASE = '/api';

export class ApiError extends Error {
  readonly status: number;
  readonly data: unknown;

  constructor(status: number, message: string, data: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

async function readBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';

  if (!contentType.includes('application/json')) {
    const text = await response.text();
    return text.length > 0 ? text : null;
  }

  return response.json();
}

function messageFromBody(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null) {
    const error = (body as Record<string, unknown>).error;
    if (typeof error === 'string' && error.length > 0) {
      return error;
    }
  }

  return fallback;
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const body = await readBody(response);

  if (!response.ok) {
    throw new ApiError(
      response.status,
      messageFromBody(body, `Request failed (${response.status})`),
      body,
    );
  }

  return body as T;
}

export async function apiPost<T>(
  path: string,
  payload: unknown,
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await readBody(response);

  if (!response.ok) {
    throw new ApiError(
      response.status,
      messageFromBody(body, `Request failed (${response.status})`),
      body,
    );
  }

  return body as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Something went wrong';
}
