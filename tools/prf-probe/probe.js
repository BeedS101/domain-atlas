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

  async function run(attachment) {
    const report = {
      probe: 'atlas-prf-probe/1',
      when: new Date().toISOString(),
      userAgent: navigator.userAgent,
      origin: location.origin,
      secureContext: window.isSecureContext,
      attachmentRequested: attachment || 'any',
      steps: []
    };
    const step = async (name, fn) => {
      try {
        const detail = await fn();
        report.steps.push({ step: name, ok: true, detail: detail === undefined ? null : detail });
        return detail;
      } catch (err) {
        report.steps.push({ step: name, ok: false, error: String(err && err.name ? err.name + ': ' + err.message : err) });
        return undefined;
      }
    };

    await step('environment', async () => ({
      publicKeyCredential: typeof window.PublicKeyCredential,
      platformAuthenticatorAvailable: window.PublicKeyCredential && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable
        ? await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable() : 'unknown',
      clientCapabilities: window.PublicKeyCredential && PublicKeyCredential.getClientCapabilities
        ? await PublicKeyCredential.getClientCapabilities() : 'getClientCapabilities not available'
    }));

    const salt1 = await saltOf('atlas-prf-probe-salt-1');
    const salt2 = await saltOf('atlas-prf-probe-salt-2');
    const selection = { userVerification: 'required', residentKey: 'discouraged' };
    if (attachment) selection.authenticatorAttachment = attachment;

    const created = await step('create passkey with the prf extension', async () => {
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge: rand(32),
          rp: { name: 'Domain Atlas PRF probe' },
          user: { id: rand(16), name: 'prf-probe', displayName: 'PRF probe' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: selection,
          extensions: { prf: { eval: { first: salt1 } } },
          timeout: 120000
        }
      });
      const ext = cred.getClientExtensionResults();
      window.__probeCredentialId = cred.rawId;
      return {
        attachment: cred.authenticatorAttachment || null,
        transports: cred.response.getTransports ? cred.response.getTransports() : null,
        prfEnabled: ext.prf ? ext.prf.enabled === true : false,
        prfEvaluatedAtCreate: !!(ext.prf && ext.prf.results && ext.prf.results.first),
        extensionResultKeys: Object.keys(ext),
        createFingerprint: ext.prf && ext.prf.results ? await fingerprint(ext.prf.results.first) : null
      };
    });

    if (created && window.__probeCredentialId) {
      const get = async (salt, uv) => {
        const assertion = await navigator.credentials.get({
          publicKey: {
            challenge: rand(32),
            allowCredentials: [{ id: window.__probeCredentialId, type: 'public-key' }],
            userVerification: uv,
            extensions: { prf: { eval: { first: salt } } },
            timeout: 120000
          }
        });
        const ext = assertion.getClientExtensionResults();
        return {
          prfResultPresent: !!(ext.prf && ext.prf.results && ext.prf.results.first),
          fingerprint: ext.prf && ext.prf.results ? await fingerprint(ext.prf.results.first) : null,
          userVerifiedFlag: (new Uint8Array(assertion.response.authenticatorData)[32] & 0x04) !== 0
        };
      };
      const a = await step('unlock: evaluate prf for salt 1 (user verification required)', () => get(salt1, 'required'));
      const b = await step('unlock again: salt 1', () => get(salt1, 'required'));
      const c = await step('evaluate prf for salt 2', () => get(salt2, 'required'));
      report.verdict = {
        prfEnabledAtCreate: !!(created && created.prfEnabled),
        outputAtUnlock: !!(a && a.prfResultPresent),
        outputLength32: !!(a && a.fingerprint && a.fingerprint.length === 32),
        sameSaltGivesSameOutput: !!(a && b && a.fingerprint && b.fingerprint && a.fingerprint.sha256First4Bytes === b.fingerprint.sha256First4Bytes),
        differentSaltGivesDifferentOutput: !!(a && c && a.fingerprint && c.fingerprint && a.fingerprint.sha256First4Bytes !== c.fingerprint.sha256First4Bytes),
        userVerifiedFlagSet: !!(a && a.userVerifiedFlag)
      };
      report.verdict.usableForWalletUnlock = report.verdict.outputAtUnlock && report.verdict.outputLength32
        && report.verdict.sameSaltGivesSameOutput && report.verdict.differentSaltGivesDifferentOutput && report.verdict.userVerifiedFlagSet;
    } else {
      report.verdict = { usableForWalletUnlock: false, reason: 'the passkey could not be created' };
    }
    return report;
  }

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    copyBtn.disabled = true;
    out.textContent = 'Running. Approve each prompt that appears...';
    const report = await run(attachmentSel.value);
    window.__probeResult = report;
    out.textContent = JSON.stringify(report, null, 2);
    runBtn.disabled = false;
    copyBtn.disabled = false;
  });

  copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(out.textContent); copyBtn.textContent = 'Copied'; } catch (err) { copyBtn.textContent = 'Select the text and copy it'; }
  });
})();
