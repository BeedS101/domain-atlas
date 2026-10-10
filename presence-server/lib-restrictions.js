// Domain Atlas presence server: temporary moderation restrictions.
//
// Holds what a moderator's mute and kick leave behind, in memory, private to
// this process: nothing is written to disk, nothing reaches a wallet,
// credential or Post Office membership, and nothing is published (no
// .well-known file, no response to anyone but the moderator who issued the
// command and the affected visitor). Everything expires on its own and is
// bounded.
//
//   mute   - chat.mute: the visit may not send chat messages until `until`.
//   kick   - session.kick: the visit may not join presence or chat again until
//            `until`. (The sessions themselves are removed by server.js.)
//   tomb   - what a kicked polling session's connection token gets back instead
//            of "unknown id": a clear "removed" answer, so the client does not
//            read the missing session as a sweep and silently rejoin.
//
// A restriction is keyed by the keyed visit hash (lib-moderation.js
// visitHash: domain + world + the wallet's per-visit random id), so it applies
// to exactly one visit to one world on one domain: another world, another
// domain or a fresh visit is not affected. A session without a visit id (an
// older wallet) is keyed by its own connection (`c:<connId>`): a mute follows
// that connection only.
//
// presence-php/presence/lib/restrictions.php implements the same rules and
// the same visitor-facing texts.

function envNumber(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const MAX_RESTRICTIONS = envNumber('MODERATION_MAX_RESTRICTIONS', 2000);
const MAX_RESTRICTIONS_PER_ROOM = envNumber('MODERATION_MAX_RESTRICTIONS_PER_WORLD', 200);
const MAX_TOMBS = envNumber('MODERATION_MAX_TOMBSTONES', 5000);

// Visitor-facing text, by fixed cause code. A moderator picks a code; the
// words are ours.
const CAUSE_LABEL = {
  spam: 'spam',
  abuse: 'abusive behaviour',
  harassment: 'harassment',
  inappropriate: 'inappropriate content',
  disruption: 'disruption',
  other: 'a breach of the rules of this world'
};

function humanDuration(seconds) {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return s + (s === 1 ? ' second' : ' seconds');
  if (s < 3600) { const m = Math.ceil(s / 60); return m + (m === 1 ? ' minute' : ' minutes'); }
  const h = Math.ceil(s / 3600);
  return h + (h === 1 ? ' hour' : ' hours');
}
function labelOf(cause) { return CAUSE_LABEL[cause] || CAUSE_LABEL.other; }

function muteMessage(untilMs, cause, now) {
  return 'A moderator has muted you in this world (' + labelOf(cause) + '). Time remaining: ' + humanDuration((untilMs - now) / 1000) + '. You can still look around and read chat.';
}
function kickMessage(untilMs, cause, now) {
  return 'A moderator has removed you from this world (' + labelOf(cause) + '). You can rejoin in ' + humanDuration((untilMs - now) / 1000) + '.';
}

const mutes = new Map(); // key -> {until, cause, room}
const kicks = new Map(); // key -> {until, cause, room}
const tombs = new Map(); // connId -> {until, cause, scope}

function live(map, key, now) {
  const e = map.get(key);
  if (!e) return null;
  if (e.until <= now) { map.delete(key); return null; }
  return e;
}

// Returns 'ok' or 'full'. Replacing an existing entry for the same key never
// counts against the bounds.
function put(map, key, room, until, cause, now) {
  if (!map.has(key)) {
    sweep(now);
    if (mutes.size + kicks.size >= MAX_RESTRICTIONS) return 'full';
    let inRoom = 0;
    for (const m of [mutes, kicks]) m.forEach((e) => { if (e.room === room) inRoom++; });
    if (inRoom >= MAX_RESTRICTIONS_PER_ROOM) return 'full';
  }
  map.set(key, { until, cause, room });
  return 'ok';
}

function sweep(now) {
  for (const m of [mutes, kicks, tombs]) m.forEach((e, k) => { if (e.until <= now) m.delete(k); });
}

module.exports = {
  muteOf: (key, now) => live(mutes, key, now),
  kickOf: (key, now) => live(kicks, key, now),
  setMute: (key, room, until, cause, now) => put(mutes, key, room, until, cause, now),
  setKick: (key, room, until, cause, now) => put(kicks, key, room, until, cause, now),
  clearMute: (key) => mutes.delete(key),
  addTomb(connId, scope, until, cause, now) {
    if (!tombs.has(connId)) {
      sweep(now);
      while (tombs.size >= MAX_TOMBS) tombs.delete(tombs.keys().next().value);
    }
    tombs.set(connId, { until, cause, scope });
  },
  tombOf: (connId, now) => live(tombs, connId, now),
  sweep,
  muteMessage, kickMessage,
  counts: () => ({ mutes: mutes.size, kicks: kicks.size, tombs: tombs.size })
};
