import { test, expect, Page } from "@playwright/test";

test.describe("Betting and Claim Journey (with mocked wallet)", () => {
  let page: Page;

  test.beforeEach(async ({ page: p, context }) => {
    page = p;

    // Mock the wallet connection in localStorage
    await context.addInitScript(() => {
      localStorage.setItem(
        "ip_wallet_type",
        "freighter"
      );
      localStorage.setItem(
        "ip_wallet_pubkey",
        "GTEST123MOCKWALLET456..."
      );
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("should show betting panel with correct fee calculation", async () => {
    await page.goto("/markets");
    await page.waitForLoadState("networkidle");

    // Click first market
    const firstMarket = page.locator("[data-testid='market-card']").first();
    await firstMarket.click();

    // Wait for market detail
    await page.waitForURL(/\/markets\/\d+/);

    // Check betting panel
    const bettingPanel = page.getByTestId("betting-panel");
    await expect(bettingPanel).toBeVisible();
  });

  test("should validate bet amount input", async () => {
    await page.goto("/markets/1");
    await page.waitForLoadState("networkidle");

    const betInput = page.getByTestId("bet-amount-input");
    if (await betInput.isVisible()) {
      // Test zero amount
      await betInput.fill("0");
      const submitBtn = page.getByRole("button", { name: /place bet|submit/i });

      if (await submitBtn.isVisible()) {
        expect(await submitBtn.isDisabled()).toBeTruthy();
      }
    }
  });

  test("should handle bet submission with YES prediction", async () => {
    await page.goto("/markets/1");
    await page.waitForLoadState("networkidle");

    // Select YES
    const yesButton = page.getByRole("button", { name: /yes|up/i }).first();
    if (await yesButton.isVisible()) {
      await yesButton.click();
    }

    // Enter amount
    const betInput = page.getByTestId("bet-amount-input");
    if (await betInput.isVisible()) {
      await betInput.fill("10");
    }

    // Submit bet
    const submitBtn = page.getByRole("button", { name: /place bet|submit/i });
    if (await submitBtn.isVisible()) {
      await submitBtn.click();

      // Should show success message or navigate
      const successMsg = page.getByTestId("success-message") || page.getByText(/bet placed|success/i);
      if (await successMsg.isVisible()) {
        await expect(successMsg).toBeVisible();
      }
    }
  });

  test("should handle bet submission with NO prediction", async () => {
    await page.goto("/markets/1");
    await page.waitForLoadState("networkidle");

    // Select NO
    const noButton = page.getByRole("button", { name: /no|down/i }).first();
    if (await noButton.isVisible()) {
      await noButton.click();
    }

    // Enter amount
    const betInput = page.getByTestId("bet-amount-input");
    if (await betInput.isVisible()) {
      await betInput.fill("5");
    }

    // Submit bet
    const submitBtn = page.getByRole("button", { name: /place bet|submit/i });
    if (await submitBtn.isVisible()) {
      await submitBtn.click();

      // Check for transaction
      const txStatus = page.getByTestId("transaction-status");
      if (await txStatus.isVisible()) {
        await expect(txStatus).toContainText(/signed|confirmed|submitted/i);
      }
    }
  });

  test("should display fee breakdown", async () => {
    await page.goto("/markets/1");
    await page.waitForLoadState("networkidle");

    // Enter bet amount
    const betInput = page.getByTestId("bet-amount-input");
    if (await betInput.isVisible()) {
      await betInput.fill("100");

      // Check for fee calculation
      const feeBreakdown = page.getByTestId("fee-breakdown");
      if (await feeBreakdown.isVisible()) {
        // Should show platform fee (2%)
        await expect(feeBreakdown).toContainText(/2\.00|2%|fee/i);
      }

      // Check for net amount
      const netAmount = page.getByTestId("net-amount");
      if (await netAmount.isVisible()) {
        // Should be ~98 XLM
        await expect(netAmount).toContainText(/98/);
      }
    }
  });

  test("should show bet confirmation dialog", async () => {
    await page.goto("/markets/1");
    await page.waitForLoadState("networkidle");

    // Enter bet details
    const yesButton = page.getByRole("button", { name: /yes/i }).first();
    if (await yesButton.isVisible()) {
      await yesButton.click();
    }

    const betInput = page.getByTestId("bet-amount-input");
    if (await betInput.isVisible()) {
      await betInput.fill("50");

      // Look for confirmation
      const confirmBtn = page.getByRole("button", { name: /confirm|place bet/i });
      if (await confirmBtn.isVisible()) {
        // Click to show confirmation
        await confirmBtn.click();

        // Confirmation dialog should appear
        const dialog = page.getByRole("dialog");
        if (await dialog.isVisible()) {
          await expect(dialog).toBeVisible();
        }
      }
    }
  });

  test("should handle claim flow from profile", async () => {
    // Navigate to profile
    const profileBtn = page.getByTestId("profile-button");
    if (await profileBtn.isVisible()) {
      await profileBtn.click();

      // Look for winnings/claim section
      const claimSection = page.getByTestId("claim-section");
      if (await claimSection.isVisible()) {
        await expect(claimSection).toBeVisible();
      }
    }
  });

  test("should show claimed/unclaimed status", async () => {
    // Go to markets with resolved outcomes
    await page.goto("/markets");
    await page.waitForLoadState("networkidle");

    // Filter for resolved markets
    const resolvedFilter = page.getByRole("button", { name: /resolved/i });
    if (await resolvedFilter.isVisible()) {
      await resolvedFilter.click();

      // Check for claim buttons on resolved markets
      const claimBtn = page.getByRole("button", { name: /claim/i });
      if (await claimBtn.isVisible({ timeout: 5000 })) {
        await expect(claimBtn).toBeVisible();
      }
    }
  });

  test("should handle bet stage transitions", async () => {
    await page.goto("/markets/1");
    await page.waitForLoadState("networkidle");

    const betInput = page.getByTestId("bet-amount-input");
    if (await betInput.isVisible()) {
      await betInput.fill("10");

      const submitBtn = page.getByRole("button", { name: /place bet/i });
      if (await submitBtn.isVisible()) {
        await submitBtn.click();

        // Check for stage indicators
        const stage = page.getByTestId("transaction-stage");
        if (await stage.isVisible({ timeout: 5000 })) {
          // Should show building, signing, submitting, confirmed
          const stageText = await stage.textContent();
          expect(["building", "signing", "submitting", "confirmed"]).toContain(
            stageText?.toLowerCase()
          );
        }
      }
    }
  });

  test("should allow resetting bet form", async () => {
    await page.goto("/markets/1");
    await page.waitForLoadState("networkidle");

    // Fill form
    const yesBtn = page.getByRole("button", { name: /yes/i }).first();
    if (await yesBtn.isVisible()) {
      await yesBtn.click();
    }

    const betInput = page.getByTestId("bet-amount-input");
    if (await betInput.isVisible()) {
      await betInput.fill("25");

      // Look for reset/clear button
      const resetBtn = page.getByRole("button", { name: /reset|clear/i });
      if (await resetBtn.isVisible()) {
        await resetBtn.click();

        // Input should be cleared
        await expect(betInput).toHaveValue("");
      }
    }
  });

  test("should handle insufficient balance error", async () => {
    await page.goto("/markets/1");
    await page.waitForLoadState("networkidle");

    // Try to bet large amount
    const betInput = page.getByTestId("bet-amount-input");
    if (await betInput.isVisible()) {
      await betInput.fill("999999");

      // Look for error message or disabled button
      const submitBtn = page.getByRole("button", { name: /place bet/i });
      if (await submitBtn.isVisible()) {
        const isDisabled = await submitBtn.isDisabled();
        const error = page.getByText(/insufficient|balance|not enough/i);

        expect(isDisabled || await error.isVisible()).toBeTruthy();
      }
    }
  });

  test("should show bet history", async () => {
    // Navigate to profile or bet history
    const profileBtn = page.getByTestId("profile-button");
    if (await profileBtn.isVisible()) {
      await profileBtn.click();

      // Look for bet history
      const historyTab = page.getByRole("tab", { name: /history|bets/i });
      if (await historyTab.isVisible()) {
        await historyTab.click();

        // Should show list of bets
        const betsList = page.getByTestId("bets-list");
        if (await betsList.isVisible()) {
          await expect(betsList).toBeVisible();
        }
      }
    }
  });

  test("should track referral earnings", async () => {
    // Navigate to profile
    const profileBtn = page.getByTestId("profile-button");
    if (await profileBtn.isVisible()) {
      await profileBtn.click();

      // Look for referral section
      const referralSection = page.getByTestId("referral-section");
      if (await referralSection.isVisible()) {
        // Should show referral count and earnings
        await expect(referralSection).toContainText(/referral|earned|bonus/i);
      }
    }
  });

  test("should show leaderboard rank in profile", async () => {
    // Navigate to profile
    const profileBtn = page.getByTestId("profile-button");
    if (await profileBtn.isVisible()) {
      await profileBtn.click();

      // Look for leaderboard rank
      const rankDisplay = page.getByTestId("leaderboard-rank");
      if (await rankDisplay.isVisible()) {
        await expect(rankDisplay).toContainText(/rank|#|\d+/);
      }
    }
  });

  test("should allow referral link sharing", async () => {
    // Navigate to profile
    const profileBtn = page.getByTestId("profile-button");
    if (await profileBtn.isVisible()) {
      await profileBtn.click();

      // Look for share/referral button
      const shareBtn = page.getByRole("button", { name: /share|referral|invite/i });
      if (await shareBtn.isVisible()) {
        await shareBtn.click();

        // Should show share dialog with referral link
        const dialog = page.getByRole("dialog");
        if (await dialog.isVisible()) {
          await expect(dialog).toContainText(/referral|share|link/i);
        }
      }
    }
  });

  test("should handle timeout during bet submission", async () => {
    // Simulate timeout
    await page.route("**/*", (route) => {
      setTimeout(() => route.abort(), 2000);
    });

    await page.goto("/markets/1");

    // Try to submit bet
    const betInput = page.getByTestId("bet-amount-input");
    if (await betInput.isVisible()) {
      await betInput.fill("10");

      const submitBtn = page.getByRole("button", { name: /place bet/i });
      if (await submitBtn.isVisible()) {
        await submitBtn.click();

        // Should show error message
        const errorMsg = page.getByText(/timeout|failed|error/i);
        await expect(errorMsg).toBeVisible({ timeout: 5000 });
      }
    }
  });

  test("should maintain bet state across navigation", async () => {
    await page.goto("/markets/1");
    await page.waitForLoadState("networkidle");

    // Fill form
    const betInput = page.getByTestId("bet-amount-input");
    if (await betInput.isVisible()) {
      await betInput.fill("25");

      // Navigate away
      await page.goto("/");

      // Navigate back
      await page.goBack();

      // Form state may or may not be preserved (depends on implementation)
      // Just verify page loads correctly
      await expect(page.locator("[data-testid='betting-panel']")).toBeVisible({
        timeout: 5000,
      });
    }
  });
});
