import { useSyncExternalStore } from "react";
import type { DirectionContextRef } from "@novus/contracts";

/**
 * Pinned references per conversation (D-215), held outside any component:
 * the room is keyed per mission and unmounts on a switch, so pins kept as
 * its own state vanished on the way back. Keyed by the same conversation
 * key the composer's scratch uses; in memory only, empty on relaunch.
 */
const pinsByChat = new Map<string, DirectionContextRef[]>();
const listeners = new Set<() => void>();
const NONE: DirectionContextRef[] = [];

export function pinsFor(chatKey: string): DirectionContextRef[] {
  return pinsByChat.get(chatKey) ?? NONE;
}

export function setPinsFor(
  chatKey: string,
  next: DirectionContextRef[] | ((previous: DirectionContextRef[]) => DirectionContextRef[])
): void {
  const previous = pinsFor(chatKey);
  const value = typeof next === "function" ? next(previous) : next;
  if (value.length === 0) pinsByChat.delete(chatKey);
  else pinsByChat.set(chatKey, value);
  for (const listener of listeners) listener();
}

export function usePins(chatKey: string): DirectionContextRef[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pinsFor(chatKey)
  );
}
