import type { Api, TelegramClient } from "teleproto";
import type { EntityLike } from "teleproto/define";
import type { NewMessageEvent } from "teleproto/events/NewMessage";
import type { MessageEnvelope, MessageOptions, TelegramPort } from "./sdk";
import { ResourceScope } from "./lifecycle";

export interface EnvelopeOptions {
  /** Decimal account ID supplied by the already-authenticated runtime, never fetched here. */
  selfId?: string;
  edited?: boolean;
}

export class TelegramAbortError extends Error {
  constructor() {
    super("Telegram operation was cancelled");
    this.name = "AbortError";
  }
}

export class TelegramEventError extends Error {
  constructor() {
    super("Telegram message handler failed");
    this.name = "TelegramEventError";
  }
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new TelegramAbortError();
}

function peerId(peer: Api.TypePeer): string {
  // Match Teleproto's marked decimal IDs without Number conversion or Utils' peer mutation.
  switch (peer.className) {
    case "PeerUser": return peer.userId.toString();
    case "PeerChat": return `-${peer.chatId.toString()}`;
    case "PeerChannel": return `-100${peer.channelId.toString()}`;
    default: throw new TypeError("Telegram message has an unsupported peer");
  }
}

function replyHeader(message: Api.Message): Api.MessageReplyHeader | undefined {
  const header = message.replyTo;
  return header?.className === "MessageReplyHeader" ? header : undefined;
}

function rawMessage(message: MessageEnvelope): Api.Message | undefined {
  const raw = message.raw;
  return raw !== null && typeof raw === "object" && "className" in raw && raw.className === "Message"
    ? raw as Api.Message : undefined;
}

/** Frozen scalar snapshot; raw retains the original, mutable protocol object and its methods. */
export function messageEnvelope(message: Api.Message, options: EnvelopeOptions = {}): MessageEnvelope {
  const chatId = peerId(message.peerId);
  const reply = replyHeader(message);
  const savedPeer = (message as Api.Message & { savedPeerId?: Api.TypePeer }).savedPeerId;
  const senderId = message.fromId ? peerId(message.fromId)
    : message.senderId?.toString() ??
      ((message.post || (!message.out && message.peerId.className === "PeerUser")) ? chatId
        : message.out ? options.selfId : undefined);
  return Object.freeze({
    id: message.id,
    chatId,
    senderId,
    text: message.message ?? "",
    outgoing: Boolean(message.out),
    saved: Boolean(savedPeer) || (options.selfId !== undefined && chatId === options.selfId),
    edited: options.edited === true || message.editDate !== undefined,
    forwarded: Boolean(message.fwdFrom),
    replyToId: reply?.replyToMsgId,
    topicId: reply?.replyToTopId ?? (reply?.forumTopic ? reply.replyToMsgId : undefined),
    raw: message,
  });
}

async function targetPeer(message: MessageEnvelope): Promise<EntityLike> {
  const raw = rawMessage(message);
  if (raw) return raw.inputChat ?? raw.peerId;
  // Numeric strings can enter Teleproto's phone/username resolution path on a cache miss.
  const { returnBigInt } = await import("teleproto/Helpers.js");
  return returnBigInt(message.chatId);
}

export class TeleprotoPort implements TelegramPort {
  private readonly client: TelegramClient;
  private readonly scope: ResourceScope;
  private readonly selfId?: string;

  constructor(client: TelegramClient, scope: ResourceScope, options: Pick<EnvelopeOptions, "selfId"> = {}) {
    this.client = client;
    this.scope = scope;
    this.selfId = options.selfId;
  }

  edit(message: MessageEnvelope, text: string, options: MessageOptions, signal: AbortSignal): Promise<void> {
    return this.withClient(async (client, activeSignal) => {
      const peer = await targetPeer(message);
      checkSignal(activeSignal);
      await client.editMessage(peer, {
        message: message.id,
        text,
        parseMode: options.parseMode ?? false,
        linkPreview: options.linkPreview,
        buttons: rawMessage(message)?.replyMarkup,
      });
    }, signal);
  }

  reply(message: MessageEnvelope, text: string, options: MessageOptions, signal: AbortSignal): Promise<void> {
    return this.withClient(async (client, activeSignal) => {
      const peer = await targetPeer(message);
      checkSignal(activeSignal);
      await client.sendMessage(peer, {
        message: text,
        replyTo: message.id,
        topMsgId: message.topicId,
        parseMode: options.parseMode ?? false,
        linkPreview: options.linkPreview,
      });
    }, signal);
  }

  invoke(request: unknown, signal: AbortSignal): Promise<unknown> {
    return this.withClient((client) => client.invoke(request as Api.AnyRequest), signal);
  }

  getReply(message: MessageEnvelope, signal: AbortSignal): Promise<MessageEnvelope | undefined> {
    return this.withClient(async (client, activeSignal) => {
      const raw = rawMessage(message);
      const header = raw && replyHeader(raw);
      const id = header?.replyToMsgId ?? message.replyToId;
      if (!id) return undefined;
      const peer = header?.replyToPeerId ?? await targetPeer(message);
      checkSignal(activeSignal);
      let result: unknown;
      try {
        // Only this message's explicit reply target; never latest-message or history fallbacks.
        result = await client.getMessages(peer, { ids: [id] });
      } catch (error) {
        // Teleproto's missing-message date crash is the sole compatibility suppression.
        if (error instanceof Error && error.message.includes("Cannot read properties of undefined") &&
            error.message.includes("reading 'date'")) return undefined;
        throw error;
      }
      checkSignal(activeSignal);
      const replies = Array.isArray(result) ? result : result ? [result] : [];
      const reply = replies.find((candidate: unknown): candidate is Api.Message =>
        candidate !== null && typeof candidate === "object" && "className" in candidate &&
        candidate.className === "Message" && "id" in candidate && candidate.id === id);
      return reply && messageEnvelope(reply, { selfId: this.selfId });
    }, signal);
  }

  /**
   * RPCs do not accept AbortSignal. Check before dispatch and after real settlement; never
   * disconnect the shared client or race away from a pending operation. Native errors reach
   * callers unchanged and are not logged here. Operation must await all work it starts.
   */
  async withClient<T>(
    operation: (client: TelegramClient, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    checkSignal(signal);
    checkSignal(this.scope.signal);
    return this.scope.run("telegram:operation", async (scopeSignal) => {
      const controller = new AbortController();
      const inputs = new Set([signal, scopeSignal]);
      const cancel = (): void => controller.abort(new TelegramAbortError());
      for (const input of inputs) {
        if (input.aborted) cancel();
        else input.addEventListener("abort", cancel, { once: true });
      }
      try {
        checkSignal(controller.signal);
        const result = await operation(this.client, controller.signal);
        checkSignal(controller.signal);
        return result;
      } finally {
        for (const input of inputs) input.removeEventListener("abort", cancel);
      }
    });
  }
}

export type MessageSink = (message: MessageEnvelope, signal: AbortSignal) => void | Promise<void>;
const subscribedClients = new WeakSet<TelegramClient>();

/**
 * Account-level subscription: one pair of builders per client, with routing left to sink.
 * The disposer only detaches these listeners; scope.drain also waits for in-flight sinks.
 * Callback errors become fixed errors because Teleproto logs rejected event handlers.
 */
export async function subscribeMessages(
  client: TelegramClient,
  scope: ResourceScope,
  sink: MessageSink,
  options: Pick<EnvelopeOptions, "selfId"> = {},
): Promise<() => Promise<void>> {
  checkSignal(scope.signal);
  return scope.run("telegram:subscribe", async (signal) => {
    if (subscribedClients.has(client)) throw new Error("Telegram client already has a message subscription");
    subscribedClients.add(client);
    let detach: (() => void) | undefined;
    try {
      const { NewMessage } = await import("teleproto/events/NewMessage.js");
      const { EditedMessage } = await import("teleproto/events/EditedMessage.js");
      checkSignal(signal);
      const newBuilder = new NewMessage({});
      const editBuilder = new EditedMessage({});
      let active = true;
      const dispatch = async (event: NewMessageEvent, edited: boolean): Promise<void> => {
        if (!active || signal.aborted) return;
        try {
          await scope.run("telegram:message", async (scopeSignal) => {
            await sink(messageEnvelope(event.message, { selfId: options.selfId, edited }), scopeSignal);
          });
        } catch {
          if (!signal.aborted) throw new TelegramEventError();
        }
      };
      const onNew = (event: NewMessageEvent): Promise<void> => dispatch(event, false);
      const onEdit = (event: NewMessageEvent): Promise<void> => dispatch(event, true);
      let dispose: (() => Promise<void>) | undefined;
      const onAbort = (): void => { void dispose?.().catch(() => undefined); };
      detach = () => {
        active = false;
        signal.removeEventListener("abort", onAbort);
        let failed = false;
        // Unique callbacks AND builders are required by Teleproto's removeEventHandler filter.
        try { client.removeEventHandler(onNew, newBuilder); } catch { failed = true; }
        try { client.removeEventHandler(onEdit, editBuilder); } catch { failed = true; }
        if (failed) throw new Error("Telegram message subscription cleanup failed");
        subscribedClients.delete(client);
      };
      client.addEventHandler(onNew, newBuilder);
      checkSignal(signal);
      client.addEventHandler(onEdit, editBuilder);
      checkSignal(signal);
      dispose = scope.add("telegram:subscription", detach);
      signal.addEventListener("abort", onAbort, { once: true });
      return dispose;
    } catch {
      if (detach) detach();
      else subscribedClients.delete(client);
      if (signal.aborted) throw new TelegramAbortError();
      throw new Error("Telegram message subscription setup failed");
    }
  });
}
