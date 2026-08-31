import { defineConfig, devices } from "@playwright/test";

const PORT = 3210;
/** A second app instance, started against a registry that is not there. */
const OFFLINE_PORT = 3211;

/**
 * Runs against a production build, not `next dev`.
 *
 * Two of the bugs this suite locks down only exist in the production path:
 * the 404 status that a route-level loading boundary swallowed, and the
 * server-action authorisation that dev's error overlay renders differently.
 * Testing the dev server would have missed both.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  // Ninety seconds was too tight, and which test it failed moved between runs:
  // the CSP check on the agent page one run, `goto("/mandate")` the next, both
  // passing on their own in seconds. Every one of these pages renders from live
  // third-party endpoints, and four workers calling them at once is a different
  // proposition from one — /mandate answers in 2.6 s served alone and 3.7 s at
  // six concurrent requests against production, so the app is not the slow
  // part. A budget that fails on somebody else's latency reports a bug that
  // does not exist and hides the ones that do.
  timeout: 150_000,
  expect: { timeout: 20_000 },

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      // The responsive specs belong to the phone project. Running them at
      // 1280px would pass trivially and prove nothing, which is worse than
      // not running them: a green tick nobody earned.
      // The phone specs belong to the mobile project and the offline specs to
      // their own server. Running either here would pass trivially against the
      // wrong conditions — a green tick nobody earned.
      testIgnore: /(responsive|registry-down)\.spec\.ts/,
    },
    {
      // Firefox and WebKit had never opened this app. Both ship engines with
      // different CSS and streaming behaviour from Chromium, and a
      // marketplace nobody can use in Safari is a marketplace with a hole in
      // it. Scoped to the catalog specs — the journey a visitor actually
      // takes — because the control-room specs mutate shared server state and
      // running three browsers through them concurrently would have them
      // fighting over one ledger.
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
      testMatch: /catalog\.spec\.ts/,
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testMatch: /catalog\.spec\.ts/,
    },
    {
      // Its own server, its own port, and an origin that refuses connections.
      // The registry is read server-side, so this is the only way to make the
      // outage real rather than mimed.
      name: "registry-down",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${OFFLINE_PORT}` },
      testMatch: /registry-down\.spec\.ts/,
    },
    {
      // The listing and the comparison table are the two widest things Kawal
      // renders, and neither had ever been opened at 393px. A marketplace
      // judged on "find an agent without hitting a dead end" cannot leave
      // that untested.
      name: "mobile",
      use: { ...devices["Pixel 7"] },
      testMatch: /responsive\.spec\.ts/,
    },
    {
      // 412px is the other common phone width (Pixel 6/7 Pro, most Galaxy
      // models) and sits on the wrong side of a few breakpoints the 393px
      // Pixel 7 never reaches.
      name: "mobile-412",
      use: { ...devices["Pixel 7"], viewport: { width: 412, height: 915 } },
      testMatch: /responsive\.spec\.ts/,
    },
  ],

  webServer: [
    {
      command: `npx next start -p ${PORT}`,
      url: `http://127.0.0.1:${PORT}`,
    // Never reuse. A leftover server from an earlier run serves the build it
    // started with, so a suite that attached to one reported failures against
    // code that no longer existed — twice, and both cost real time to chase.
    // Five seconds of startup per run buys never testing a stale binary.
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        // The control-room tests need an operator token to exist. It is a test
        // value: the point is to prove the gate opens for the right secret and
        // stays shut for everything else.
        KAWAL_OPERATOR_TOKEN: "playwright-operator-token",
        // `.env.local` carries the deployed site's Turso credentials once the
        // integration is installed, and `next start` loads that file. Empty
        // here, so the suite exercises the local file stores and never writes
        // test rows into the database the deployed site reads.
        TURSO_DATABASE_URL: "",
        // Two hundred tests from one address would trip the production
        // ceiling on /api/*; the outage server below keeps the real one so
        // the 429 test still means something.
        KAWAL_RATE_SCALE: "20",
      },
    },
    {
      // 127.0.0.1:1 refuses connections immediately rather than hanging, so
      // the outage tests fail fast instead of waiting out every timeout.
      command: `npx next start -p ${OFFLINE_PORT}`,
      url: `http://127.0.0.1:${OFFLINE_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { SCAN_API_ORIGIN: "http://127.0.0.1:1", TURSO_DATABASE_URL: "", CRON_SECRET: "playwright-cron-secret" },
    },
  ],
});
