import type {MessageEnvelope} from "./sdk";

/** Owner identity is explicit and decimal-string based; no unsafe Number coercion. */
export function isOwner(message: MessageEnvelope, ownerId = process.env.TB_OWNER_ID): boolean {
  return typeof ownerId === "string" && /^[0-9]+$/.test(ownerId) && message.senderId === ownerId;
}

export function requireOwner(message: MessageEnvelope): void {
  if (!isOwner(message)) throw new Error("OWNER_REQUIRED");
}

export async function isPrivileged(message: MessageEnvelope): Promise<boolean> {
  return isOwner(message);
}
