import { beforeAll, describe, expect, it } from "bun:test";
import type { UsageResetCredit } from "@oh-my-pi/pi-ai";
import type { NativeNode } from "../src/native/node";
import { type ResetUsageAccount, ResetUsageSelectorComponent } from "../src/overlays/reset-usage-selector";
import { initTheme } from "../src/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function credits(): UsageResetCredit[] {
	const day = 86_400_000;
	const now = Date.now();
	return [
		{ id: "late", status: "available", title: "Late reset", expiresAt: new Date(now + 10 * day).toISOString() },
		{ id: "soon", status: "available", title: "Soon reset", expiresAt: new Date(now + 3 * day).toISOString() },
		{ id: "mid", status: "available", title: "Middle reset", expiresAt: new Date(now + 7 * day).toISOString() },
		{ id: "spent", status: "redeemed", title: "Spent reset", expiresAt: new Date(now + day).toISOString() },
	];
}

function account(credentialId = 1): ResetUsageAccount {
	return {
		label: `fixture-${credentialId}@example.com`,
		provider: "openai-codex",
		providerLabel: "Codex",
		availableCount: 3,
		redeemableCount: 3,
		target: { provider: "openai-codex", credentialId },
		active: credentialId === 1,
		credits: credits(),
	};
}

function findList(root: NativeNode): Extract<NativeNode, { k: "list" }> {
	const pending = [root];
	while (pending.length) {
		const current = pending.pop()!;
		if (current.k === "list") return current;
		for (const child of current.c ?? []) {
			if ("k" in child) pending.push(child);
		}
	}
	throw new Error("Expected reset account list");
}

/** The destructive confirmation is a warning text node, not the muted credit details. */
function confirmationText(selector: ResetUsageSelectorComponent): string | undefined {
	for (const child of selector.describe().c ?? []) {
		if ("k" in child && child.k === "text" && child.p?.spans?.some(span => span.s === "warning")) {
			return child.p.spans.map(span => span.t).join("");
		}
	}
	return undefined;
}

function fixture(accounts = [account()]) {
	const selected: ResetUsageAccount[] = [];
	let cancelled = false;
	const selector = new ResetUsageSelectorComponent(
		accounts,
		row => selected.push(row),
		() => {
			cancelled = true;
		},
	);
	return { selector, selected, cancelled: () => cancelled };
}

function confirm(selector: ResetUsageSelectorComponent): void {
	selector.handleInput("\r");
	selector.handleInput("\r");
}

describe("saved reset credit selector", () => {
	it("defaults to the soonest-expiring usable Codex credit and confirms its metadata and exact pin", () => {
		const input = account();
		const { selector, selected } = fixture([input]);
		expect(findList(selector.describe()).c).toHaveLength(1);
		expect(selector.render(160).join("\n")).toContain("selected 1/3");
		selector.handleInput("\r");
		expect(selected).toEqual([]);
		const confirmation = confirmationText(selector);
		expect(confirmation).toContain("Soon reset");
		expect(confirmation).toContain(new Date(input.credits![1]!.expiresAt!).toLocaleDateString());
		expect(JSON.stringify(selector.describe())).toContain("Soon reset");
		selector.handleInput("\r");
		expect(selected[0]?.target.creditId).toBe("soon");
		expect(selected[0]?.credit?.id).toBe("soon");
		expect(input.target.creditId).toBeUndefined();
	});

	it("cycles forwards and backwards in expiry order without moving the account or leaving native state stale", () => {
		const { selector, selected } = fixture([account(), account(2)]);
		const initial = selector.describe();
		const selectedAccount = findList(initial).p?.selected;
		const check = (index: number, title: string) => {
			const native = selector.describe();
			expect(findList(native).p?.selected).toBe(selectedAccount);
			expect(findList(native).c).toHaveLength(2);
			expect(JSON.stringify(native)).toContain(`selected ${index}/3`);
			expect(selector.render(160).join("\n")).toContain(`selected ${index}/3`);
			expect(JSON.stringify(native)).toContain(title);
		};
		selector.handleInput("\t");
		check(2, "Middle reset");
		selector.handleInput("\t");
		check(3, "Late reset");
		selector.handleInput("\t");
		check(1, "Soon reset");
		selector.handleInput("\x1b[Z");
		check(3, "Late reset");
		confirm(selector);
		expect(selected[0]?.target).toMatchObject({ credentialId: 1, creditId: "late" });
	});

	it("cancels the old destructive confirmation on Tab and requires two fresh Enters for the new exact credit", () => {
		const { selector, selected } = fixture();
		selector.handleInput("\r");
		expect(confirmationText(selector)).toContain("Soon reset");
		selector.handleInput("\t");
		expect(confirmationText(selector)).toBeUndefined();
		selector.handleInput("\r");
		expect(selected).toEqual([]);
		expect(selector.render(160).join("\n")).toContain("Middle reset");
		selector.handleInput("\r");
		expect(selected[0]?.target.creditId).toBe("mid");
		expect(selected[0]?.credit?.id).toBe("mid");
	});

	it("retains each account's credit when navigating and Escape cancels without spending", () => {
		const { selector, selected, cancelled } = fixture([account(), account(2)]);
		selector.handleInput("\t");
		selector.handleInput("\x1b[B");
		selector.handleInput("\t");
		selector.handleInput("\t");
		selector.handleInput("\x1b[A");
		selector.handleInput("\r");
		expect(selector.render(160).join("\n")).toContain("Middle reset");
		expect(confirmationText(selector)).toContain("Middle reset");
		selector.handleInput("\x1b");
		expect(confirmationText(selector)).toBeUndefined();
		selector.handleInput("\x1b");
		expect(cancelled()).toBe(true);
		expect(selected).toEqual([]);
	});

	it("does not cycle Claude's provider-selected grant or cancel its confirmation on Tab", () => {
		const claude = {
			...account(),
			provider: "anthropic",
			providerLabel: "Claude",
			target: { provider: "anthropic", credentialId: 1, creditId: "late" },
			credit: { ...credits()[0]!, program: "juniper_tide" },
		};
		const { selector, selected } = fixture([claude]);
		selector.handleInput("\r");
		selector.handleInput("\t");
		selector.handleInput("\x1b[Z");
		expect(JSON.stringify(selector.describe())).not.toContain("selected 1/3");
		expect(selector.render(160).join("\n")).toContain("5h session limit only");
		selector.handleInput("\r");
		expect(selected[0]?.target.creditId).toBe("late");
	});
});
