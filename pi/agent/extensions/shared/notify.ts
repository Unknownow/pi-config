/** Desktop notification command per platform. Pure; callers spawn it. */

const xmlEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/['‘’‚‛]/g, "&apos;");

/** The program and arguments that show a notification on this platform; null when the platform has none. */
export function notifyCommand(platform: NodeJS.Platform, title: string, body: string): { command: string; args: string[] } | null {
	if (platform === "win32") {
		// InnerXml takes XML, so escape the markup characters; single quotes are doubled for the PowerShell string.
		const ps = (s: string) => xmlEscape(s).replace(/'/g, "''");
		const script = [
			"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
			"$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
			"$n = $t.GetElementsByTagName('text')",
			`$n.Item(0).InnerXml = '${ps(title)}'`,
			`$n.Item(1).InnerXml = '${ps(body)}'`,
			"$toast = [Windows.UI.Notifications.ToastNotification]::new($t)",
			"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)",
		].join("; ");
		return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script] };
	}
	if (platform === "darwin") {
		const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		return { command: "osascript", args: ["-e", `display notification "${q(body)}" with title "${q(title)}"`] };
	}
	if (platform === "linux") return { command: "notify-send", args: [title, body] };
	return null;
}
