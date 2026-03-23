/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Type definitions for the Feishu card subsystem.
 */

import type { ClawdbotConfig, ReplyPayload } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// Card Phase State Machine
// ---------------------------------------------------------------------------

export const CARD_PHASES = {
  idle: "idle",
  creating: "creating",
  streaming: "streaming",
  completed: "completed",
  aborted: "aborted",
  terminated: "terminated",
  creation_failed: "creation_failed",
} as const;

export type CardPhase = (typeof CARD_PHASES)[keyof typeof CARD_PHASES];

export const TERMINAL_PHASES: ReadonlySet<CardPhase> = new Set([
  "completed",
  "aborted",
  "terminated",
  "creation_failed",
]);

export type TerminalReason = "normal" | "error" | "abort" | "unavailable" | "creation_failed";

// ---------------------------------------------------------------------------
// Throttle Constants
// ---------------------------------------------------------------------------

export const THROTTLE_CONSTANTS = {
  CARDKIT_MS: 100,
  PATCH_MS: 1500,
  LONG_GAP_THRESHOLD_MS: 2000,
  BATCH_AFTER_GAP_MS: 300,
} as const;

export const EMPTY_REPLY_FALLBACK_TEXT = "Done.";
