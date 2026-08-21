/**
 * Clipboard writes can be rejected by WKWebView even when the text is valid.
 * Return the outcome so callers never render "Copied" for an operation that
 * did not happen.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
