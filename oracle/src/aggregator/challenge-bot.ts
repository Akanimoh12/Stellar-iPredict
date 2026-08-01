import { rpc, xdr, scValToNative, Address, Contract, nativeToScVal, TransactionBuilder, Keypair } from "@stellar/stellar-sdk";
import type { DataAdapter, Market } from "../adapters/index.js";
import { createLogger, type Logger } from "../log.js";

export interface ChallengeBotOptions {
  /** Soroban RPC server URL */
  rpcUrl: string;
  /** Prediction market contract ID */
  contractId: string;
  /** Data adapters to validate submissions against */
  adapters: DataAdapter[];
  /** Keypair for submitting challenges */
  challengerKeypair: Keypair;
  /** Network passphrase (testnet/mainnet) */
  networkPassphrase: string;
  /** Minimum confidence required to challenge (0-1). Defaults to 0.8. */
  minConfidenceToChallenge?: number;
  /** Bond amount for challenging (in stroops). Defaults to 200_0000000 (200 XLM). */
  challengeBondStroops?: bigint;
  /** Polling interval in milliseconds. Defaults to 30_000 (30 seconds). */
  pollIntervalMs?: number;
  /** Logger instance */
  logger?: Logger;
}

export interface OracleSubmission {
  marketId: string;
  submitter: string;
  outcome: boolean;
  bond: bigint;
  submittedAt: number;
  challengeDeadline: number;
}

export interface ChallengeDecision {
  shouldChallenge: boolean;
  reason: string;
  expectedOutcome?: boolean;
  confidence?: number;
}

export interface ChallengeResult {
  marketId: string;
  challenged: boolean;
  txHash?: string;
  error?: string;
  reason: string;
}

/**
 * Challenge bot that monitors optimistic oracle submissions and automatically
 * challenges clearly-wrong submissions based on data adapter validation.
 * 
 * This bot:
 * 1. Polls for oracle submission events
 * 2. Validates each submission against registered data adapters
 * 3. Challenges submissions that don't match the data with high confidence
 * 4. Prevents double-challenging by tracking state
 */
export class ChallengeBot {
  private readonly server: rpc.Server;
  private readonly logger: Logger;
  private readonly minConfidence: number;
  private readonly challengeBond: bigint;
  private readonly pollInterval: number;
  private readonly processedSubmissions = new Set<string>();
  private abortController = new AbortController();

  constructor(private readonly options: ChallengeBotOptions) {
    this.server = new rpc.Server(options.rpcUrl);
    this.logger = options.logger ?? createLogger({ level: "info", bindings: { service: "challenge-bot" } });
    this.minConfidence = options.minConfidenceToChallenge ?? 0.8;
    this.challengeBond = options.challengeBondStroops ?? 200_0000000n; // 200 XLM
    this.pollInterval = options.pollIntervalMs ?? 30_000;
  }

  /**
   * Start the challenge bot polling loop.
   */
  async start(): Promise<void> {
    this.logger.info("Challenge bot starting", {
      contractId: this.options.contractId,
      challenger: this.options.challengerKeypair.publicKey(),
      minConfidence: this.minConfidence,
      challengeBond: this.challengeBond.toString(),
    });

    while (!this.abortController.signal.aborted) {
      try {
        await this.pollAndChallenge();
      } catch (error) {
        this.logger.error("Error during poll cycle", { error: error instanceof Error ? error.message : String(error) });
      }

      if (!this.abortController.signal.aborted) {
        await this.sleep(this.pollInterval);
      }
    }

    this.logger.info("Challenge bot stopped");
  }

  /**
   * Stop the challenge bot.
   */
  stop(): void {
    this.abortController.abort();
  }

  private async pollAndChallenge(): Promise<void> {
    const latestLedger = await this.server.getLatestLedger();
    const events = await this.server.getEvents({
      startLedger: latestLedger.sequence - 100, // Look back 100 ledgers
      filters: [
        {
          type: "contract",
          contractIds: [this.options.contractId],
          topics: [["oracle", "submitted"]],
        },
      ],
    });

    for (const event of events.events) {
      try {
        const submission = this.parseSubmissionEvent(event);
        if (submission && !this.processedSubmissions.has(submission.marketId)) {
          await this.processSubmission(submission);
          this.processedSubmissions.add(submission.marketId);
        }
      } catch (error) {
        this.logger.warn("Failed to process event", { 
          eventId: event.id, 
          error: error instanceof Error ? error.message : String(error) 
        });
      }
    }
  }

  private parseSubmissionEvent(event: rpc.Api.EventResponse): OracleSubmission | null {
    try {
      const topics = event.topic.map((t: xdr.ScVal) => scValToNative(t));
      const data = scValToNative(event.value);

      if (topics[0] !== "oracle" || topics[1] !== "submitted") {
        return null;
      }

      return {
        marketId: String(data.market_id),
        submitter: data.submitter,
        outcome: data.outcome,
        bond: BigInt(data.bond),
        submittedAt: Number(data.submitted_at),
        challengeDeadline: Number(data.challenge_deadline),
      };
    } catch {
      return null;
    }
  }

  private async processSubmission(submission: OracleSubmission): Promise<ChallengeResult> {
    this.logger.info("Processing submission", {
      marketId: submission.marketId,
      submitter: submission.submitter,
      outcome: submission.outcome,
      bond: submission.bond.toString(),
    });

    // Check if we're still within the challenge window
    const now = Math.floor(Date.now() / 1000);
    if (now > submission.challengeDeadline) {
      this.logger.info("Challenge window closed", { marketId: submission.marketId });
      return { marketId: submission.marketId, challenged: false, reason: "Challenge window closed" };
    }

    // Validate the submission against data adapters
    const decision = await this.evaluateSubmission(submission);

    if (!decision.shouldChallenge) {
      this.logger.info("Submission appears valid, not challenging", {
        marketId: submission.marketId,
        reason: decision.reason,
      });
      return { marketId: submission.marketId, challenged: false, reason: decision.reason };
    }

    this.logger.warn("Challenging submission", {
      marketId: submission.marketId,
      reason: decision.reason,
      expectedOutcome: decision.expectedOutcome,
    });

    return this.challengeSubmission(submission, decision.expectedOutcome ?? !submission.outcome);
  }

  private async evaluateSubmission(submission: OracleSubmission): Promise<ChallengeDecision> {
    // Build a market object for adapters
    const market: Market = {
      id: submission.marketId,
      category: this.inferCategory(submission.marketId),
      params: this.extractParams(submission.marketId),
    };

    // Try each adapter to validate the outcome
    for (const adapter of this.options.adapters) {
      if (!adapter.supports(market)) {
        continue;
      }

      try {
        const result = await adapter.fetchOutcome(market);
        
        if (result.confidence < this.minConfidence) {
          continue; // Not confident enough to challenge
        }

        if (result.outcome !== submission.outcome) {
          return {
            shouldChallenge: true,
            reason: `Adapter ${adapter.id} disagrees with high confidence (${result.confidence})`,
            expectedOutcome: result.outcome,
            confidence: result.confidence,
          };
        }

        // Adapter agrees with submission - don't challenge
        return {
          shouldChallenge: false,
          reason: `Adapter ${adapter.id} confirms the submission`,
          expectedOutcome: result.outcome,
          confidence: result.confidence,
        };
      } catch (error) {
        this.logger.warn(`Adapter ${adapter.id} failed`, {
          marketId: submission.marketId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // No adapter could confidently validate - don't challenge
    return {
      shouldChallenge: false,
      reason: "No adapter could confidently validate the submission",
    };
  }

  private async challengeSubmission(
    submission: OracleSubmission,
    correctOutcome: boolean,
  ): Promise<ChallengeResult> {
    try {
      const txHash = await this.submitChallengeOnChain(submission.marketId, correctOutcome);
      
      this.logger.info("Challenge submitted successfully", {
        marketId: submission.marketId,
        txHash,
        correctOutcome,
      });

      return {
        marketId: submission.marketId,
        challenged: true,
        txHash,
        reason: "Challenged due to data adapter disagreement",
      };
    } catch (error) {
      this.logger.error("Failed to submit challenge", {
        marketId: submission.marketId,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        marketId: submission.marketId,
        challenged: false,
        reason: `Failed to submit challenge: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async submitChallengeOnChain(marketId: string, outcome: boolean): Promise<string> {
    const { challengerKeypair, contractId, networkPassphrase } = this.options;
    const caller = challengerKeypair.publicKey();
    const sourceAccount = await this.server.getAccount(caller);
    
    const contract = new Contract(contractId);

    const operation = contract.call(
      "challenge",
      new Address(caller).toScVal(),
      nativeToScVal(BigInt(marketId), { type: "u64" }),
      nativeToScVal(outcome, { type: "bool" }),
      nativeToScVal(this.challengeBond, { type: "i128" }),
    );

    const tx = new TransactionBuilder(sourceAccount, {
      fee: "100000",
      networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(300)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(challengerKeypair);

    const response = await this.server.sendTransaction(prepared);
    if (response.status === "ERROR" || response.status === "TRY_AGAIN_LATER") {
      throw new Error(`challenge failed for market ${marketId}: ${response.status}`);
    }

    return response.hash;
  }

  private inferCategory(marketId: string): Market["category"] {
    // Simple heuristic - in production, this would come from market metadata
    const lower = marketId.toLowerCase();
    if (lower.includes("btc") || lower.includes("eth") || lower.includes("crypto")) {
      return "crypto";
    }
    if (lower.includes("election") || lower.includes("politic")) {
      return "politics";
    }
    return "science"; // Default fallback
  }

  private extractParams(marketId: string): Record<string, unknown> {
    // In production, this would fetch actual market parameters from the contract or DB
    // For now, return minimal params that adapters can work with
    return { marketId };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      return () => clearTimeout(timer);
    });
  }
}

/**
 * Create and start a challenge bot with the given options.
 */
export async function startChallengeBot(options: ChallengeBotOptions): Promise<ChallengeBot> {
  const bot = new ChallengeBot(options);
  // Start in background
  bot.start().catch((error) => {
    options.logger?.error("Challenge bot crashed", { error: error instanceof Error ? error.message : String(error) });
  });
  return bot;
}
