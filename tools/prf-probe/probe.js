// Probes the WebAuthn PRF extension from the page this file runs in. Nothing is stored. The only output is a
// report of what each step returned; PRF outputs are never shown, only their length and the first four bytes of
// their SHA-256, enough to tell whether two outputs are equal.
(function () {
  const out = document.getElementById('out');
  const runBtn = document.getElementById('run');
  const copyBtn = document.getElementById('copy');
  const attachmentSel = document.getElementById('attachment');
  const enc = new TextEncoder();
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

  async function fingerprint(buf) {
    if (!buf) return null;
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return { length: buf.byteLength, sha256First4Bytes: hex(digest).slice(0, 8) };
  }

  async function saltOf(text) {
    return crypto.subtle.digest('SHA-256', enc.encode(text));
  }

  // Classifies where this page is running. WebAuthn only works from an extension page, https, or localhost; a
  // file:// page is refused outright because the browser would fail the passkey call with a SecurityError and the
  // result would say nothing about the authenticator.
  function classifyOrigin() {
    const proto = location.protocol;
    const host = location.hostname;
    const base = { origin: location.origin, href: location.href, protocol: proto };
    if (proto === 'file:') {
      return Object.assign(base, { kind: 'file', allowed: false, reason: 'This page was opened as a local file (file://). Passkeys cannot be used from here. Load the tools/prf-probe folder as an unpacked extension and open the probe from its toolbar icon.' });
    }
    if (proto === 'chrome-extension:') {
      const runtimeId = typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime.id : null;
      if (runtimeId && runtimeId === host) {
        return Object.assign(base, { kind: 'extension', allowed: true, extensionId: runtimeId, runtimeUrl: chrome.runtime.getURL('probe.html') });
      }
      return Object.assign(base, { kind: 'extension-unverified', allowed: false, reason: 'This is a chrome-extension:// page but the extension runtime does not match its origin. Open the probe from the extension toolbar icon.' });
    }
    if (proto === 'https:') return Object.assign(base, { kind: 'https', allowed: true });
    if (proto === 'http:' && (host === 'localhost' || host === '127.0.0.1' || host === '[::1]')) {
      return Object.assign(base, { kind: 'localhost', allowed: true });
    }
    return Object.assign(base, { kind: 'unsupported', allowed: false, reason: 'WebAuthn needs an extension page, https, or localhost. This page is ' + proto + '//' + host + '.' });
  }

  const originInfo = classifyOrigin();

  function showOrigin() {
    const box = document.getElementById('origin');
    if (!box) return;
    const lines = ['Origin: ' + (originInfo.origin === 'null' ? '(none, ' + originInfo.protocol + ')' : originInfo.origin), 'Address: ' + originInfo.href];
    if (originInfo.kind === 'extension') {
      box.className = 'origin ok';
      lines.push('Running as an extension page (id ' + originInfo.extensionId + '). This is the origin the wallet itself will use, so the result is the one that matters.');
    } else if (originInfo.allowed) {
      box.className = 'origin warn';
      lines.push('Allowed by the browser, but this is not an extension page. The result shows what the browser and authenticator support, not what the wallet origin gets. For the real test open the probe from the extension toolbar icon.');
    } else {
      box.className = 'origin bad';
      lines.push('REFUSED: ' + originInfo.reason);
    }
    box.textContent = lines.join('\n');
    if (!originInfo.allowed) {
      runBtn.disabled = true;
      attachmentSel.disabled = true;
      out.textContent = 'No passkey test was run. WebAuthn is not attempted from this page.';
    }
  }

  // The timeout can be shortened with ?timeout=<ms> on the page address, for tests that expect no prompt to be answered.
  const TIMEOUT_MS = Number(new URLSearchParams(location.search).get('timeout')) || 60000;

  // 'immediate' means the browser refused before any user interaction was possible (usually no prompt appeared);
  // 'timeout' means the request sat until the timeout; anything between is a prompt that was shown and then
  // cancelled, closed or failed.
  function failureTiming(ms) {
    if (ms < 1500) return 'immediate';
    if (ms >= TIMEOUT_MS - 2000) return 'timeout';
    return 'after-interaction';
  }
  window.__probeFailureTiming = failureTiming;

  // With rp.id omitted, Chromium uses the full origin ("chrome-extension://<id>") as the RP ID for an extension page
  // and the host name for a web page. The authenticator data carries SHA-256 of the RP ID actually used.
  const expectedRpId = () => (originInfo.kind === 'extension' ? location.origin : location.hostname);

  async function rpIdHashMatchesExpected(authenticatorData) {
    const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(expectedRpId())));
    const got = new Uint8Array(authenticatorData, 0, 32);
    return expected.every((v, i) => v === got[i]);
  }

  const elapsedSince = (t) => Math.round(performance.now() - t);
  const describe = (err) => String(err && err.name ? err.name + ': ' + err.message : err);

  function creationOptions(selection, extensions) {
    // rp has no id on purpose: the browser then uses the extension origin's host as the RP ID.
    const publicKey = {
      challenge: rand(32),
      rp: { name: 'Domain Atlas PRF probe' },
      user: { id: rand(16), name: 'prf-probe', displayName: 'PRF probe' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      attestation: 'none',
      timeout: TIMEOUT_MS
    };
    if (selection) publicKey.authenticatorSelection = selection;
    if (extensions) publicKey.extensions = extensions;
    return publicKey;
  }

  async function attemptCreate(report, label, selection, extensions) {
    const publicKey = creationOptions(selection, extensions);
    const entry = {
      phase: 'create',
      attempt: label,
      rpIdOmitted: !('id' in publicKey.rp),
      authenticatorSelection: selection || null,
      requestedExtensions: extensions ? Object.keys(extensions) : [],
      documentHadFocus: document.hasFocus(),
      transientActivation: navigator.userActivation ? navigator.userActivation.isActive : null
    };
    report.attempts.push(entry);
    const started = performance.now();
    try {
      const cred = await navigator.credentials.create({ publicKey });
      entry.ok = true;
      entry.elapsedMs = elapsedSince(started);
      const ext = cred.getClientExtensionResults();
      entry.attachment = cred.authenticatorAttachment || null;
      entry.transports = cred.response.getTransports ? cred.response.getTransports() : null;
      entry.algorithm = cred.response.getPublicKeyAlgorithm ? cred.response.getPublicKeyAlgorithm() : null;
      entry.extensionResultKeys = Object.keys(ext);
      entry.credPropsResidentKey = ext.credProps && ext.credProps.rk !== undefined ? ext.credProps.rk : null;
      entry.effectiveRpIdIsExpected = cred.response.getAuthenticatorData
        ? await rpIdHashMatchesExpected(cred.response.getAuthenticatorData()) : 'not checkable';
      if (extensions && extensions.prf) {
        entry.prfResultObjectReturned = !!ext.prf;
        entry.prfEnabled = ext.prf ? ext.prf.enabled === true : false;
        entry.prfEvaluatedAtCreate = !!(ext.prf && ext.prf.results && ext.prf.results.first);
        entry.createFingerprint = ext.prf && ext.prf.results ? await fingerprint(ext.prf.results.first) : null;
      }
      return { entry, cred };
    } catch (err) {
      entry.ok = false;
      entry.elapsedMs = elapsedSince(started);
      entry.failureTiming = failureTiming(entry.elapsedMs);
      entry.error = describe(err);
      return { entry };
    }
  }

  async function attemptGet(report, label, credentialId, salt, userVerification, phase) {
    const entry = { phase: phase || 'unlock', attempt: label, userVerification, documentHadFocus: document.hasFocus() };
    report.attempts.push(entry);
    const started = performance.now();
    try {
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: rand(32),
          allowCredentials: [{ id: credentialId, type: 'public-key' }],
          userVerification,
          extensions: { prf: { eval: { first: salt } } },
          timeout: TIMEOUT_MS
        }
      });
      entry.ok = true;
      entry.elapsedMs = elapsedSince(started);
      const ext = assertion.getClientExtensionResults();
      entry.prfResultPresent = !!(ext.prf && ext.prf.results && ext.prf.results.first);
      entry.fingerprint = ext.prf && ext.prf.results ? await fingerprint(ext.prf.results.first) : null;
      entry.userVerifiedFlag = (new Uint8Array(assertion.response.authenticatorData)[32] & 0x04) !== 0;
      entry.effectiveRpIdIsExpected = await rpIdHashMatchesExpected(assertion.response.authenticatorData);
    } catch (err) {
      entry.ok = false;
      entry.elapsedMs = elapsedSince(started);
      entry.failureTiming = failureTiming(entry.elapsedMs);
      entry.error = describe(err);
    }
    return entry;
  }

  const selectionFor = (kind, attachment) => {
    if (kind === 'none') return null;
    const s = kind === 'strict' ? { userVerification: 'required', residentKey: 'discouraged' } : { userVerification: 'preferred', residentKey: 'preferred' };
    if (attachment) s.authenticatorAttachment = attachment;
    return s;
  };
  const selectionLabel = {
    strict: 'user verification required, resident key discouraged',
    relaxed: 'user verification preferred, resident key preferred',
    none: 'no authenticatorSelection at all (browser defaults)'
  };

  async function runUnlock(report, credentialId, salts) {
    await attemptGet(report, 'unlock: salt 1 (user verification required)', credentialId, salts.s1, 'required', 'unlock');
    await attemptGet(report, 'unlock again: salt 1', credentialId, salts.s1, 'required', 'unlock-repeat');
    await attemptGet(report, 'evaluate: salt 2', credentialId, salts.s2, 'required', 'unlock-other-salt');
  }

  function diagnose(report) {
    const creates = report.attempts.filter((a) => a.phase === 'create');
    const plain = creates.filter((a) => a.requestedExtensions.length === 0);
    const withPrf = creates.filter((a) => a.requestedExtensions.indexOf('prf') !== -1);
    const get = (phase) => report.attempts.find((a) => a.phase === phase);
    const a = get('unlock'); const b = get('unlock-repeat'); const c = get('unlock-other-salt');
    const same = (x, y) => !!(x && y && x.fingerprint && y.fingerprint && x.fingerprint.sha256First4Bytes === y.fingerprint.sha256First4Bytes);
    report.verdict = {
      prfEnabledAtCreate: withPrf.some((x) => x.ok && x.prfEnabled),
      outputAtUnlock: !!(a && a.ok && a.prfResultPresent),
      outputLength32: !!(a && a.fingerprint && a.fingerprint.length === 32),
      sameSaltGivesSameOutput: same(a, b),
      differentSaltGivesDifferentOutput: !!(a && c && a.fingerprint && c.fingerprint && !same(a, c)),
      userVerifiedFlagSet: !!(a && a.userVerifiedFlag)
    };
    const v = report.verdict;
    v.usableForWalletUnlock = v.outputAtUnlock && v.outputLength32 && v.sameSaltGivesSameOutput && v.differentSaltGivesDifferentOutput && v.userVerifiedFlagSet;

    const ordinary = !plain.length ? 'not tested' : plain.some((x) => x.ok) ? 'works' : 'fails';
    const workingAttempt = (plain.find((x) => x.ok) || {}).attempt || null;
    const prfCreate = !withPrf.length ? 'not tested'
      : withPrf.some((x) => x.ok && x.prfEnabled) ? 'enabled'
      : withPrf.some((x) => x.ok) ? 'created but the authenticator did not enable PRF'
      : 'creation failed when PRF was requested';
    const failures = creates.concat(report.attempts.filter((x) => x.phase !== 'create')).filter((x) => x.ok === false);
    let conclusion;
    if (v.usableForWalletUnlock) conclusion = 'PRF works from this origin and authenticator.';
    else if (ordinary === 'fails') conclusion = 'Ordinary passkey creation fails without PRF too (' + plain.map((x) => x.failureTiming).join(', ') + '), so the failure is not a PRF incompatibility.';
    else if (ordinary === 'works' && prfCreate === 'creation failed when PRF was requested') conclusion = 'Ordinary creation works but fails once PRF is requested, so this combination rejects the PRF request.';
    else if (ordinary === 'works' && prfCreate.indexOf('did not enable') !== -1) conclusion = 'Registration works but the authenticator did not enable PRF: this browser and authenticator combination does not support PRF.';
    else if (prfCreate === 'enabled') conclusion = 'PRF was enabled at creation but unlock did not give a stable, user-verified output; see the unlock attempts.';
    else if (ordinary === 'not tested') conclusion = 'Only a PRF test ran; also run the ordinary creation test to tell registration failure from PRF failure.';
    else conclusion = 'Inconclusive; see the attempts.';
    report.diagnosis = {
      expectedEffectiveRpId: expectedRpId(),
      rpIdOmittedInEveryRequest: report.attempts.every((x) => x.rpIdOmitted !== false),
      effectiveRpIdIsExpectedEverywhereChecked: report.attempts.filter((x) => typeof x.effectiveRpIdIsExpected === 'boolean').every((x) => x.effectiveRpIdIsExpected),
      ordinaryRegistration: ordinary,
      ordinaryRegistrationWorkedWith: ordinary === 'works' ? workingAttempt : null,
      prfAtCreate: prfCreate,
      failures: failures.map((x) => ({ attempt: x.attempt, failureTiming: x.failureTiming, elapsedMs: x.elapsedMs, documentHadFocus: x.documentHadFocus, error: x.error })),
      conclusion
    };
  }

  async function run(attachment, test) {
    const report = {
      probe: 'atlas-prf-probe/2',
      when: new Date().toISOString(),
      userAgent: navigator.userAgent,
      origin: location.origin,
      address: location.href,
      originKind: originInfo.kind,
      extensionId: originInfo.extensionId || null,
      secureContext: window.isSecureContext,
      attachmentRequested: attachment || 'any',
      test,
      attempts: [],
      steps: []
    };
    if (!originInfo.allowed) {
      report.refused = originInfo.reason;
      report.verdict = { usableForWalletUnlock: false, reason: 'refused: not run from an extension page, https or localhost' };
      return report;
    }
    const salts = { s1: await saltOf('atlas-prf-probe-salt-1'), s2: await saltOf('atlas-prf-probe-salt-2') };

    // Each create/get runs as early as possible after the click, before any slower environment queries.
    const createWith = async (kind, extensions, label) => attemptCreate(report, label, selectionFor(kind, attachment), extensions);

    if (test === 'plain' || test === 'plain-relaxed' || test === 'plain-default') {
      const kind = test === 'plain' ? 'strict' : test === 'plain-relaxed' ? 'relaxed' : 'none';
      await createWith(kind, null, 'passkey without PRF: ' + selectionLabel[kind]);
    } else if (test === 'prf-enable' || test === 'prf-eval') {
      const ext = test === 'prf-enable' ? { prf: {} } : { prf: { eval: { first: salts.s1 } } };
      const r = await createWith('strict', ext, 'passkey with PRF (' + (test === 'prf-enable' ? 'enable only' : 'eval at create') + '): ' + selectionLabel.strict);
      if (r.cred && r.entry.prfEnabled) await runUnlock(report, r.cred.rawId, salts);
    } else {
      let working = null;
      let plainCred = null;
      for (const kind of ['strict', 'relaxed', 'none']) {
        const r = await createWith(kind, null, 'passkey without PRF: ' + selectionLabel[kind]);
        if (r.cred) { working = kind; plainCred = r.cred; break; }
      }
      if (working) {
        const e = await createWith(working, { prf: {} }, 'passkey with PRF, enable only: ' + selectionLabel[working]);
        const v = await createWith(working, { prf: { eval: { first: salts.s1 } } }, 'passkey with PRF, eval at create: ' + selectionLabel[working]);
        const enabled = (e.cred && e.entry.prfEnabled && e.cred) || (v.cred && v.entry.prfEnabled && v.cred);
        if (enabled) {
          await runUnlock(report, enabled.rawId, salts);
        } else {
          const any = e.cred || v.cred || plainCred;
          await attemptGet(report, 'evaluate PRF at unlock on a passkey that did not report PRF as enabled', any.rawId, salts.s1, 'required', 'unlock-on-non-prf-passkey');
        }
      }
    }

    report.steps.push({
      step: 'environment', ok: true,
      detail: {
        publicKeyCredential: typeof window.PublicKeyCredential,
        platformAuthenticatorAvailable: window.PublicKeyCredential && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable
          ? await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => 'error') : 'unknown',
        clientCapabilities: window.PublicKeyCredential && PublicKeyCredential.getClientCapabilities
          ? await PublicKeyCredential.getClientCapabilities().catch(() => 'error') : 'getClientCapabilities not available'
      }
    });
    diagnose(report);
    return report;
  }

  showOrigin();

  const testSel = document.getElementById('test');
  const observedBox = document.getElementById('observedBox');
  const observedSel = document.getElementById('observed');
  const render = () => { out.textContent = JSON.stringify(window.__probeResult, null, 2); };

  runBtn.addEventListener('click', async () => {
    if (!originInfo.allowed) return;
    runBtn.disabled = true;
    copyBtn.disabled = true;
    if (observedBox) observedBox.hidden = true;
    out.textContent = 'Running. Approve each prompt that appears, and note whether one appears at all...';
    const report = await run(attachmentSel.value, testSel ? testSel.value : 'full');
    window.__probeResult = report;
    render();
    runBtn.disabled = false;
    copyBtn.disabled = false;
    if (observedBox) { observedSel.value = ''; observedBox.hidden = false; }
  });

  if (observedSel) {
    observedSel.addEventListener('change', () => {
      if (!window.__probeResult) return;
      window.__probeResult.observedByUser = observedSel.value || null;
      render();
    });
  }

  copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(out.textContent); copyBtn.textContent = 'Copied'; } catch (err) { copyBtn.textContent = 'Select the text and copy it'; }
  });
})();
