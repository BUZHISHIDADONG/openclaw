import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { registerFeishuBitableTools } from "./src/bitable.js";
import { registerFeishuOfficialCalendarTools } from "./src/calendar-tools.js";
import { feishuPlugin } from "./src/channel.js";
import { registerFeishuChatTools } from "./src/chat.js";
import { registerFeishuDocTools } from "./src/docx.js";
import { registerFeishuDriveTools } from "./src/drive.js";
import { registerFeishuOfficialImTools } from "./src/im-tools.js";
import { registerFeishuOauthTools } from "./src/oauth-tools.js";
import { registerFeishuPermTools } from "./src/perm.js";
import { setFeishuRuntime } from "./src/runtime.js";
import { registerFeishuSearchDocWikiTool } from "./src/search-doc-wiki.js";
import { registerFeishuOfficialSheetTools } from "./src/sheet-tools.js";
import { registerFeishuSubagentHooks } from "./src/subagent-hooks.js";
import { registerFeishuOfficialTaskTools } from "./src/task-tools.js";
import { registerFeishuWikiTools } from "./src/wiki.js";

export { feishuPlugin } from "./src/channel.js";
export { setFeishuRuntime } from "./src/runtime.js";
export { monitorFeishuProvider } from "./src/monitor.js";
export {
  sendMessageFeishu,
  sendCardFeishu,
  updateCardFeishu,
  editMessageFeishu,
  getMessageFeishu,
} from "./src/send.js";
export {
  uploadImageFeishu,
  uploadFileFeishu,
  sendImageFeishu,
  sendFileFeishu,
  sendMediaFeishu,
} from "./src/media.js";
export { probeFeishu } from "./src/probe.js";
export {
  addReactionFeishu,
  removeReactionFeishu,
  listReactionsFeishu,
  FeishuEmoji,
} from "./src/reactions.js";
export {
  extractMentionTargets,
  extractMessageBody,
  isMentionForwardRequest,
  formatMentionForText,
  formatMentionForCard,
  formatMentionAllForText,
  formatMentionAllForCard,
  buildMentionedMessage,
  buildMentionedCardContent,
  type MentionTarget,
} from "./src/mention.js";

export default defineChannelPluginEntry({
  id: "feishu",
  name: "Feishu",
  description: "Feishu/Lark channel plugin",
  plugin: feishuPlugin,
  setRuntime: setFeishuRuntime,
  registerFull(api) {
    registerFeishuSubagentHooks(api);
    registerFeishuDocTools(api);
    registerFeishuChatTools(api);
    registerFeishuWikiTools(api);
    registerFeishuDriveTools(api);
    registerFeishuPermTools(api);
    registerFeishuBitableTools(api);
    registerFeishuOauthTools(api);
    registerFeishuSearchDocWikiTool(api);
    registerFeishuOfficialImTools(api);
    registerFeishuOfficialCalendarTools(api);
    registerFeishuOfficialTaskTools(api);
    registerFeishuOfficialSheetTools(api);
  },
});
