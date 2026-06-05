/**
 * User id sent as `x-user-id` to scope chats/history.
 *
 * Uses a single shared id by default so the same chats and history are visible
 * across ALL browsers and devices (sync). Override per-deployment with
 * NEXT_PUBLIC_USER_ID if you want isolated workspaces.
 *
 * (Previously this generated a random per-browser id, which is why history
 * didn't sync between browsers.)
 */
export function getLocalUserId(): string {
  return process.env.NEXT_PUBLIC_USER_ID || "shared-workspace-user";
}
