'use strict';

function sleep(host, ms) {
  if (host && typeof host._sleep === 'function') return host._sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableHttpStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

async function fetchWithTimeout(host, url, options, timeoutMs) {
  // Prefer aborting the underlying request when supported.
  if (typeof AbortController === 'function') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // Fallback: race without abort.
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Fetch timeout after ${timeoutMs}ms`)), timeoutMs)),
  ]);
}

async function fetchWithRetry(host, url, options, {
  timeoutMs = 10000,
  maxAttempts = 3,
  baseDelayMs = 1000,
  maxDelayMs = 15000,
} = {}) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchWithTimeout(host, url, options, timeoutMs);
      if (!response || typeof response.ok !== 'boolean') {
        throw new Error('Unexpected fetch response');
      }

      if (!response.ok) {
        const { status } = response;
        const { statusText } = response;
        const error = new Error(`HTTP ${status} ${statusText}`);
        error.httpStatus = status;

        if (isRetriableHttpStatus(status) && attempt < maxAttempts) {
          lastError = error;
        } else {
          throw error;
        }
      } else {
        return response;
      }
    } catch (error) {
      lastError = error;
      const isAbort = error && (error.name === 'AbortError' || /aborted/i.test(String(error.message)));
      const httpStatus = error && error.httpStatus;
      const retriable = isAbort || (typeof httpStatus === 'number' && isRetriableHttpStatus(httpStatus));

      if (!retriable || attempt >= maxAttempts) {
        throw lastError;
      }
    }

    const jitterMs = Math.floor(Math.random() * 250);
    const expDelay = baseDelayMs * (2 ** (attempt - 1));
    const delay = Math.min(maxDelayMs, expDelay + jitterMs);
    await sleep(host, delay);
  }

  throw lastError || new Error('Fetch failed');
}

module.exports = {
  fetchWithRetry,
};
