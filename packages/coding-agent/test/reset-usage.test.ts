import { describe, expect, it } from "bun:test";
import type { ResetCreditAccountStatus } from "@oh-my-pi/pi-ai/auth-storage";
import { toResetUsageAccounts } from "../src/slash-commands/helpers/reset-usage";

const status: ResetCreditAccountStatus = {
	provider: "openai-codex",
	credentialId: 1,
	email: "fixture@example.com",
	active: true,
	availableCount: 3,
	credits: [
		{ id: "late", status: "available", expiresAt: "2099-01-10T00:00:00Z", title: "Late reset" },
		{ id: "soon", status: "available", expiresAt: "2099-01-03T00:00:00Z", title: "Soon reset" },
		{ id: "mid", status: "available", expiresAt: "2099-01-07T00:00:00Z", title: "Middle reset" },
	],
};

describe("saved reset account targets", () => {
	it("pins the soonest-expiring Codex credit and shows that exact credit's metadata in one account row", () => {
		const rows = toResetUsageAccounts([status]);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.target.creditId).toBe("soon");
		expect(rows[0]?.credit).toMatchObject({
			id: "soon",
			title: "Soon reset",
			expiresAt: status.credits[1]?.expiresAt,
		});
		expect(rows[0]?.expiresAt).toBe(status.credits[1]?.expiresAt);
	});

	it("disables a Codex account with no usable exact credit despite an advertised balance", () => {
		const [row] = toResetUsageAccounts([{ ...status, credits: [{ id: "spent", status: "redeemed" }] }]);
		expect(row?.redeemableCount).toBe(0);
		expect(row?.target.creditId).toBeUndefined();
	});

	it("keeps Claude's provider-selected grant even when another grant expires sooner", () => {
		const [row] = toResetUsageAccounts([
			{
				...status,
				provider: "anthropic",
				nextCreditId: "late",
				eligible: true,
				redeemableCount: 1,
			},
		]);
		expect(row?.target.creditId).toBe("late");
		expect(row?.credit?.id).toBe("late");
		expect(row?.redeemableCount).toBe(1);
	});

	it("does not turn a missing Claude grant pin into arbitrary selection", () => {
		const [row] = toResetUsageAccounts([{ ...status, provider: "anthropic", eligible: true, redeemableCount: 1 }]);
		expect(row?.target.creditId).toBeUndefined();
		expect(row?.redeemableCount).toBe(0);
	});
});
