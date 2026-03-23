/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Card module exports - streaming card sub-controllers and utilities.
 */

export { FlushController } from "./flush-controller.js";
export { UnavailableGuard } from "./unavailable-guard.js";
export type { UnavailableGuardParams } from "./unavailable-guard.js";
export { ImageResolver } from "./image-resolver.js";
export type { ImageResolverOptions } from "./image-resolver.js";
export {
  buildCardContent,
  splitReasoningText,
  stripReasoningTags,
  formatReasoningDuration,
  formatElapsed,
  toCardKit2,
  STREAMING_ELEMENT_ID,
  REASONING_ELEMENT_ID,
} from "./builder.js";
export type { ToolCallInfo, CardElement, FeishuCard, CardState, ConfirmData } from "./builder.js";
export { optimizeMarkdownStyle } from "./markdown-style.js";
export {
  CARD_PHASES,
  TERMINAL_PHASES,
  THROTTLE_CONSTANTS,
  EMPTY_REPLY_FALLBACK_TEXT,
} from "./types.js";
export type { CardPhase, TerminalReason } from "./types.js";
