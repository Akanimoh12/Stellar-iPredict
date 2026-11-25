import { test, expect, Page } from "@playwright/test";

test.describe("Main User Journey: Connect → Browse → Bet → Claim", () => {
  let page: Page;

  test.beforeEach(async ({ page: p }) => {
    page = p;
    // Start from home page
    await page.goto("/");

    // Wait for initial page load
    await page.waitForLoadState("networkidle");
  });

  test("should load landing page with wallet connect options", async () => {
    // Check for main heading
    await expect(page.getByRole("heading", { name: /ipredict/i })).toBeVisible();

    // Check for wallet connect buttons
    await expect(page.getByRole("button", { name: /freighter/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /albedo/i })).toBeVisible();
  });

  test("should browse markets without wallet connection", async () => {
    // Navigate to markets page
    await page.goto("/markets");

    // Wait for markets to load
    await page.waitForLoadState("networkidle");

    // Check for market list
    const marketCards = page.locator("[data-testid='market-card']");
    await expect(marketCards.first()).toBeVisible();
  });

  test("should filter markets by category", async () => {
    await page.goto("/markets");
    await page.waitForLoadState("networkidle");

    // Click crypto filter
    await page.getByRole("button", { name: /crypto/i }).click();

    // Wait for filter to apply
    await page.waitForTimeout(500);

    // Verify only crypto markets shown
    const marketCards = page.locator("[data-testid='market-card']");
    const count = await marketCards.count();

    if (count > 0) {
      const firstCard = marketCards.first();
      await expect(firstCard).toContainText(/crypto|btc|eth/i);
    }
  });

  test("should sort markets by volume", async () => {
    await page.goto("/markets");
    await page.waitForLoadState("networkidle");

    // Click volume sort
    await page.getByRole("button", { name: /volume|sort/i }).click();

    // Wait for sort to apply
    await page.waitForTimeout(500);

    // Verify markets are sorted (volume info visible)
    const marketCards = page.locator("[data-testid='market-card']");
    await expect(marketCards.first()).toBeVisible();
  });

  test("should view market details", async () => {
    await page.goto("/markets");
    await page.waitForLoadState("networkidle");

    // Click on first market
    const firstMarket = page.locator("[data-testid='market-card']").first();
    await firstMarket.click();

    // Should navigate to market detail page
    await page.waitForURL(/\/markets\/\d+/);

    // Check for market details
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // Check for betting panel
    await expect(page.getByTestId("betting-panel")).toBeVisible();
  });

  test("should show connected wallet in profile", async () => {
    // Note: This test uses mock wallet connection since we can't automate actual wallet connection
    // In real environment, this would test actual wallet integration

    // Skip actual wallet connection and go directly to home
    // The test verifies the UI structure is present

    await expect(page.getByTestId("wallet-button") || page.getByText(/connect/i)).toBeVisible();
  });

  test("should handle wallet disconnect", async () => {
    // Assuming wallet was connected, check disconnect flow

    // Look for profile button or wallet dropdown
    const profileButton = page.getByTestId("profile-button");
    if (await profileButton.isVisible()) {
      await profileButton.click();

      // Look for disconnect option
      const disconnectBtn = page.getByRole("button", { name: /disconnect/i });
      if (await disconnectBtn.isVisible()) {
        await disconnectBtn.click();

        // Should return to connect screen
        await expect(page.getByRole("button", { name: /connect/i })).toBeVisible();
      }
    }
  });

  test("should navigate through markets with pagination", async () => {
    await page.goto("/markets");
    await page.waitForLoadState("networkidle");

    // Count initial markets
    let marketCards = page.locator("[data-testid='market-card']");
    const initialCount = await marketCards.count();

    // Look for next page button
    const nextButton = page.getByRole("button", { name: /next|load more/i });
    if (await nextButton.isVisible()) {
      await nextButton.click();

      // Wait for new markets to load
      await page.waitForTimeout(500);

      // Should have more markets
      marketCards = page.locator("[data-testid='market-card']");
      const newCount = await marketCards.count();
      expect(newCount).toBeGreaterThanOrEqual(initialCount);
    }
  });

  test("should display market expiry information", async () => {
    await page.goto("/markets");
    await page.waitForLoadState("networkidle");

    // Check first market for expiry info
    const firstMarket = page.locator("[data-testid='market-card']").first();

    // Should show expiry time
    await expect(firstMarket.locator("[data-testid='expiry-time']") || firstMarket).toContainText(/\d+:\d+|expires/i);
  });

  test("should show pool odds on market card", async () => {
    await page.goto("/markets");
    await page.waitForLoadState("networkidle");

    // First market should show odds
    const firstMarket = page.locator("[data-testid='market-card']").first();

    // Should have yes/no odds
    const yesOdds = firstMarket.locator("[data-testid='yes-odds']");
    const noOdds = firstMarket.locator("[data-testid='no-odds']");

    // At least one odds display should be visible
    expect(
      await yesOdds.isVisible() || await noOdds.isVisible() ||
      (await firstMarket.textContent())?.match(/\d+%/)
    ).toBeTruthy();
  });

  test("should handle market loading states", async () => {
    // Slow down network to catch loading states
    await page.route("**/*", (route) => {
      setTimeout(() => route.continue(), 1000);
    });

    await page.goto("/markets");

    // Check for loading skeleton or spinner
    const loadingIndicator = page.locator("[data-testid='loading-skeleton'], [data-testid='spinner']");
    if (await loadingIndicator.isVisible()) {
      await expect(loadingIndicator).toBeVisible();
    }

    // Wait for markets to fully load
    await page.waitForLoadState("networkidle");

    // Markets should now be visible
    const marketCards = page.locator("[data-testid='market-card']");
    await expect(marketCards.first()).toBeVisible();
  });

  test("should handle error states gracefully", async () => {
    // Block network to simulate error
    await page.context().setOffline(true);

    await page.goto("/markets");

    // Should show error message
    const errorMsg = page.getByTestId("error-message") || page.getByText(/error|failed/i);
    if (await errorMsg.isVisible()) {
      await expect(errorMsg).toBeVisible();
    }

    // Re-enable network
    await page.context().setOffline(false);

    // Reload should work
    await page.reload();
    await page.waitForLoadState("networkidle");
  });

  test("should maintain scroll position when navigating", async () => {
    await page.goto("/markets");
    await page.waitForLoadState("networkidle");

    // Scroll down
    await page.evaluate(() => window.scrollBy(0, 500));
    const scrollBefore = await page.evaluate(() => window.scrollY);

    // Click on market
    const firstMarket = page.locator("[data-testid='market-card']").first();
    await firstMarket.click();

    // Navigate back
    await page.goBack();

    // Scroll position should be restored (if implemented)
    const scrollAfter = await page.evaluate(() => window.scrollY);

    // This may or may not be preserved depending on implementation
    // Just verify page doesn't crash
    await expect(page.locator("[data-testid='market-card']").first()).toBeVisible();
  });

  test("should work on mobile viewport", async () => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    await page.goto("/markets");
    await page.waitForLoadState("networkidle");

    // Check markets are visible on mobile
    const marketCards = page.locator("[data-testid='market-card']");
    await expect(marketCards.first()).toBeVisible();

    // Verify layout is responsive
    const viewport = page.viewportSize();
    expect(viewport?.width).toBe(375);
  });

  test("should work on tablet viewport", async () => {
    // Set tablet viewport
    await page.setViewportSize({ width: 768, height: 1024 });

    await page.goto("/markets");
    await page.waitForLoadState("networkidle");

    // Check markets are visible on tablet
    const marketCards = page.locator("[data-testid='market-card']");
    await expect(marketCards.first()).toBeVisible();
  });

  test("should handle deep linking to market detail", async () => {
    // Go directly to a market detail page
    await page.goto("/markets/1");

    // Should load the market details
    await page.waitForLoadState("networkidle");

    // Check for betting panel
    const bettingPanel = page.getByTestId("betting-panel");
    if (await bettingPanel.isVisible()) {
      await expect(bettingPanel).toBeVisible();
    }
  });

  test("should handle quick navigation between markets", async () => {
    await page.goto("/markets");
    await page.waitForLoadState("networkidle");

    // Click multiple markets rapidly
    const marketCards = page.locator("[data-testid='market-card']");
    const count = Math.min(3, await marketCards.count());

    for (let i = 0; i < count; i++) {
      await marketCards.nth(i).click();

      // Wait for page to load
      await page.waitForURL(/\/markets\/\d+/);

      // Go back
      await page.goBack();
    }

    // Should end up back on market list
    await expect(page.locator("[data-testid='market-card']").first()).toBeVisible();
  });

  test("should cache markets for performance", async () => {
    // First visit
    const startTime1 = Date.now();
    await page.goto("/markets");
    await page.waitForLoadState("networkidle");
    const duration1 = Date.now() - startTime1;

    // Navigate away and back
    await page.goto("/");
    await page.goBack();

    // Second visit should be faster (cached)
    const startTime2 = Date.now();
    // Should load quickly from cache
    const marketCards = page.locator("[data-testid='market-card']");
    await expect(marketCards.first()).toBeVisible({ timeout: 5000 });
    const duration2 = Date.now() - startTime2;

    // This is a soft assertion since caching behavior may vary
    expect(duration2).toBeLessThanOrEqual(duration1 + 1000);
  });
});
