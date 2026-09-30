import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AuthStorage,
	type OAuthCredential,
	registerOAuthProvider,
	SqliteAuthCredentialStore,
	unregisterOAuthProviders,
} from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	AuthBrokerError,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import { removeWithRetries } from "../../utils/src/temp";

const DISABLE_CAUSE =
	'oauth refresh failed: OAuthError: Anthropic token refresh request failed. url=https://api.anthropic.com/v1/oauth/token; body={"error": "invalid_grant", "error_description": "Refresh token expired"}';

function mintOAuth(email: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${email}`,
		refresh: `refresh-${email}`,
		expires: Date.now() + 60_000,
		email,
		accountId: `account-${email}`,
	};
}

describe("disabled credential tombstones", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-disabled-creds-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store);
		await storage.credentials.reload();
	});

	afterEach(async () => {
		storage?.close();
		vi.restoreAllMocks();
		await removeWithRetries(tempDir);
	});

	test("sqlite store lists identity + cause + disabledAtMs and never token material", async () => {
		await store!.saveOAuth("anthropic", mintOAuth("dead@example.test"));
		await store!.saveOAuth("openai-codex", mintOAuth("alive@example.test"));
		const row = store!.listAuthCredentials("anthropic")[0];
		await store!.deleteAuthCredential(row.id, DISABLE_CAUSE);

		const all = await storage!.credentials.listDisabled();
		expect(all).toHaveLength(1);
		const summary = all[0];
		expect(summary).toMatchObject({
			id: row.id,
			provider: "anthropic",
			type: "oauth",
			email: "dead@example.test",
			accountId: "account-dead@example.test",
			cause: DISABLE_CAUSE,
		});
		expect(typeof summary.disabledAtMs).toBe("number");
		// Tombstones are display-only: no token bytes may leak through them.
		const serialized = JSON.stringify(summary);
		expect(serialized).not.toContain("access-dead");
		expect(serialized).not.toContain("refresh-dead");

		// Provider filter is exact; a provider with only active rows yields [].
		expect(await storage!.credentials.listDisabled("anthropic")).toHaveLength(1);
		expect(await storage!.credentials.listDisabled("openai-codex")).toHaveLength(0);
	});

	test("sqlite disable returns false for missing or already-disabled rows without overwriting the tombstone", async () => {
		await store!.saveOAuth("anthropic", mintOAuth("once@example.test"));
		const row = store!.listAuthCredentials("anthropic")[0];
		expect(await store!.deleteAuthCredential(row.id + 1, "missing")).toBe(false);
		expect(await store!.deleteAuthCredential(row.id, "original cause")).toBe(true);
		expect(await store!.deleteAuthCredential(row.id, "later cause")).toBe(false);
		expect((await store!.listDisabledCredentials("anthropic"))[0]?.cause).toBe("original cause");
	});

	test("removeById permanently removes a disabled identity without refreshing or probing it", async () => {
		const provider = "test-logout-account";
		const refresh = vi.fn(async () => {
			throw new Error("unexpected OAuth refresh");
		});
		const fetchUsage = vi.fn(async () => {
			throw new Error("unexpected account authentication");
		});
		const guardedStorage = new AuthStorage(store!, { refreshOAuthCredential: refresh });
		guardedStorage.usage.setProvider(provider, {
			id: provider,
			supports: () => true,
			fetchUsage,
		});
		await store!.saveOAuth(provider, {
			...mintOAuth("disabled@example.test"),
			expires: 0,
			projectId: "project-disabled",
		});
		const row = store!.listAuthCredentials(provider)[0]!;
		expect(await store!.deleteAuthCredential(row.id, DISABLE_CAUSE)).toBe(true);
		await guardedStorage.credentials.reload();
		expect(await guardedStorage.credentials.listDisabled(provider)).toEqual([
			expect.objectContaining({ id: row.id, projectId: "project-disabled", cause: DISABLE_CAUSE }),
		]);

		expect(await guardedStorage.credentials.removeById(`${provider}-other`, row.id)).toBe(false);
		expect(await guardedStorage.credentials.removeById(provider, Number.MAX_SAFE_INTEGER)).toBe(false);
		expect(await guardedStorage.credentials.removeById(provider, row.id)).toBe(true);
		expect(await guardedStorage.credentials.listDisabled(provider)).toEqual([]);
		expect(await guardedStorage.credentials.removeById(provider, row.id)).toBe(false);
		expect(guardedStorage.credentials.list(provider)).toEqual([]);
		expect(await guardedStorage.usage.reports()).toEqual([]);
		expect(refresh).not.toHaveBeenCalled();
		expect(fetchUsage).not.toHaveBeenCalled();
		guardedStorage.close();
	});

	test("removeById surfaces persistence failures and leaves the active pool unchanged", async () => {
		await storage!.credentials.set("test-logout-account", mintOAuth("kept@example.test"));
		const before = storage!.credentials.list();
		const failure = new Error("database locked");
		vi.spyOn(store!, "deleteAuthCredential").mockRejectedValueOnce(failure);
		await expect(storage!.credentials.removeById(before[0]!.provider, before[0]!.id)).rejects.toThrow(failure);
		expect(storage!.credentials.list()).toEqual(before);
		expect(store!.listAuthCredentials()).toEqual(before);
	});

	test("sqlite removal rejects database failures instead of reporting a missing row", async () => {
		await store!.saveOAuth("test-logout-account", mintOAuth("closed@example.test"));
		const id = store!.listAuthCredentials()[0]!.id;
		store!.close();
		await expect(store!.deleteAuthCredential(id, "deleted by user")).rejects.toThrow();
	});

	test("client maps a broker without the endpoint (404) to an empty list", async () => {
		const fetchImpl: typeof fetch = Object.assign(async () => new Response("not found", { status: 404 }), {
			preconnect: fetch.preconnect,
		});
		const client = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused", fetchImpl });
		expect(await client.listDisabledCredentials()).toEqual([]);
	});
});

describe("broker /v1/credentials/disabled round-trip", () => {
	let tempDir = "";
	let serverStore: SqliteAuthCredentialStore | undefined;
	let serverStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let clientStorage: AuthStorage | undefined;
	const token = "disabled-creds-bearer";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-disabled-"));
		serverStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "broker.db"));
		serverStorage = new AuthStorage(serverStore);
		await serverStorage.credentials.reload();
		handle = startAuthBroker({
			storage: serverStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
		clientStorage = new AuthStorage(
			new RemoteAuthCredentialStore({
				client: new AuthBrokerClient({ url: handle.url, token }),
				streamSnapshots: false,
			}),
		);
		await clientStorage.credentials.reload();
	});

	afterEach(async () => {
		clientStorage?.close();
		await handle?.close();
		serverStorage?.close();
		vi.restoreAllMocks();
		await removeWithRetries(tempDir);
	});

	test("a row disabled on the broker surfaces to remote clients as a tombstone", async () => {
		await serverStore!.saveOAuth("anthropic", mintOAuth("gone@example.test"));
		const row = serverStore!.listAuthCredentials("anthropic")[0];
		await serverStore!.deleteAuthCredential(row.id, DISABLE_CAUSE);

		const disabled = await clientStorage!.credentials.listDisabled("anthropic");
		expect(disabled).toHaveLength(1);
		expect(disabled[0]).toMatchObject({
			id: row.id,
			provider: "anthropic",
			type: "oauth",
			email: "gone@example.test",
			cause: DISABLE_CAUSE,
		});
		expect(JSON.stringify(disabled[0])).not.toContain("refresh-gone");
	});

	test("remote removal hard-deletes exactly one active row and preserves its sibling", async () => {
		await serverStorage!.credentials.set("test-logout-account", [
			mintOAuth("first@example.test"),
			mintOAuth("sibling@example.test"),
		]);
		await clientStorage!.credentials.revalidate();
		const [target, sibling] = clientStorage!.credentials.list("test-logout-account");
		expect(await clientStorage!.credentials.removeById("test-logout-account-other", target.id)).toBe(false);
		expect(await clientStorage!.credentials.removeById("test-logout-account", target.id)).toBe(true);
		expect(clientStorage!.credentials.list("test-logout-account")).toEqual([sibling]);
		expect(serverStore!.listAuthCredentials("test-logout-account").map(entry => entry.id)).toEqual([sibling.id]);
		expect(await clientStorage!.credentials.listDisabled("test-logout-account")).toEqual([]);
		expect(await clientStorage!.credentials.removeById("test-logout-account", target.id)).toBe(false);
	});

	test("remote removal deletes tombstones with no OAuth refresh or account authentication", async () => {
		const provider = "test-logout-account";
		const refresh = vi.fn(async () => {
			throw new Error("unexpected OAuth refresh");
		});
		const fetchUsage = vi.fn(async () => {
			throw new Error("unexpected account authentication");
		});
		vi.spyOn(serverStorage!.oauth, "refresh").mockImplementation(refresh);
		serverStorage!.usage.setProvider(provider, { id: provider, supports: () => true, fetchUsage });
		await serverStore!.saveOAuth(provider, {
			...mintOAuth("expired@example.test"),
			expires: 0,
			projectId: "project-remote",
		});
		const row = serverStore!.listAuthCredentials(provider)[0]!;
		await serverStore!.deleteAuthCredential(row.id, DISABLE_CAUSE);
		// The tombstone never existed in either in-memory active pool.
		expect(clientStorage!.credentials.list(provider)).toEqual([]);
		expect(await clientStorage!.credentials.listDisabled(provider)).toEqual([
			expect.objectContaining({ id: row.id, projectId: "project-remote" }),
		]);
		expect(await clientStorage!.credentials.removeById(`${provider}-other`, row.id)).toBe(false);
		expect(await clientStorage!.credentials.removeById(provider, row.id)).toBe(true);
		expect(await serverStorage!.credentials.listDisabled(provider)).toEqual([]);
		expect(await clientStorage!.credentials.listDisabled(provider)).toEqual([]);
		expect(await clientStorage!.usage.reports()).toEqual([]);
		expect(refresh).not.toHaveBeenCalled();
		expect(fetchUsage).not.toHaveBeenCalled();

		const client = new AuthBrokerClient({ url: handle!.url, token });
		await expect(client.disableCredential(row.id, "deleted by user")).rejects.toMatchObject({ status: 404 });
	});

	test("a broker 404 after a concurrent removal is false, not remote success", async () => {
		await serverStorage!.credentials.set("test-logout-account", mintOAuth("raced@example.test"));
		const remote = new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: handle!.url, token }),
			streamSnapshots: false,
		});
		try {
			await remote.refreshSnapshot();
			const row = remote.listAuthCredentials("test-logout-account")[0]!;
			expect(await serverStorage!.credentials.removeById(row.provider, row.id)).toBe(true);
			expect(await remote.deleteAuthCredential(row.id, "deleted by user")).toBe(false);
		} finally {
			remote.close();
		}
	});

	test("remote removal propagates non-404 broker failures", async () => {
		await serverStorage!.credentials.set("test-logout-account", mintOAuth("kept@example.test"));
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false });
		try {
			await remote.refreshSnapshot();
			const row = remote.listAuthCredentials("test-logout-account")[0]!;
			vi.spyOn(client, "disableCredential").mockRejectedValueOnce(
				new AuthBrokerError("broker unavailable", { status: 503 }),
			);
			await expect(remote.deleteAuthCredential(row.id, "deleted by user")).rejects.toMatchObject({ status: 503 });
			expect(remote.listAuthCredentials("test-logout-account")).toEqual([row]);
			expect(serverStore!.listAuthCredentials("test-logout-account").map(entry => entry.id)).toEqual([row.id]);
		} finally {
			remote.close();
		}
	});

	test("revalidateCredentials re-hydrates broker-side identity changes past a stale snapshot", async () => {
		// Client connected before this credential existed (e.g. a re-login that
		// swapped an org-less row for an org-scoped one while a disk-cached
		// snapshot was still fresh).
		await serverStore!.saveOAuth("anthropic", { ...mintOAuth("late@example.test"), orgId: "org-late" });
		await clientStorage!.credentials.revalidate();
		const rows = clientStorage!.credentials.all().anthropic;
		const list = Array.isArray(rows) ? rows : [rows];
		const late = list.find(entry => entry?.type === "oauth" && entry.email === "late@example.test");
		if (late?.type !== "oauth") throw new Error("expected refreshed oauth credential");
		expect(late.orgId).toBe("org-late");
	});
});

describe("OAuth login stamps authorizedAt", () => {
	const PROVIDER_ID = "test-authorized-at-oauth";
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-authorized-at-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store);
		await storage.credentials.reload();
		registerOAuthProvider({
			id: PROVIDER_ID,
			name: "AuthorizedAt Test",
			sourceId: "authorized-at-test",
			login: async () => ({
				refresh: "refresh-initial",
				access: "access-initial",
				expires: Date.now() + 60_000,
				email: "stamped@example.test",
			}),
		});
	});

	afterEach(async () => {
		unregisterOAuthProviders("authorized-at-test");
		storage?.close();
		await removeWithRetries(tempDir);
	});

	test("login records the interactive-login instant; refresh persists keep it while rotating tokens", async () => {
		const before = Date.now();
		await storage!.oauth.login(PROVIDER_ID, {
			onAuth: () => {},
			onPrompt: async () => "",
		});
		const stored = store!.listAuthCredentials(PROVIDER_ID)[0];
		if (stored.credential.type !== "oauth") throw new Error("expected oauth credential");
		const authorizedAt = stored.credential.authorizedAt;
		expect(typeof authorizedAt).toBe("number");
		expect(authorizedAt!).toBeGreaterThanOrEqual(before);
		expect(authorizedAt!).toBeLessThanOrEqual(Date.now());

		// Refresh rotates tokens but must not touch the login anchor — the
		// rebuild in refreshCredentialById previously dropped unknown fields.
		const refreshingStorage = new AuthStorage(store!, {
			refreshOAuthCredential: async () => ({
				access: "access-rotated",
				refresh: "refresh-rotated",
				expires: Date.now() + 120_000,
			}),
		});
		try {
			await refreshingStorage.credentials.reload();
			await refreshingStorage.oauth.refresh(stored.id);
			const after = store!.listAuthCredentials(PROVIDER_ID)[0];
			if (after.credential.type !== "oauth") throw new Error("expected oauth credential");
			expect(after.credential.refresh).toBe("refresh-rotated");
			expect(after.credential.authorizedAt).toBe(authorizedAt);
		} finally {
			refreshingStorage.close();
		}
	});
});
