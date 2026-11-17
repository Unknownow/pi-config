/** Pure parts of the local menus (`askUser`) and waits; see README.md. */

export interface MenuRequest {
	title: string;
	options: string[];
	/** Called before the menu is shown. */
	localNotice?: () => void;
	/** Show no menu: the caller's notice is all there is. */
	skipLocal?: boolean;
}

export interface MenuDeps {
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(title: string): void;
}

/** The menu of `askUser`: notifies the person, then asks. */
export async function askMenu(deps: MenuDeps, req: MenuRequest): Promise<string | undefined> {
	req.localNotice?.();
	if (req.skipLocal) return undefined;
	deps.notify(req.title);
	return deps.select(req.title, req.options);
}

/** The message that resumes the executor after a wait. */
export function resumeContent(prefix: string, held: string | undefined, text: string | undefined): string {
	return `${prefix}\n\n${held ? `${held}\n\n` : ""}${text ?? "Continue with the open steps of the plan."}`;
}

export const PLAN_APPROVE = "Approve";
export const PLAN_ARBITER = "Approve, arbiter solves plan flaws →";
export const PLAN_BACK = "Back to discussion";

/** The plan menu: its options. `skipLocal`: with planPrompt off no menu shows. */
export function planMenuRequest(o: { blocked: boolean; planFlawAsk: boolean; planPrompt: boolean }): { options: string[]; skipLocal: boolean } {
	const options = [...(o.blocked ? [] : [PLAN_APPROVE, ...(o.planFlawAsk ? [PLAN_ARBITER] : [])]), PLAN_BACK, "Keep discussing"];
	return { options, skipLocal: !o.planPrompt };
}
