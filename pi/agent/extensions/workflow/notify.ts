/** Desktop notifications when a session needs the user. Pure helpers; index.ts spawns the command. */

/** Minimum time between two notifications from one session. */
export const NOTIFY_GAP_MS = 15_000;

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

/** Why the session is idle, for the notification text. */
export function idleReason(o: { phase: string; waiting?: string }): string {
	if (o.waiting) return `waiting for you: ${o.waiting}`;
	if (o.phase === "discuss") return "discuss reply ready";
	return o.phase === "plan" ? "plan reply ready" : "turn finished";
}

/** Whether a notification may be shown now. */
export function notifyDue(o: { enabled: boolean; hasUI: boolean; now: number; last?: number }): boolean {
	if (!o.enabled || !o.hasUI) return false;
	return o.last === undefined || o.now - o.last >= NOTIFY_GAP_MS;
}
