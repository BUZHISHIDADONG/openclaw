/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Guard against operating on unavailable (deleted/recalled) messages.
 *
 * Simplified version for feishu extension - core unavailable message
 * tracking will be implemented when needed.
 */

// ---------------------------------------------------------------------------
// Constructor params
// ---------------------------------------------------------------------------

export interface UnavailableGuardParams {
  replyToMessageId: string | undefined;
  getCardMessageId: () => string | null;
  onTerminate: () => void;
}

// ---------------------------------------------------------------------------
// UnavailableGuard
// ---------------------------------------------------------------------------

export class UnavailableGuard {
  private terminated = false;

  private readonly replyToMessageId: string | undefined;
  private readonly getCardMessageId: () => string | null;
  private readonly onTerminate: () => void;

  constructor(params: UnavailableGuardParams) {
    this.replyToMessageId = params.replyToMessageId;
    this.getCardMessageId = params.getCardMessageId;
    this.onTerminate = params.onTerminate;
  }

  get isTerminated(): boolean {
    return this.terminated;
  }

  /**
   * Check whether the reply pipeline should skip further operations.
   * Returns true if the message is already known to be unavailable.
   */
  shouldSkip(_source: string): boolean {
    return this.terminated;
  }

  /**
   * Attempt to terminate the reply pipeline due to an unavailable message.
   *
   * @param source - Descriptive label for the caller (for logging).
   * @param err    - Optional error that triggered the check.
   * @returns true if the pipeline was (or already had been) terminated.
   */
  terminate(_source: string, _err?: unknown): boolean {
    if (this.terminated) return true;

    // TODO: Implement full unavailable message detection
    // For now, just mark as terminated
    this.terminated = true;
    this.onTerminate();

    return true;
  }
}
