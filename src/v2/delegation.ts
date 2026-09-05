export interface DelegatedMessage {
  /** Raw Telegram peer IDs used by the existing sudo/sure databases. */
  readonly senderId?: string;
  readonly peerId?: string;
  readonly text: string;
  readonly forwarded?: boolean;
  readonly edited?: boolean;
}

export interface DelegationRule {
  readonly id: string;
  readonly msg: string;
  readonly redirect?: string;
}

export interface DelegationConfig {
  readonly users: readonly string[];
  readonly chats: readonly string[];
  readonly messages?: readonly DelegationRule[];
}

export interface MatchedDelegation {
  readonly ruleId: string;
  readonly text: string;
}

export function telegramId(value: string | bigint | number): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("Telegram ID lost integer precision");
  const text = String(value);
  if (!/^[0-9]+$/.test(text) || BigInt(text) === 0n) throw new Error("Expected a positive raw Telegram ID");
  return BigInt(text).toString();
}

// Rules are captured as one immutable revision. Updating access never exposes
// a partially refreshed user/chat/message whitelist to concurrent dispatches.
export class DelegationPolicy {
  private readonly users: ReadonlySet<string>;
  private readonly chats: ReadonlySet<string>;
  private readonly rules: readonly DelegationRule[];

  constructor(config: DelegationConfig) {
    this.users = new Set(config.users.map(telegramId));
    this.chats = new Set(config.chats.map(telegramId));
    const ids = new Set<string>();
    this.rules = config.messages?.map(rule => {
      if (!rule.id || ids.has(rule.id) || typeof rule.msg !== "string" ||
          (rule.redirect !== undefined && typeof rule.redirect !== "string")) {
        throw new Error("Invalid delegation rule");
      }
      ids.add(rule.id);
      return Object.freeze({...rule});
    }) ?? [];
  }

  allows(message: DelegatedMessage): boolean {
    if (message.forwarded || message.edited || !message.senderId || !message.peerId) return false;
    // The protocol boundary supplies canonical raw strings. Malformed data is
    // denied here, never rounded or interpreted as a username.
    if (!/^[1-9][0-9]*$/.test(message.senderId) || !/^[1-9][0-9]*$/.test(message.peerId)) return false;
    return this.users.has(message.senderId) && (!this.chats.size || this.chats.has(message.peerId));
  }

  match(message: DelegatedMessage): MatchedDelegation | undefined {
    if (!this.allows(message)) return;
    for (const rule of this.rules) {
      if (rule.msg.startsWith("_command:")) {
        const command = rule.msg.slice("_command:".length);
        if (!message.text.startsWith(command)) continue;
        const suffix = message.text.slice(command.length);
        if (suffix && !suffix.startsWith(" ")) continue;
        return {ruleId: rule.id, text: rule.redirect ? rule.redirect + suffix : message.text};
      }
      if (rule.msg === message.text) return {ruleId: rule.id, text: rule.redirect || message.text};
    }
  }
}
