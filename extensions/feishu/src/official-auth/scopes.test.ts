import { describe, expect, it } from "vitest";
import {
  applyFeishuUatScopePolicy,
  getAllKnownFeishuBusinessScopes,
  getFeishuRequiredScopes,
} from "./scopes.js";

describe("Feishu UAT scopes", () => {
  it("returns known scopes for migrated IM search tool", () => {
    expect(getFeishuRequiredScopes("feishu_im_user_search_messages.default")).toContain(
      "search:message",
    );
  });

  it("filters scopes by allowed list", () => {
    expect(
      applyFeishuUatScopePolicy(["calendar:calendar:read", "search:docs:read"], {
        allowedScopes: ["search:docs:read"],
      }),
    ).toEqual(["search:docs:read"]);
  });

  it("filters blocked scopes from the full business scope set", () => {
    const scopes = getAllKnownFeishuBusinessScopes({
      blockedScopes: ["search:docs:read"],
    });
    expect(scopes).not.toContain("search:docs:read");
    expect(scopes).toContain("task:task:write");
  });
});
