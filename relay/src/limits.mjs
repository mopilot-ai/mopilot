// The relay's operating limits in one place: how many messages a connection may have waiting, when its socket is paused and
// when it is cut off, and when a receiver that does not read is dropped. `config.limits` overrides any of them.

export const DEFAULT_LIMITS = Object.freeze({
  /** messages a connection has waiting at which the relay stops reading its socket (TCP then slows the sender), and the number it must fall to before reading again */
  pendingHigh: 64,
  pendingLow: 16,
  /** the safety net for a client that keeps sending past the pause: messages, and their text bytes, waiting at once */
  pendingMax: 2000,
  pendingBytesMax: 32 * 1024 * 1024,
  /** a receiver with this many bytes unsent in its socket, or a send not finished in this long, is dropped (its frames stay stored) */
  slowConsumerBytes: 8 * 1024 * 1024,
  sendTimeoutMs: 15_000,
  /** sockets the relay serves at once, and of those how many one account's devices may hold */
  maxConnections: 5000,
  maxConnectionsPerAccount: 16,
  /** frames per second a connection may send (slowed to this rate, not refused), and the burst it may send at once: a Mac resending its buffer of 200 frames after a reconnect fits */
  frameRate: 100,
  frameBurst: 400,
  /** the same for one pair, both directions together */
  pairFrameRate: 200,
  pairFrameBurst: 800,
  /** receipts per second a device may send (a returning receiver acknowledges its whole backlog at once, so the burst covers a full mailbox) */
  receiptRate: 1000,
  receiptBurst: 6000,
  /** how often one device may connect (the burst covers a flaky network), and the longest a message is made to wait for its token before the connection is closed as a flood */
  connectRate: 1,
  connectBurst: 10,
  maxWaitMs: 5000,
  /** every other message (pairing, presence, push) per connection; past this the message is refused with `rate_limited` and the wait it would need */
  controlRate: 20,
  controlBurst: 60,
  /** stored frames and bytes across every pair; past this a sender is told `mailbox_full` with scope `relay` */
  globalMaxFrames: 500_000,
  globalMaxBytes: 2 * 1024 * 1024 * 1024,
  /** stored frames and bytes across the pairs of one account, so one account cannot use up what the relay holds for everyone; past this a sender is told `mailbox_full` with scope `account` */
  accountMaxFrames: 10_000,
  accountMaxBytes: 128 * 1024 * 1024,
  /** pairs one account may have joined at once (a phone's with each of its Macs, and its Hosts'); past it `pair.join` answers `pair_limit` */
  pairsPerAccount: 32,
  /** Host enrollments one account may hold, one per client and Host (host.register answers `host_limit` past it) */
  hostsPerAccount: 40,
  /** Add by command boots one account may start in a day (boot.mjs answers `boot_quota` past it) */
  bootsPerDay: 20,
  /** failed Host credentials per remote address: past the burst the upgrade is answered 429 until the bucket refills */
  hostAuthRate: 1,
  hostAuthBurst: 10,
  /** the same across every Host id of one remote address (an office behind one NAT holds many Hosts, so it is wider) */
  hostAddressRate: 10,
  hostAddressBurst: 100,
});

/** @typedef {Record<keyof typeof DEFAULT_LIMITS, number>} Limits */

/** @param {{ limits?: Partial<Limits> } | undefined} config @returns {Limits} */
export const limitsOf = (config) => ({ ...DEFAULT_LIMITS, ...config?.limits });
