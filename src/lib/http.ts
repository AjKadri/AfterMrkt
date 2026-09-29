export type RawHttpResponse = {
  url: string;
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  receivedAt: string;
};

export type RequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
};

export async function requestRaw(
  url: string,
  options: RequestOptions = {},
): Promise<RawHttpResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

  try {
    const requestInit: RequestInit = {
      method: options.method ?? 'GET',
      signal: controller.signal,
    };
    if (options.headers !== undefined) {
      requestInit.headers = options.headers;
    }
    if (options.body !== undefined) {
      requestInit.body = options.body;
    }
    const response = await fetch(url, requestInit);
    const bodyText = await response.text();
    return {
      url,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      bodyText,
      receivedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function parseJsonBody(bodyText: string): unknown {
  return JSON.parse(bodyText) as unknown;
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
