import type { Payment, Webhook } from "@prisma/client";
import { createHmac } from "crypto";
import { compile } from "handlebars";

import type { TGetTranscriptAccessLink } from "@calcom/app-store/dailyvideo/zod";
import { getHumanReadableLocationValue } from "@calcom/app-store/locations";
import { getUTCOffsetByTimezone } from "@calcom/lib/dayjs";
import type { CalendarEvent, Person } from "@calcom/types/Calendar";

type ContentType = "application/json" | "application/x-www-form-urlencoded";

export type EventTypeInfo = {
  eventTitle?: string | null;
  eventDescription?: string | null;
  requiresConfirmation?: boolean | null;
  price?: number | null;
  currency?: string | null;
  length?: number | null;
};

export type UTCOffset = {
  utcOffset?: number | null;
};

export type WithUTCOffsetType<T> = T & {
  user?: Person & UTCOffset;
} & {
  organizer?: Person & UTCOffset;
} & {
  attendees?: (Person & UTCOffset)[];
};

export type BookingNoShowUpdatedPayload = {
  message: string;
  bookingUid: string;
  bookingId?: number;
  attendees: { email: string; noShow: boolean }[];
};

export type TranscriptionGeneratedPayload = {
  downloadLinks?: {
    transcription: TGetTranscriptAccessLink["transcription"];
    recording: string;
  };
};

export type OOOEntryPayloadType = {
  oooEntry: {
    id: number;
    start: string;
    end: string;
    createdAt: string;
    updatedAt: string;
    notes: string | null;
    reason: {
      emoji?: string;
      reason?: string;
    };
    reasonId: number;
    user: {
      id: number;
      name: string | null;
      username: string | null;
      timeZone: string;
      email: string;
    };
    toUser: {
      id: number;
      name?: string | null;
      username?: string | null;
      timeZone?: string;
      email?: string;
    } | null;
    uuid: string;
  };
};

export type EventPayloadType = CalendarEvent &
  TranscriptionGeneratedPayload &
  EventTypeInfo & {
    metadata?: { [key: string]: string | number | boolean | null };
    bookingId?: number;
    status?: string;
    smsReminderNumber?: string;
    rescheduleId?: number;
    rescheduleUid?: string;
    rescheduleStartTime?: string;
    rescheduleEndTime?: string;
    downloadLink?: string;
    paymentId?: number;
    rescheduledBy?: string;
    cancelledBy?: string;
    paymentData?: Payment;
  };

export type WebhookPayloadType = EventPayloadType | OOOEntryPayloadType | BookingNoShowUpdatedPayload;

type WebhookDataType = WebhookPayloadType & { triggerEvent: string; createdAt: string };

function addUTCOffset(data: WebhookPayloadType): WithUTCOffsetType<WebhookPayloadType> {
  if (isEventPayload(data)) {
    if (data.organizer?.timeZone) {
      (data.organizer as Person & UTCOffset).utcOffset = getUTCOffsetByTimezone(
        data.organizer.timeZone,
        data.startTime
      );
    }

    if (data.attendees?.length) {
      (data.attendees as (Person & UTCOffset)[]).forEach((attendee) => {
        attendee.utcOffset = getUTCOffsetByTimezone(attendee.timeZone, data.startTime);
      });
    }
  }

  return data as WithUTCOffsetType<WebhookPayloadType>;
}

function getZapierPayload(data: WithUTCOffsetType<EventPayloadType & { createdAt: string }>): string {
  const attendees = (data.attendees as (Person & UTCOffset)[]).map((attendee) => {
    return {
      name: attendee.name,
      email: attendee.email,
      timeZone: attendee.timeZone,
      utcOffset: attendee.utcOffset,
    };
  });

  const t = data.organizer.language.translate;
  const location = getHumanReadableLocationValue(data.location || "", t);

  const body = {
    title: data.title,
    description: data.description,
    customInputs: data.customInputs,
    responses: data.responses,
    userFieldsResponses: data.userFieldsResponses,
    startTime: data.startTime,
    endTime: data.endTime,
    location: location,
    status: data.status,
    cancellationReason: data.cancellationReason,
    user: {
      username: data.organizer.username,
      name: data.organizer.name,
      email: data.organizer.email,
      timeZone: data.organizer.timeZone,
      utcOffset: data.organizer.utcOffset,
      locale: data.organizer.locale,
    },
    eventType: {
      title: data.eventTitle,
      description: data.eventDescription,
      requiresConfirmation: data.requiresConfirmation,
      price: data.price,
      currency: data.currency,
      length: data.length,
    },
    attendees: attendees,
    createdAt: data.createdAt,
  };
  return JSON.stringify(body);
}

function applyTemplate(template: string, data: WebhookDataType, contentType: ContentType) {
  const compiled = compile(template)(data).replace(/&quot;/g, '"');

  if (contentType === "application/json") {
    return JSON.stringify(jsonParse(compiled));
  }
  return compiled;
}

export function jsonParse(jsonString: string) {
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    // don't do anything.
  }
  return false;
}

export function isOOOEntryPayload(data: WebhookPayloadType): data is OOOEntryPayloadType {
  return "oooEntry" in data;
}

export function isNoShowPayload(data: WebhookPayloadType): data is BookingNoShowUpdatedPayload {
  return "message" in data;
}

export function isEventPayload(data: WebhookPayloadType): data is EventPayloadType {
  return !isNoShowPayload(data) && !isOOOEntryPayload(data);
}

const sendPayload = async (
  secretKey: string | null,
  triggerEvent: string,
  createdAt: string,
  webhook: Pick<Webhook, "subscriberUrl" | "appId" | "payloadTemplate">,
  data: WebhookPayloadType
) => {
  const { appId, payloadTemplate: template } = webhook;

  const contentType =
    !template || jsonParse(template) ? "application/json" : "application/x-www-form-urlencoded";

  data = addUTCOffset(data);

  let body;
  /* Zapier id is hardcoded in the DB, we send the raw data for this case  */
  if (isEventPayload(data)) {
    data.description = data.description || data.additionalNotes;
    if (appId === "zapier") {
      body = getZapierPayload({ ...data, createdAt });
    }
  }

  if (body === undefined) {
    if (template && (isOOOEntryPayload(data) || isEventPayload(data) || isNoShowPayload(data))) {
      body = applyTemplate(template, { ...data, triggerEvent, createdAt }, contentType);
    } else {
      body = JSON.stringify({
        triggerEvent: triggerEvent,
        createdAt: createdAt,
        payload: data,
      });
    }
  }

  return _sendPayload(secretKey, webhook, body, contentType);
};

export const sendGenericWebhookPayload = async ({
  secretKey,
  triggerEvent,
  createdAt,
  webhook,
  data,
  rootData,
}: {
  secretKey: string | null;
  triggerEvent: string;
  createdAt: string;
  webhook: Pick<Webhook, "subscriberUrl" | "appId" | "payloadTemplate">;
  data: Record<string, unknown>;
  rootData?: Record<string, unknown>;
}) => {
  const body = JSON.stringify({
    // Added rootData props first so that using the known(i.e. triggerEvent, createdAt, payload) properties in rootData doesn't override the known properties
    ...rootData,
    triggerEvent: triggerEvent,
    createdAt: createdAt,
    payload: data,
  });

  return _sendPayload(secretKey, webhook, body, "application/json");
};

export const createWebhookSignature = (params: { secret?: string | null; body: string }) =>
  params.secret
    ? createHmac("sha256", params.secret).update(`${params.body}`).digest("hex")
    : "no-secret-provided";

const _sendPayload = async (
  secretKey: string | null,
  webhook: Pick<Webhook, "subscriberUrl" | "appId" | "payloadTemplate">,
  body: string,
  contentType: "application/json" | "application/x-www-form-urlencoded"
) => {
  const { subscriberUrl } = webhook;
  if (!subscriberUrl || !body) {
    throw new Error("Missing required elements to send webhook payload.");
  }

  const response = await fetch(subscriberUrl, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "X-Cal-Signature-256": createWebhookSignature({ secret: secretKey, body }),
    },
    redirect: "manual",
    body,
  });

  const text = await response.text();

  return {
    ok: response.ok,
    status: response.status,
    ...(text
      ? {
          message: text,
        }
      : {}),
  };
};

export default sendPayload;
