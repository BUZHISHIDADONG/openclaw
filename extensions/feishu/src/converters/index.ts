/**
 * 消息转换器模块导出
 *
 * 统一导出所有转换器和相关工具
 */

// 类型定义
export type {
  ApiMessageItem,
  ConvertContext,
  ConvertResult,
  ContentConverterFn,
  MentionInfo,
  ResourceDescriptor,
  PostElement,
} from "./types.js";

// 核心转换函数
export {
  convertMessageContent,
  buildConvertContextFromItem,
  resolveMentions,
  extractMentionOpenId,
  converters,
} from "./content-converter.js";

// 辅助函数
export { escapeRegExp, safeParse, formatDuration, millisToDatetime } from "./utils.js";

import { convertAudio } from "./audio.js";
import { convertCalendar, convertCalendarEvent, convertCalendarEventChange } from "./calendar.js";
// 转换器实现
import { converters } from "./content-converter.js";
import { convertFile } from "./file.js";
import { convertFolder } from "./folder.js";
import { convertHongbao } from "./hongbao.js";
import { convertImage } from "./image.js";
import { convertInteractive } from "./interactive/index.js";
import { convertLocation } from "./location.js";
import { convertMergeForward } from "./merge-forward.js";
import { convertPost } from "./post.js";
import { convertShareChat, convertShareUser } from "./share.js";
import { convertSticker } from "./sticker.js";
import { convertSystem } from "./system.js";
import { convertText } from "./text.js";
import { convertTodo } from "./todo.js";
import { convertUnknown } from "./unknown.js";
import { convertVideoChat } from "./video-chat.js";
import { convertVideo } from "./video.js";
import { convertVote } from "./vote.js";

// 注册所有转换器
converters.set("text", convertText);
converters.set("image", convertImage);
converters.set("audio", convertAudio);
converters.set("video", convertVideo);
converters.set("media", convertVideo); // media 类型使用 video 转换器
converters.set("file", convertFile);
converters.set("sticker", convertSticker);
converters.set("share_chat", convertShareChat);
converters.set("share_user", convertShareUser);
converters.set("location", convertLocation);
converters.set("system", convertSystem);
converters.set("post", convertPost);
converters.set("vote", convertVote);
converters.set("todo", convertTodo);
converters.set("calendar", convertCalendar);
converters.set("share_calendar_event", convertCalendarEvent);
converters.set("general_calendar", convertCalendarEventChange);
converters.set("video_chat", convertVideoChat);
converters.set("folder", convertFolder);
converters.set("hongbao", convertHongbao);
converters.set("merge_forward", convertMergeForward);
converters.set("interactive", convertInteractive);
converters.set("unknown", convertUnknown);
