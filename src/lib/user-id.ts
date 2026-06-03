import { nanoid } from "nanoid";

const KEY = "aip-user-id";

/**
 * Stable per-browser user id for the local-first identity model. Generated
 * once and kept in localStorage; sent as `x-user-id` on every chat API call.
 */
export function getLocalUserId(): string {
  if (typeof window === "undefined") return "";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = nanoid(); // 21 chars — within the server's 8..64 bound
    localStorage.setItem(KEY, id);
  }
  return id;
}
