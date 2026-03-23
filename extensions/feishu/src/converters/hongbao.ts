/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Converter for "hongbao" (red packet) message type.
 */

import type { ContentConverterFn } from "./types.js";
import { safeParse } from "./utils.js";

export const convertHongbao: ContentConverterFn = (raw) => {
  const parsed = safeParse(raw) as
    | {
        text?: string;
      }
    | undefined;

  const text = parsed?.text;
  const textAttr = text ? ` text="${text}"` : "";

  return {
    content: `<hongbao${textAttr}/>`,
    resources: [],
  };
};
