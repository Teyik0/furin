/** Development-only request/response peer between the hot backend and the native shell. */
type Message =
  | { kind: "request"; id: string; body: unknown }
  | { kind: "response"; id: string; ok: true; value: unknown }
  | { kind: "response"; id: string; ok: false; error: string };

export interface ChannelPeer {
  close: (reason: string) => void;
  receive: (data: string) => void;
  request: (body: unknown) => Promise<unknown>;
}

export function createChannelPeer(
  send: (data: string) => void,
  handle: (body: unknown) => Promise<unknown>
): ChannelPeer {
  const pending = new Map<string, PromiseWithResolvers<unknown>>();
  let closed: string | undefined;
  return {
    request(body) {
      if (closed) {
        return Promise.reject(new Error(closed));
      }
      const id = crypto.randomUUID();
      const response = Promise.withResolvers<unknown>();
      pending.set(id, response);
      send(JSON.stringify({ kind: "request", id, body } satisfies Message));
      return response.promise;
    },
    receive(data) {
      const message: Message = JSON.parse(data);
      if (message.kind === "response") {
        const response = pending.get(message.id);
        pending.delete(message.id);
        if (message.ok) {
          response?.resolve(message.value);
        } else {
          response?.reject(new Error(message.error));
        }
        return;
      }
      handle(message.body).then(
        (value) => send(JSON.stringify({ kind: "response", id: message.id, ok: true, value })),
        (error: unknown) =>
          send(
            JSON.stringify({
              kind: "response",
              id: message.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          )
      );
    },
    close(reason) {
      closed = reason;
      for (const response of pending.values()) {
        response.reject(new Error(reason));
      }
      pending.clear();
    },
  };
}
