/** Must run from the user's click so ordinary browsers retain popup activation. */
export async function openExternalLink(url: string): Promise<void> {
  if (window.desktop?.isElectron) {
    if (!window.desktop.openExternal)
      throw new Error(
        "Restart the updated Cadence app to open your browser, or copy the sign-in link below.",
      );
    const result = await window.desktop.openExternal(url);
    if (!result.ok) throw new Error(result.error);
    return;
  }
  // Opening about:blank first lets us detect blocking. Using the noopener
  // feature directly can return null even after a successful browser launch.
  const popup = window.open("about:blank", "_blank");
  if (!popup)
    throw new Error(
      "Your browser blocked the sign-in window. Allow popups or copy the sign-in link below.",
    );
  popup.opener = null;
  popup.location.href = url;
}
