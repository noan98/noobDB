/**
 * Copy text to the clipboard, falling back to execCommand on older webviews.
 * Returns true when the copy succeeded via either method, false when both failed.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      // execCommand not supported in this environment
    }
    document.body.removeChild(ta);
    return ok;
  }
}
