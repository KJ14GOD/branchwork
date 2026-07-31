/**
 * The one client for watching and joining a Novus session.
 *
 * Grown out of `apps/guest` rather than written beside it: the browser guest
 * and the desktop app's join mode read the same invites, speak to the same
 * two transports (the worker over loopback, or a relay), and must refuse the
 * same crafted addresses. Two implementations of those rules would drift on
 * exactly the details that matter — this package is deliberately the only
 * place they exist.
 */

export { resolveEndpoint, resolveRelay, type EndpointCheck } from "./endpoint.ts";

export { parseInvite, type InviteCheck, type ParsedInvite } from "./invite.ts";

export {
  watchRelay,
  type RelayConnection,
  type RelayHandlers,
  type RelayRequest,
} from "./relay-client.ts";

export {
  describeConnection,
  isPatchEvent,
  mergeEvent,
  resumeSequence,
  retryDelayMs,
  summarise,
  type ConnectionReport,
  type ConnectionTone,
  type GuestConnection,
  type PatchEvent,
  type TimelineSummary,
} from "./timeline.ts";

export {
  fetchMembership,
  fetchSessions,
  type MembershipReport,
  type SessionListing,
} from "./worker-api.ts";

export {
  describeRole,
  roleAllows,
  type ParticipantCapability,
  type ParticipantRole,
} from "./roles.ts";

export {
  useGuestSession,
  useWorkerSessions,
  type GuestSession,
} from "./use-guest-session.ts";

export { usePresence, type PresenceEntry } from "./use-presence.ts";
