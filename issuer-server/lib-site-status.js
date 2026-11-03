'use strict';
// Which optional features of this issuer are switched on, off or misconfigured, and the emergency switch that turns
// one OFF. Mirrors issuer-php/lib/site-features.php and lib/site-pause.php for the features this server has: the
// experimental ledger-account issuance, email-delivered tickets and moderation grants. (Asset Studio, the labs
// and the Call service are PHP-only.)
//
// Read-only except pause(), which changes exactly one thing: "enabled" -> false in the feature's JSON config file,
// keeping every other key, written atomically, and never touching a file it cannot parse. Turning a feature on is
// a file edit, never done from here. Only allow-listed values (hosts, ports, domains, counts, "login set") are
// ever returned; passwords, tokens, keys and mail addresses are not.
const fs = require('fs');

const clip = (v, n) => String(v).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, n || 120);

// `opts`: ledgerIssuance ({config()}), ledgerConfigFile, emailConfig (the parsed ATLAS_EMAIL_* settings),
// moderationAudiences() (the effective list), moderationConfigFile, writeFileAtomic(file, text).
function createSiteStatus(opts) {
  function readJson(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return ['missing', null]; }
    if (raw.length > 65536) return ['unreadable', null];
    try { const d = JSON.parse(raw); return d && typeof d === 'object' && !Array.isArray(d) ? ['ok', d] : ['invalid', null]; } catch (e) { return ['invalid', null]; }
  }

  const DEFS = [
    {
      id: 'ledger-issuance', label: 'Ledger account credentials (experimental)', group: 'Wallet and assets', pausable: true,
      about: 'Off unless the config file exists and says enabled.',
      enable: 'Create atlas-ledger-issuance-config.json in the state folder containing {"enabled": true, "domain": "<this host>"}, then restart.',
      disable: 'Use the Pause button here, or set "enabled": false in that file, or delete it.',
      read() {
        const c = opts.ledgerIssuance.config();
        const [st, d] = readJson(opts.ledgerConfigFile);
        if (st === 'invalid' || st === 'unreadable') return ['problem', ['atlas-ledger-issuance-config.json cannot be parsed, so the feature stays off'], []];
        if (!c.enabled) return ['off', [st === 'missing' ? 'no atlas-ledger-issuance-config.json (off by default)' : '"enabled" is not true'], []];
        const facts = ['domain: ' + clip(c.domain || '(none)', 80), 'perClientPerMinute: ' + c.perClientPerMinute, 'perOwnerPerHour: ' + c.perOwnerPerHour, 'globalPerHour: ' + c.globalPerHour];
        return c.problem ? ['problem', [clip(c.problem, 160)], facts] : ['on', [], facts];
      }
    },
    {
      id: 'email-tickets', label: 'Email-delivered tickets', group: 'Delivery', pausable: false,
      about: 'Outbound mail needs ATLAS_EMAIL_SMTP_HOST and ATLAS_EMAIL_FROM_ADDRESS. A missing ATLAS_EMAIL_IMAP_HOST turns inbound transfers off. The settings hold mail passwords; only whether a login is set is reported.',
      enable: 'Set the ATLAS_EMAIL_* environment variables (SMTP host, port, secure, user, pass, from address; IMAP host, user, pass for inbound) and restart.',
      disable: 'Unset ATLAS_EMAIL_SMTP_HOST and restart.',
      read() {
        const e = opts.emailConfig;
        const smtp = !!e.smtpHost, from = !!e.fromAddress, imap = !!e.imapHost;
        const facts = [];
        if (smtp) facts.push('outgoing server: ' + clip(e.smtpHost, 80) + ':' + e.smtpPort + ' ' + clip(e.smtpSecure, 12));
        facts.push('outgoing login: ' + (e.smtpUser && e.smtpPass ? 'set' : 'not set'), 'from address: ' + (from ? 'set' : 'not set'));
        facts.push('incoming (IMAP): ' + (imap ? clip(e.imapHost, 80) + ':' + e.imapPort + ', login ' + (e.imapUser && e.imapPass ? 'set' : 'not set') : 'off'));
        const problems = [];
        if (smtp !== from) problems.push('ATLAS_EMAIL_SMTP_HOST and ATLAS_EMAIL_FROM_ADDRESS must both be set for email to send');
        if (imap && !smtp) problems.push('incoming mail is configured without outgoing mail');
        if (!smtp && !from && !imap) return ['off', ['no ATLAS_EMAIL_* settings (email delivery is off)'], []];
        return [problems.length ? 'problem' : (smtp && from ? 'on' : 'off'), problems, facts];
      }
    },
    {
      id: 'moderation-issuer', label: 'Moderation grants (issuer side)', group: 'Admin and moderation', pausable: false,
      about: 'Needs at least one presence endpoint this issuer may address grants to.',
      enable: 'Create atlas-moderation-config.json in the state folder with {"audiences": ["https://<presence host>"]}, or set ATLAS_MODERATION_AUDIENCES.',
      disable: 'Empty the "audiences" list, or delete the file.',
      read() {
        const env = process.env.ATLAS_MODERATION_AUDIENCES !== undefined;
        const [st] = readJson(opts.moderationConfigFile);
        if (!env && (st === 'invalid' || st === 'unreadable')) return ['problem', ['atlas-moderation-config.json cannot be parsed'], []];
        const aud = opts.moderationAudiences();
        if (!aud.length) return ['off', [env || st === 'ok' ? 'no valid presence endpoint is listed' : 'no atlas-moderation-config.json (no moderation grants)'], []];
        return ['on', [], ['presence endpoints (' + aud.length + '): ' + aud.slice(0, 4).map((a) => clip(a, 80)).join(', ') + (env ? ' (from the ATLAS_MODERATION_AUDIENCES environment variable)' : '')]];
      }
    }
  ];

  function features() {
    return DEFS.map((d) => {
      let r;
      try { r = d.read(); } catch (e) { r = ['problem', ['could not be read'], []]; }
      return { id: d.id, label: d.label, group: d.group, about: d.about, enable: d.enable, disable: d.disable, pausable: d.pausable, state: r[0], reasons: r[1], facts: r[2] };
    });
  }

  // Switches one feature OFF. Returns {ok: true, changed, state} or {ok: false, status, code, error}.
  function pause(id) {
    const def = DEFS.find((d) => d.id === id);
    if (!def) return { ok: false, status: 404, code: 'unknown-feature', error: 'no such feature' };
    if (!def.pausable) return { ok: false, status: 409, code: 'not-pausable', error: 'this feature cannot be paused from the panel; see its "how to switch" note' };
    let changed = false;
    let raw = null;
    try { raw = fs.readFileSync(opts.ledgerConfigFile, 'utf8'); } catch (e) { /* no config: already off */ }
    if (raw !== null) {
      let doc = null;
      try { doc = raw.length <= 65536 ? JSON.parse(raw) : null; } catch (e) { doc = null; }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, status: 409, code: 'unreadable-config', error: 'the config file cannot be parsed, so it was not changed; edit it by hand' };
      if (doc.enabled === true) {
        doc.enabled = false;
        try { opts.writeFileAtomic(opts.ledgerConfigFile, JSON.stringify(doc, null, 2) + '\n'); } catch (e) { return { ok: false, status: 409, code: 'write-failed', error: 'the config file could not be written; it was not changed' }; }
        changed = true;
      }
    }
    const after = features().find((f) => f.id === id);
    return { ok: true, changed, state: after.state };
  }

  return { features, pause };
}

module.exports = { createSiteStatus };
