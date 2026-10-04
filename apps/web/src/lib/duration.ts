import { getPublicLocale } from "../i18n";
import {
  formatDurationMinutes as formatDurationMinutesShared,
  formatWaitReply as formatWaitReplyShared,
  formatWaitSince as formatWaitSinceShared,
} from "@creolab/contracts";

export const formatDurationMinutes = (minutes: number | null | undefined, locale: string = getPublicLocale()) => formatDurationMinutesShared(minutes, locale);
export const formatWaitSince = (minutes: number | null | undefined, locale: string = getPublicLocale()) => formatWaitSinceShared(minutes, locale);
export const formatWaitReply = (minutes: number | null | undefined, locale: string = getPublicLocale()) => formatWaitReplyShared(minutes, locale);
