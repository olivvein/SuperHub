export interface BackpressureLimits {
  maxMessages: number;
  maxBytes: number;
}

export interface BackpressureItem {
  bytes: number;
  critical: boolean;
}

export interface BackpressureState<T extends BackpressureItem> {
  queue: T[];
  queueBytes: number;
}

export interface BackpressureDecision<T extends BackpressureItem> {
  accepted: boolean;
  rejectedCritical: boolean;
  dropped: T[];
  queueBytes: number;
}

export function applyBackpressure<T extends BackpressureItem>(
  state: BackpressureState<T>,
  incoming: T,
  limits: BackpressureLimits
): BackpressureDecision<T> {
  const dropped: T[] = [];
  let overflowed = false;

  while (state.queue.length >= limits.maxMessages || state.queueBytes + incoming.bytes > limits.maxBytes) {
    if (state.queue.length === 0) {
      break;
    }

    overflowed = true;
    const oldest = state.queue.shift()!;
    state.queueBytes -= oldest.bytes;
    dropped.push(oldest);
  }

  const stillOverflowing = state.queue.length >= limits.maxMessages || state.queueBytes + incoming.bytes > limits.maxBytes;
  if (stillOverflowing) {
    return {
      accepted: false,
      rejectedCritical: incoming.critical,
      dropped,
      queueBytes: state.queueBytes
    };
  }

  if (overflowed && incoming.critical) {
    return {
      accepted: false,
      rejectedCritical: true,
      dropped,
      queueBytes: state.queueBytes
    };
  }

  state.queue.push(incoming);
  state.queueBytes += incoming.bytes;

  return {
    accepted: true,
    rejectedCritical: false,
    dropped,
    queueBytes: state.queueBytes
  };
}
