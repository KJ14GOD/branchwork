/** Shared by every hook that reads the worker's `{ error }` shape on a non-2xx response. */
export const readError = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: string };

    return body.error ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
};
