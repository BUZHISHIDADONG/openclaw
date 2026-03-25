import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuOfficialToolClient } from "./official-auth/tool-client.js";
import {
  parseTimeToRFC3339,
  parseTimeToTimestampSeconds,
  unixTimestampToISO8601,
} from "./official-time.js";
import {
  assertLarkOk,
  createFeishuToolLogger,
  handleFeishuAuthAwareError,
  json,
  resolveTrustedFeishuRequesterOpenId,
  StringEnum,
} from "./official-tools-helpers.js";
import { resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";

const CalendarCalendarSchema = Type.Object({
  action: StringEnum(["list", "get", "primary"], {
    description: "list | get | primary",
  }),
  calendar_id: Type.Optional(Type.String()),
  page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  page_token: Type.Optional(Type.String()),
});

const CalendarEventSchema = Type.Object({
  action: StringEnum(
    ["create", "list", "get", "patch", "delete", "search", "reply", "instances", "instance_view"],
    {
      description:
        "create | list | get | patch | delete | search | reply | instances | instance_view",
    },
  ),
  calendar_id: Type.Optional(Type.String()),
  event_id: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  query: Type.Optional(Type.String()),
  start_time: Type.Optional(
    Type.String({
      description: "ISO 8601 / RFC 3339 时间，例如 2026-03-24T10:00:00+08:00",
    }),
  ),
  end_time: Type.Optional(
    Type.String({
      description: "ISO 8601 / RFC 3339 时间，例如 2026-03-24T11:00:00+08:00",
    }),
  ),
  user_open_id: Type.Optional(
    Type.String({ description: "当前用户 open_id；不传时默认取当前 Feishu 请求人" }),
  ),
  attendees: Type.Optional(
    Type.Array(
      Type.Object({
        type: StringEnum(["user", "chat", "resource", "third_party"]),
        id: Type.String(),
      }),
      { maxItems: 100 },
    ),
  ),
  vchat: Type.Optional(
    Type.Object({
      vc_type: Type.Optional(StringEnum(["vc", "third_party", "no_meeting"])),
      icon_type: Type.Optional(StringEnum(["vc", "live", "default"])),
      description: Type.Optional(Type.String()),
      meeting_url: Type.Optional(Type.String()),
    }),
  ),
  visibility: Type.Optional(StringEnum(["default", "public", "private"])),
  attendee_ability: Type.Optional(
    StringEnum(["none", "can_see_others", "can_invite_others", "can_modify_event"]),
  ),
  free_busy_status: Type.Optional(StringEnum(["busy", "free"])),
  location: Type.Optional(
    Type.Object({
      name: Type.Optional(Type.String()),
      address: Type.Optional(Type.String()),
      latitude: Type.Optional(Type.Number()),
      longitude: Type.Optional(Type.Number()),
    }),
  ),
  reminders: Type.Optional(
    Type.Array(
      Type.Object({
        minutes: Type.Integer({ minimum: -20_160, maximum: 20_160 }),
      }),
      { maxItems: 20 },
    ),
  ),
  recurrence: Type.Optional(Type.String()),
  need_notification: Type.Optional(Type.Boolean()),
  page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  page_token: Type.Optional(Type.String()),
  rsvp_status: Type.Optional(
    StringEnum(["accept", "decline", "tentative"], {
      description: "accept | decline | tentative",
    }),
  ),
});

const CalendarFreebusySchema = Type.Object({
  action: Type.Optional(StringEnum(["list"])),
  time_min: Type.String({
    description: "查询开始时间，ISO 8601 / RFC 3339 格式",
  }),
  time_max: Type.String({
    description: "查询结束时间，ISO 8601 / RFC 3339 格式",
  }),
  user_ids: Type.Array(Type.String(), {
    minItems: 1,
    maxItems: 10,
  }),
});

type CalendarCalendarParams = {
  action: "list" | "get" | "primary";
  calendar_id?: string;
  page_size?: number;
  page_token?: string;
  accountId?: string;
};

type CalendarEventParams = {
  action:
    | "create"
    | "list"
    | "get"
    | "patch"
    | "delete"
    | "search"
    | "reply"
    | "instances"
    | "instance_view";
  calendar_id?: string;
  event_id?: string;
  summary?: string;
  description?: string;
  query?: string;
  start_time?: string;
  end_time?: string;
  user_open_id?: string;
  attendees?: Array<{
    type: "user" | "chat" | "resource" | "third_party";
    id: string;
  }>;
  vchat?: {
    vc_type?: "vc" | "third_party" | "no_meeting";
    icon_type?: "vc" | "live" | "default";
    description?: string;
    meeting_url?: string;
  };
  visibility?: "default" | "public" | "private";
  attendee_ability?: "none" | "can_see_others" | "can_invite_others" | "can_modify_event";
  free_busy_status?: "busy" | "free";
  location?: {
    name?: string;
    address?: string;
    latitude?: number;
    longitude?: number;
  };
  reminders?: Array<{ minutes: number }>;
  recurrence?: string;
  need_notification?: boolean;
  page_size?: number;
  page_token?: string;
  rsvp_status?: "accept" | "decline" | "tentative";
  accountId?: string;
};

type CalendarFreebusyParams = {
  action?: "list";
  time_min: string;
  time_max: string;
  user_ids: string[];
  accountId?: string;
};

function normalizeTimeFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeTimeFields(item)) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.endsWith("_time") || key.endsWith("_at") || key === "timestamp") {
      result[key] = unixTimestampToISO8601(item as string | number | undefined) ?? item;
      continue;
    }
    result[key] = normalizeTimeFields(item);
  }
  return result as T;
}

async function resolvePrimaryCalendarId(
  client: ReturnType<typeof createFeishuOfficialToolClient>,
): Promise<string> {
  const response = await client.invoke<{
    code?: number;
    msg?: string;
    data?: {
      calendars?: Array<{
        calendar_id?: string;
        calendar?: { calendar_id?: string };
      }>;
      calendar_list?: Array<{
        calendar_id?: string;
        calendar?: { calendar_id?: string };
      }>;
    };
  }>("feishu_calendar_calendar.primary", (sdk, opts) => sdk.calendar.calendar.primary({}, opts), {
    as: "user",
  });
  assertLarkOk(response);

  const calendarId =
    response.data?.calendars?.[0]?.calendar_id ??
    response.data?.calendars?.[0]?.calendar?.calendar_id ??
    response.data?.calendar_list?.[0]?.calendar_id ??
    response.data?.calendar_list?.[0]?.calendar?.calendar_id;
  if (!calendarId) {
    throw new Error("Could not determine primary calendar");
  }
  return calendarId;
}

async function resolveCalendarId(
  client: ReturnType<typeof createFeishuOfficialToolClient>,
  calendarId?: string,
): Promise<string> {
  const normalized = calendarId?.trim();
  return normalized || (await resolvePrimaryCalendarId(client));
}

function parseCalendarSeconds(value: string | undefined, fieldName: string): string {
  if (!value) {
    throw new Error(`${fieldName} is required`);
  }
  const timestamp = parseTimeToTimestampSeconds(value);
  if (!timestamp) {
    throw new Error(`Invalid ${fieldName}: ${value}`);
  }
  return timestamp;
}

function buildLocation(location: CalendarEventParams["location"]) {
  if (!location) {
    return undefined;
  }

  return {
    ...(location.name ? { name: location.name } : {}),
    ...(location.address ? { address: location.address } : {}),
    ...(location.latitude !== undefined ? { latitude: location.latitude } : {}),
    ...(location.longitude !== undefined ? { longitude: location.longitude } : {}),
  };
}

function registerCalendarCalendarTool(api: OpenClawPluginApi) {
  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      const requesterOpenId = resolveTrustedFeishuRequesterOpenId(ctx);
      const log = createFeishuToolLogger(api, "feishu_calendar_calendar");
      return {
        name: "feishu_calendar_calendar",
        label: "Feishu Calendar",
        description: "以用户身份查询飞书日历列表、详情和主日历。",
        parameters: CalendarCalendarSchema,
        async execute(_toolCallId, params) {
          const p = params as CalendarCalendarParams;
          const client = createFeishuOfficialToolClient({
            api,
            executeParams: p,
            defaultAccountId,
            requesterOpenId,
          });
          try {
            switch (p.action) {
              case "list": {
                log.info(
                  `action=list page_size=${String(p.page_size ?? 50)} page_token=${p.page_token ?? ""}`,
                );
                const response = await client.invoke<{
                  code?: number;
                  msg?: string;
                  data?: {
                    calendar_list?: unknown[];
                    has_more?: boolean;
                    page_token?: string;
                  };
                }>(
                  "feishu_calendar_calendar.list",
                  (sdk, opts) =>
                    sdk.calendar.calendar.list(
                      {
                        params: {
                          page_size: p.page_size ?? 50,
                          page_token: p.page_token,
                        },
                      },
                      opts,
                    ),
                  { as: "user" },
                );
                assertLarkOk(response);
                return json({
                  calendars: response.data?.calendar_list ?? [],
                  has_more: response.data?.has_more ?? false,
                  page_token: response.data?.page_token,
                });
              }
              case "get": {
                if (!p.calendar_id) {
                  return json({ error: "calendar_id is required for action=get" });
                }
                const response = await client.invoke<{
                  code?: number;
                  msg?: string;
                  data?: unknown;
                }>(
                  "feishu_calendar_calendar.get",
                  (sdk, opts) =>
                    sdk.calendar.calendar.get(
                      {
                        path: { calendar_id: p.calendar_id! },
                      },
                      opts,
                    ),
                  { as: "user" },
                );
                assertLarkOk(response);
                return json({
                  calendar: normalizeTimeFields(response.data ?? {}),
                });
              }
              case "primary": {
                const response = await client.invoke<{
                  code?: number;
                  msg?: string;
                  data?: {
                    calendars?: unknown[];
                    calendar_list?: unknown[];
                  };
                }>(
                  "feishu_calendar_calendar.primary",
                  (sdk, opts) => sdk.calendar.calendar.primary({}, opts),
                  { as: "user" },
                );
                assertLarkOk(response);
                return json({
                  calendars: normalizeTimeFields(
                    response.data?.calendars ?? response.data?.calendar_list ?? [],
                  ),
                });
              }
              default:
                return json({ error: `Unknown action: ${String(p.action)}` });
            }
          } catch (error) {
            return await handleFeishuAuthAwareError({
              error,
              api,
              account: client.account,
              requesterOpenId,
            });
          }
        },
      };
    },
    { name: "feishu_calendar_calendar" },
  );
}

function registerCalendarEventTool(api: OpenClawPluginApi) {
  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      const requesterOpenId = resolveTrustedFeishuRequesterOpenId(ctx);
      const log = createFeishuToolLogger(api, "feishu_calendar_event");
      return {
        name: "feishu_calendar_event",
        label: "Feishu Calendar Event",
        description: "以用户身份创建、查询、更新、删除、搜索和回复飞书日程。",
        parameters: CalendarEventSchema,
        async execute(_toolCallId, params) {
          const p = params as CalendarEventParams;
          const client = createFeishuOfficialToolClient({
            api,
            executeParams: p,
            defaultAccountId,
            requesterOpenId,
          });
          try {
            switch (p.action) {
              case "create": {
                if (!p.summary || !p.start_time || !p.end_time) {
                  return json({
                    error: "summary, start_time, and end_time are required for action=create",
                  });
                }

                const calendarId = await resolveCalendarId(client, p.calendar_id);
                const startTimestamp = parseCalendarSeconds(p.start_time, "start_time");
                const endTimestamp = parseCalendarSeconds(p.end_time, "end_time");
                const currentUserOpenId = p.user_open_id?.trim() || requesterOpenId;
                const eventData = {
                  summary: p.summary,
                  start_time: { timestamp: startTimestamp },
                  end_time: { timestamp: endTimestamp },
                  ...(p.description ? { description: p.description } : {}),
                  ...(p.vchat ? { vchat: p.vchat } : {}),
                  ...(p.visibility ? { visibility: p.visibility } : {}),
                  ...(p.attendee_ability ? { attendee_ability: p.attendee_ability } : {}),
                  ...(p.free_busy_status ? { free_busy_status: p.free_busy_status } : {}),
                  ...(buildLocation(p.location) ? { location: buildLocation(p.location) } : {}),
                  ...(p.reminders?.length
                    ? { reminders: p.reminders.map((reminder) => ({ minutes: reminder.minutes })) }
                    : {}),
                  ...(p.recurrence ? { recurrence: p.recurrence } : {}),
                  need_notification: true,
                };

                const createResponse = await client.invoke<{
                  code?: number;
                  msg?: string;
                  data?: {
                    event?: {
                      event_id?: string;
                      summary?: string;
                      app_link?: string;
                    };
                  };
                }>(
                  "feishu_calendar_event.create",
                  (sdk, opts) =>
                    sdk.calendar.calendarEvent.create(
                      {
                        path: { calendar_id: calendarId },
                        data: eventData,
                      },
                      opts,
                    ),
                  { as: "user" },
                );
                assertLarkOk(createResponse);

                const eventId = createResponse.data?.event?.event_id;
                const attendees = [...(p.attendees ?? [])];
                if (
                  currentUserOpenId &&
                  !attendees.some(
                    (attendee) => attendee.type === "user" && attendee.id === currentUserOpenId,
                  )
                ) {
                  attendees.push({ type: "user", id: currentUserOpenId });
                }

                let warning: string | undefined;
                if (eventId && attendees.length > 0) {
                  const operateId =
                    currentUserOpenId ?? attendees.find((attendee) => attendee.type === "user")?.id;
                  try {
                    const attendeeResponse = await client.invoke<{
                      code?: number;
                      msg?: string;
                    }>(
                      "feishu_calendar_event.create",
                      (sdk, opts) =>
                        sdk.calendar.calendarEventAttendee.create(
                          {
                            path: {
                              calendar_id: calendarId,
                              event_id: eventId,
                            },
                            params: { user_id_type: "open_id" },
                            data: {
                              attendees: attendees.map((attendee) => ({
                                type: attendee.type,
                                user_id: attendee.type === "user" ? attendee.id : undefined,
                                chat_id: attendee.type === "chat" ? attendee.id : undefined,
                                room_id: attendee.type === "resource" ? attendee.id : undefined,
                                third_party_email:
                                  attendee.type === "third_party" ? attendee.id : undefined,
                                operate_id: operateId,
                              })),
                              need_notification: true,
                            },
                          },
                          opts,
                        ),
                      { as: "user" },
                    );
                    assertLarkOk(attendeeResponse);
                  } catch (error) {
                    warning = error instanceof Error ? error.message : String(error);
                  }
                } else if (attendees.length === 0) {
                  warning =
                    "The event was created on the app calendar, but no attendee was added. Provide user_open_id or attendees so the user can see it in Feishu Calendar.";
                }

                return json({
                  event: {
                    event_id: eventId,
                    summary: createResponse.data?.event?.summary,
                    app_link: createResponse.data?.event?.app_link,
                    start_time: unixTimestampToISO8601(startTimestamp),
                    end_time: unixTimestampToISO8601(endTimestamp),
                  },
                  attendees,
                  ...(warning ? { warning } : {}),
                });
              }
              case "list":
              case "instance_view": {
                if (!p.start_time || !p.end_time) {
                  return json({ error: "start_time and end_time are required" });
                }
                const calendarId = await resolveCalendarId(client, p.calendar_id);
                const startTimestamp = parseCalendarSeconds(p.start_time, "start_time");
                const endTimestamp = parseCalendarSeconds(p.end_time, "end_time");
                log.info(
                  `action=${p.action} calendar_id=${calendarId} start=${startTimestamp} end=${endTimestamp}`,
                );
                const response = await client.invokeByPath<{
                  code?: number;
                  msg?: string;
                  data?: {
                    items?: unknown[];
                    has_more?: boolean;
                    page_token?: string;
                  };
                }>(
                  "feishu_calendar_event.instance_view",
                  `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/instance_view`,
                  {
                    method: "GET",
                    query: {
                      start_time: startTimestamp,
                      end_time: endTimestamp,
                      page_size: p.page_size,
                      page_token: p.page_token,
                      user_id_type: "open_id",
                    },
                    as: "user",
                  },
                );
                assertLarkOk(response);
                return json({
                  events: normalizeTimeFields(response.data?.items ?? []),
                  has_more: response.data?.has_more ?? false,
                  page_token: response.data?.page_token,
                });
              }
              case "get": {
                if (!p.event_id) {
                  return json({ error: "event_id is required for action=get" });
                }
                const calendarId = await resolveCalendarId(client, p.calendar_id);
                const needNotification = (p.need_notification ?? true) ? "true" : "false";
                const response = await client.invoke<{
                  code?: number;
                  msg?: string;
                  data?: {
                    event?: unknown;
                  };
                }>(
                  "feishu_calendar_event.get",
                  (sdk, opts) =>
                    sdk.calendar.calendarEvent.get(
                      {
                        path: { calendar_id: calendarId, event_id: p.event_id! },
                      },
                      opts,
                    ),
                  { as: "user" },
                );
                assertLarkOk(response);
                return json({
                  event: normalizeTimeFields(response.data?.event ?? {}),
                });
              }
              case "patch": {
                if (!p.event_id) {
                  return json({ error: "event_id is required for action=patch" });
                }
                const calendarId = await resolveCalendarId(client, p.calendar_id);
                const updateData = {
                  ...(p.summary ? { summary: p.summary } : {}),
                  ...(p.description !== undefined ? { description: p.description } : {}),
                  ...(p.start_time
                    ? {
                        start_time: { timestamp: parseCalendarSeconds(p.start_time, "start_time") },
                      }
                    : {}),
                  ...(p.end_time
                    ? { end_time: { timestamp: parseCalendarSeconds(p.end_time, "end_time") } }
                    : {}),
                  ...(p.location?.name ? { location: { name: p.location.name } } : {}),
                };
                if (Object.keys(updateData).length === 0) {
                  return json({ error: "No fields provided for action=patch" });
                }
                const response = await client.invoke<{
                  code?: number;
                  msg?: string;
                  data?: {
                    event?: unknown;
                  };
                }>(
                  "feishu_calendar_event.patch",
                  (sdk, opts) =>
                    sdk.calendar.calendarEvent.patch(
                      {
                        path: { calendar_id: calendarId, event_id: p.event_id! },
                        data: updateData,
                      },
                      opts,
                    ),
                  { as: "user" },
                );
                assertLarkOk(response);
                return json({
                  event: normalizeTimeFields(response.data?.event ?? {}),
                });
              }
              case "delete": {
                if (!p.event_id) {
                  return json({ error: "event_id is required for action=delete" });
                }
                const calendarId = await resolveCalendarId(client, p.calendar_id);
                const needNotification = (p.need_notification ?? true) ? "true" : "false";
                const response = await client.invoke<{
                  code?: number;
                  msg?: string;
                }>(
                  "feishu_calendar_event.delete",
                  (sdk, opts) =>
                    sdk.calendar.calendarEvent.delete(
                      {
                        path: { calendar_id: calendarId, event_id: p.event_id! },
                        params: {
                          need_notification: needNotification,
                        },
                      },
                      opts,
                    ),
                  { as: "user" },
                );
                assertLarkOk(response);
                return json({
                  success: true,
                  event_id: p.event_id,
                });
              }
              case "search": {
                if (!p.query) {
                  return json({ error: "query is required for action=search" });
                }
                const calendarId = await resolveCalendarId(client, p.calendar_id);
                const query = p.query;
                const response = await client.invoke<{
                  code?: number;
                  msg?: string;
                  data?: {
                    items?: unknown[];
                    has_more?: boolean;
                    page_token?: string;
                  };
                }>(
                  "feishu_calendar_event.search",
                  (sdk, opts) =>
                    sdk.calendar.calendarEvent.search(
                      {
                        path: { calendar_id: calendarId },
                        params: {
                          page_size: p.page_size,
                          page_token: p.page_token,
                        },
                        data: {
                          query,
                        },
                      },
                      opts,
                    ),
                  { as: "user" },
                );
                assertLarkOk(response);
                return json({
                  events: normalizeTimeFields(response.data?.items ?? []),
                  has_more: response.data?.has_more ?? false,
                  page_token: response.data?.page_token,
                });
              }
              case "reply": {
                if (!p.event_id || !p.rsvp_status) {
                  return json({
                    error: "event_id and rsvp_status are required for action=reply",
                  });
                }
                const calendarId = await resolveCalendarId(client, p.calendar_id);
                const rsvpStatus = p.rsvp_status;
                const response = await client.invoke<{
                  code?: number;
                  msg?: string;
                }>(
                  "feishu_calendar_event.reply",
                  (sdk, opts) =>
                    sdk.calendar.calendarEvent.reply(
                      {
                        path: { calendar_id: calendarId, event_id: p.event_id! },
                        data: {
                          rsvp_status: rsvpStatus,
                        },
                      },
                      opts,
                    ),
                  { as: "user" },
                );
                assertLarkOk(response);
                return json({
                  success: true,
                  event_id: p.event_id,
                  rsvp_status: rsvpStatus,
                });
              }
              case "instances": {
                if (!p.event_id || !p.start_time || !p.end_time) {
                  return json({
                    error: "event_id, start_time, and end_time are required for action=instances",
                  });
                }
                const calendarId = await resolveCalendarId(client, p.calendar_id);
                const startTimestamp = parseCalendarSeconds(p.start_time, "start_time");
                const endTimestamp = parseCalendarSeconds(p.end_time, "end_time");
                const response = await client.invoke<{
                  code?: number;
                  msg?: string;
                  data?: {
                    items?: unknown[];
                    has_more?: boolean;
                    page_token?: string;
                  };
                }>(
                  "feishu_calendar_event.instances",
                  (sdk, opts) =>
                    sdk.calendar.calendarEvent.instances(
                      {
                        path: { calendar_id: calendarId, event_id: p.event_id! },
                        params: {
                          start_time: startTimestamp,
                          end_time: endTimestamp,
                          page_size: p.page_size,
                          page_token: p.page_token,
                        },
                      },
                      opts,
                    ),
                  { as: "user" },
                );
                assertLarkOk(response);
                return json({
                  instances: normalizeTimeFields(response.data?.items ?? []),
                  has_more: response.data?.has_more ?? false,
                  page_token: response.data?.page_token,
                });
              }
              default:
                return json({ error: `Unknown action: ${String(p.action)}` });
            }
          } catch (error) {
            return await handleFeishuAuthAwareError({
              error,
              api,
              account: client.account,
              requesterOpenId,
            });
          }
        },
      };
    },
    { name: "feishu_calendar_event" },
  );
}

function registerCalendarFreebusyTool(api: OpenClawPluginApi) {
  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      const requesterOpenId = resolveTrustedFeishuRequesterOpenId(ctx);
      return {
        name: "feishu_calendar_freebusy",
        label: "Feishu Calendar FreeBusy",
        description: "以用户身份批量查询用户在指定时间区间的忙闲状态。",
        parameters: CalendarFreebusySchema,
        async execute(_toolCallId, params) {
          const p = params as CalendarFreebusyParams;
          const client = createFeishuOfficialToolClient({
            api,
            executeParams: p,
            defaultAccountId,
            requesterOpenId,
          });
          try {
            const timeMin = parseTimeToRFC3339(p.time_min);
            const timeMax = parseTimeToRFC3339(p.time_max);
            if (!timeMin || !timeMax) {
              return json({
                error: "time_min and time_max must be valid ISO 8601 / RFC 3339 datetimes",
              });
            }

            const response = await client.invoke<{
              code?: number;
              msg?: string;
              data?: {
                freebusy_lists?: unknown[];
              };
            }>(
              "feishu_calendar_freebusy.list",
              (sdk, opts) =>
                sdk.calendar.freebusy.batch(
                  {
                    data: {
                      time_min: timeMin,
                      time_max: timeMax,
                      user_ids: p.user_ids,
                      include_external_calendar: true,
                      only_busy: true,
                    },
                  },
                  opts,
                ),
              { as: "user" },
            );
            assertLarkOk(response);
            return json({
              freebusy_lists: normalizeTimeFields(response.data?.freebusy_lists ?? []),
            });
          } catch (error) {
            return await handleFeishuAuthAwareError({
              error,
              api,
              account: client.account,
              requesterOpenId,
            });
          }
        },
      };
    },
    { name: "feishu_calendar_freebusy" },
  );
}

export function registerFeishuOfficialCalendarTools(api: OpenClawPluginApi) {
  if (!api.config) {
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_calendar_tools: No Feishu accounts configured, skipping");
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.calendar) {
    api.logger.debug?.("feishu_calendar_tools: Calendar tools disabled in config");
    return;
  }

  registerCalendarCalendarTool(api);
  registerCalendarEventTool(api);
  registerCalendarFreebusyTool(api);
  api.logger.info?.(
    "feishu_calendar_tools: Registered feishu_calendar_calendar, feishu_calendar_event, feishu_calendar_freebusy",
  );
}
