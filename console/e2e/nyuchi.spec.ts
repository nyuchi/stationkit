import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { CONSOLE_KEY, FAKE_INGEST_SERVER, FAKE_URL } from "./support/e2e-env";
import type { RecordedRequest } from "./support/fake-nyuchi-api";

/**
 * The console with STATIONS_BACKEND=nyuchi: the real client, called from the
 * real BFF, against a fake Nyuchi API (see playwright.nyuchi.config.ts). The
 * fake keeps a log of what reached it, so these tests check both what the
 * person sees and what left the server.
 */
const fake = {
  async call(path: string, body?: unknown) {
    const res = await fetch(`${FAKE_URL}${path}`, {
      method: body === undefined ? "GET" : "POST",
      body: body === undefined ? null : JSON.stringify(body),
    });
    return res.json() as Promise<any>;
  },
  reset: () => fake.call("/__fake/reset", {}),
  requests: () => fake.call("/__fake/requests") as Promise<RecordedRequest[]>,
  stats: () =>
    fake.call("/__fake/stats") as Promise<{
      exchanges: number;
      ensures: number;
      stations: number;
    }>,
  unavailable: (on: boolean) => fake.call("/__fake/unavailable", on),
  fault: (f: Record<string, unknown>) => fake.call("/__fake/fault", f),
  community: (c: { stationId: string; key: string; name?: string }) =>
    fake.call("/__fake/community", c),
};

test.beforeEach(() => fake.reset());

/** The console asks the BFF for the person's stations as soon as it loads. */
const listLoaded = (page: Page) =>
  page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/stations" &&
      r.request().method() === "GET",
  );

const signIn = async (page: Page, as: string) => {
  const loaded = listLoaded(page);
  await page.goto(`/auth/signin?as=${as}`);
  await expect(
    page.getByRole("heading", { name: "Station console", level: 1 }),
  ).toBeVisible();
  await loaded;
};

async function register(
  page: Page,
  name: string,
  opts: { type?: "Digital" | "Analog"; country?: string } = {},
) {
  await page.getByLabel("Station name").fill(name);
  await page.getByLabel("Latitude").fill("-1.29");
  await page.getByLabel("Longitude").fill("36.82");
  await page.getByLabel("Country").selectOption(opts.country ?? "KE");
  await page
    .getByText(
      (opts.type ?? "Digital") === "Digital"
        ? "Digital (uploads automatically)"
        : "Analog (manual readings)",
    )
    .click();
  await page.getByRole("button", { name: "Register station" }).click();
  await expect(page.locator("#credentials")).toBeVisible();
}

const saved = (page: Page) =>
  page.getByRole("button", { name: "I have saved them" }).click();

test.describe("the real client", () => {
  test("provisions a first-time person once, then lists from the server", async ({
    page,
  }) => {
    await signIn(page, "ada");
    const seen = (await fake.requests()).map((r) => `${r.method} ${r.path}`);
    expect(seen).toEqual([
      "POST /v1/auth/token",
      "POST /v1/identity/persons/ensure",
      "POST /v1/auth/token",
      "GET /v1/stations",
    ]);
    await expect(page.getByText("Not live yet")).toHaveCount(0);
    // A second visit reuses the person and the cached token.
    const again = listLoaded(page);
    await page.reload();
    await again;
    await expect(page.locator("#station-empty")).toBeVisible();
    expect(await fake.stats()).toMatchObject({ exchanges: 2, ensures: 1 });
  });

  test("registers with the country, shows the key once and the upload target the API named", async ({
    page,
    context,
  }) => {
    const bodies: string[] = [];
    page.on("response", async (r) => {
      if (!r.url().includes("/api/")) return;
      try {
        bodies.push(
          `${r.request().method()} ${new URL(r.url()).pathname}\n${await r.text()}`,
        );
      } catch {
        // a redirect has no body
      }
    });
    await signIn(page, "reg");
    await register(page, "Karen Weather", { country: "KE" });

    const creds = page.locator("#credentials");
    const id = (await creds.locator("[data-cred-id]").textContent())!;
    const key = (await creds.locator("[data-cred-key]").textContent())!;
    expect(id).toMatch(/^mws-[a-f0-9]{8}$/);
    expect(key.length).toBeGreaterThan(20);
    // The upload target is the API's, not the console's default.
    await expect(creds).toContainText(
      `Wunderground protocol: server ${FAKE_INGEST_SERVER}, path /stations/ingest`,
    );
    await expect(creds).toContainText(
      `Ecowitt protocol: server ${FAKE_INGEST_SERVER}`,
    );
    await expect(creds).toContainText(`PASSKEY = ${id}:<your ingest key>`);
    expect(await creds.textContent()).not.toContain(
      "weather-ingest.nyuchi.com",
    );

    // The country went to the API with the registration.
    const create = (await fake.requests()).find(
      (r) => r.method === "POST" && r.path === "/v1/stations",
    );
    expect(create?.body).toMatchObject({
      name: "Karen Weather",
      country: "KE",
      stationType: "digital",
    });

    await saved(page);
    await expect(creds).toBeHidden();
    expect(await page.locator("body").textContent()).not.toContain(key);

    // A reload lists it from the server, owner-based, without the browser's store.
    await page.evaluate(() => localStorage.removeItem("mws-console-stations"));
    await page.reload();
    const card = page.locator("[data-station]", { hasText: id });
    await expect(card).toContainText("Karen Weather");
    await expect(card).toContainText("Owned by you");
    expect(await page.locator("body").textContent()).not.toContain(key);

    // The key is in exactly one answer, the one that issued it. The console's
    // own key and the person's tokens are in none, and in no cookie.
    const withKey = bodies.filter((b) => b.includes(key));
    expect(withKey.map((b) => b.split("\n")[0])).toEqual([
      "POST /api/stations",
    ]);
    for (const secret of [
      CONSOLE_KEY.clientSecret,
      CONSOLE_KEY.clientId,
      "ptok.",
      "mock-access-token",
    ])
      expect(bodies.join("\n"), secret).not.toContain(secret);
    const cookies = JSON.stringify(await context.cookies());
    for (const secret of [
      key,
      CONSOLE_KEY.clientSecret,
      "ptok.",
      "mock-access-token",
    ])
      expect(cookies, secret).not.toContain(secret);
    // What the browser stores: the station key for its own use, and never a token.
    const stored = await page.evaluate(() =>
      JSON.stringify({ ...localStorage }),
    );
    expect(stored).not.toContain("ptok.");
    expect(stored).not.toContain(CONSOLE_KEY.clientSecret);
  });

  test("the answers that carry a key are not cacheable and not referred", async ({
    page,
  }) => {
    await signIn(page, "hdr");
    const res = await page.request.post("/api/stations", {
      data: {
        name: "Header check",
        lat: 1,
        lon: 1,
        stationType: "digital",
        country: "ZW",
      },
    });
    expect(res.status()).toBe(201);
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(res.headers()["pragma"]).toBe("no-cache");
    expect(res.headers()["referrer-policy"]).toBe("no-referrer");
    const { stationId } = await res.json();
    const rotated = await page.request.post(
      `/api/stations/${stationId}/rotate-key`,
    );
    expect(rotated.status()).toBe(200);
    expect(rotated.headers()["cache-control"]).toContain("no-store");
    // And the browser is not asked to send a country it has not chosen.
    const noCountry = await page.request.post("/api/stations", {
      data: { name: "No country", lat: 1, lon: 1, stationType: "digital" },
    });
    expect(noCountry.status()).toBe(400);
  });

  test("logs a manual reading in km/h, shows the status, and says which field the API refused", async ({
    page,
  }) => {
    await signIn(page, "manual");
    await register(page, "Farm gauge", { type: "Analog" });
    await saved(page);
    const card = page.locator("[data-station]").first();
    await expect(card).toContainText("No readings yet");

    await card.getByLabel("Temperature (°C)").fill("21.5");
    await card.getByLabel("Wind (km/h)").fill("12.34");
    await card.getByRole("button", { name: "Log reading" }).click();
    await expect(card.getByRole("status")).toContainText(
      "Saved. 2 measurement(s) accepted",
    );
    await expect(card).toContainText("air temperature celsius: 21.5");
    await expect(card).toContainText("wind speed kph: 12.34");
    await expect(card).toContainText("Last reading");
    const sent = (await fake.requests()).filter((r) =>
      r.path.endsWith("/readings"),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({
      stationType: "generic",
      readings: [{ temperatureC: 21.5, windSpeedKph: 12.34 }],
    });

    // The API judges the reading, not only the console's own form: it says no
    // with a 200 and a field, and the console says which.
    await fake.fault({
      method: "POST",
      pattern: "/readings$",
      status: 200,
      reply: {
        accepted: 0,
        rejected: 1,
        errors: [
          {
            index: 0,
            code: "out_of_range",
            detail: "Must be between -50 and 60 in this unit.",
            field: "temperatureC",
          },
        ],
        results: [{ index: 0, status: "rejected", qcStatus: "rejected" }],
      },
    });
    await card.getByLabel("Temperature (°C)").fill("30");
    await card.getByRole("button", { name: "Log reading" }).click();
    await expect(card.getByRole("status")).toContainText(
      "Rejected by quality checks: temperature is out of range",
    );
    // The form keeps what was typed so it can be corrected.
    await expect(card.getByLabel("Temperature (°C)")).toHaveValue("30");
  });

  test("rotates the key: the new key is shown once, the old one stops", async ({
    page,
  }) => {
    await signIn(page, "rot");
    await register(page, "Rotating");
    const id = (await page.locator("[data-cred-id]").textContent())!;
    const oldKey = (await page.locator("[data-cred-key]").textContent())!;
    await saved(page);
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Rotate key" }).click();
    await expect(page.locator("#credentials")).toBeVisible();
    const newKey = (await page.locator("[data-cred-key]").textContent())!;
    expect(newKey).not.toBe(oldKey);
    // The API sends no upload target on rotation: the console's own host stands in.
    await expect(page.locator("[data-cred-wunderground]")).toContainText(
      "server weather-ingest.nyuchi.com",
    );

    const stale = await page.request.get(`/api/stations/${id}`, {
      headers: { "X-Station-Key": oldKey },
    });
    expect(stale.status()).toBe(403);
    expect((await stale.json()).error).toBe(
      "That station key was not accepted.",
    );
    const fresh = await page.request.get(`/api/stations/${id}`, {
      headers: { "X-Station-Key": newKey },
    });
    expect(fresh.status()).toBe(200);
  });

  test("a legacy station keeps working with its key, and can be claimed", async ({
    page,
  }) => {
    await fake.community({
      stationId: "mws-00000001",
      key: "legacy-station-key",
      name: "Old school gauge",
    });
    await page.addInitScript(() => {
      if (!localStorage.getItem("mws-console-stations"))
        localStorage.setItem(
          "mws-console-stations",
          JSON.stringify([
            {
              stationId: "mws-00000001",
              key: "legacy-station-key",
              name: "Old school gauge",
              stationType: "manual",
            },
          ]),
        );
    });
    await signIn(page, "claimer");
    const card = page.locator("[data-station]", { hasText: "mws-00000001" });
    await expect(card).toContainText("Key on this device");
    await expect(card.getByRole("button", { name: "Rotate key" })).toBeHidden();
    await expect(
      card.getByRole("button", { name: "Claim for my account" }),
    ).toBeVisible();

    await card.getByLabel("Wind (km/h)").fill("12");
    await card.getByRole("button", { name: "Log reading" }).click();
    await expect(card.getByRole("status")).toContainText("Saved");
    const viaKey = (await fake.requests()).filter(
      (r) => r.as === "station-key",
    );
    expect(viaKey.length).toBeGreaterThan(0);
    for (const r of viaKey) {
      expect(r.authorization).toBe("Bearer legacy-station-key");
      expect(r.url).not.toContain("legacy-station-key");
    }

    await card.getByRole("button", { name: "Claim for my account" }).click();
    await expect(card.getByRole("status")).toContainText(
      "Claimed. This station is now yours.",
    );
    await expect(card).toContainText("Owned by you");
    await expect(
      card.getByRole("button", { name: "Rotate key" }),
    ).toBeVisible();
    await expect(
      card.getByRole("button", { name: "Claim for my account" }),
    ).toBeHidden();
    const claim = (await fake.requests()).find((r) =>
      r.path.endsWith("/claim"),
    );
    expect(claim?.body).toEqual({ ingestKey: "legacy-station-key" });
    expect(claim?.url).not.toContain("legacy-station-key");
    // Now it is listed by the server for this person, key or no key.
    await page.evaluate(() =>
      localStorage.setItem("mws-console-stations", "[]"),
    );
    await page.reload();
    await expect(
      page.locator("[data-station]", { hasText: "mws-00000001" }),
    ).toContainText("Owned by you");
  });

  test("a wrong key on this device is said plainly, for a claim and for a reading", async ({
    page,
  }) => {
    await fake.community({ stationId: "mws-00000002", key: "the-real-key" });
    await page.addInitScript(() => {
      if (!localStorage.getItem("mws-console-stations"))
        localStorage.setItem(
          "mws-console-stations",
          JSON.stringify([
            {
              stationId: "mws-00000002",
              key: "a-wrong-key",
              name: "Mixed-up gauge",
              stationType: "manual",
            },
          ]),
        );
    });
    await signIn(page, "wrongkey");
    const card = page.locator("[data-station]", { hasText: "mws-00000002" });
    await card.getByRole("button", { name: "Claim for my account" }).click();
    await expect(card.getByRole("status")).toContainText(
      "That is not this station's key.",
    );
    await card.getByLabel("Rain (mm)").fill("2");
    await card.getByRole("button", { name: "Log reading" }).click();
    await expect(card.getByRole("status")).toContainText(
      "That station key was not accepted.",
    );
    // Not signed out: a wrong station key is not a wrong person.
    await expect(
      page.getByRole("heading", { name: "Station console", level: 1 }),
    ).toBeVisible();
  });

  test("shows the API's answers in words: not available, limit reached, rate limited", async ({
    page,
  }) => {
    await signIn(page, "words");
    await fake.unavailable(true);
    await page.getByLabel("Station name").fill("Never saved");
    await page.getByLabel("Latitude").fill("1");
    await page.getByLabel("Longitude").fill("1");
    await page.getByLabel("Country").selectOption("ZW");
    await page.getByRole("button", { name: "Register station" }).click();
    await expect(page.locator("#console-error")).toContainText(
      "Station registration is not live yet",
    );
    await fake.unavailable(false);

    await fake.fault({
      method: "POST",
      path: "/v1/stations",
      status: 409,
      code: "station_limit_reached",
    });
    await page.getByRole("button", { name: "Register station" }).click();
    await expect(page.locator("#console-error")).toContainText(
      "You already have the most stations one person can register.",
    );

    await fake.fault({
      method: "POST",
      path: "/v1/stations",
      status: 429,
      code: "rate_limited",
    });
    await page.getByRole("button", { name: "Register station" }).click();
    await expect(page.locator("#console-error")).toContainText(
      "Too many requests. Try again later.",
    );
    await expect(page.locator("[data-station]")).toHaveCount(0);
  });

  test("a platform failure is not 'you are signed out'", async ({ page }) => {
    await signIn(page, "platform");
    await fake.fault({
      method: "GET",
      path: "/v1/stations",
      status: 403,
      code: "insufficient_scope",
      times: 3,
    });
    await page.reload();
    await expect(page.locator("#console-error")).toContainText(
      "The station service could not complete that request.",
    );
    // Still on the console, not sent to sign in.
    await expect(page).toHaveURL(/\/$/);
  });

  test("stations are private to their owner", async ({
    page,
    browser,
    baseURL,
  }) => {
    await signIn(page, "alice");
    await register(page, "Alice only");
    const id = (await page.locator("[data-cred-id]").textContent())!;

    const bob = await browser.newContext({ baseURL: baseURL! });
    await (await bob.newPage()).goto("/auth/signin?as=bob");
    expect(
      (await (await bob.request.get("/api/stations")).json()).stations,
    ).toEqual([]);
    expect((await bob.request.get(`/api/stations/${id}`)).status()).toBe(404);
    expect(
      (await bob.request.post(`/api/stations/${id}/rotate-key`)).status(),
    ).toBe(404);
    await bob.close();

    // Two people, two exchanges, two different tokens at the API.
    const tokens = new Set(
      (await fake.requests())
        .filter((r) => r.as === "person")
        .map((r) => r.authorization),
    );
    expect(tokens.size).toBe(2);
  });

  test("is axe clean with the country field", async ({ page }) => {
    await signIn(page, "a11y");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const country = page.getByLabel("Country");
    await expect(country).toHaveAttribute("required", "");
    expect(await country.inputValue()).toBe("");
  });
});
