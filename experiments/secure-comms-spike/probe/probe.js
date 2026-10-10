// Browser-agnostic WebRTC capability probe. Runs in any page (Chromium,
// Firefox); no extension APIs, no microphone unless the second button is
// clicked. Results go to #out and window.__probeResult.
(function () {
  const out = document.getElementById('out');
  const hex = (bytes) => Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, '0')).join(':').toUpperCase();
  const sha256 = async (buf) => hex(await crypto.subtle.digest('SHA-256', buf));
  const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sdpFps = (sdp) => (sdp || '').split(/\r?\n/).filter((l) => l.startsWith('a=fingerprint:')).map((l) => l.split(' ')[1].toUpperCase());

  function toneTrack(ctx, freq) {
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    return dest.stream.getAudioTracks()[0];
  }

  async function connectPair(opts) {
    const cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });
    const a = new RTCPeerConnection({ certificates: [cert] });
    const b = new RTCPeerConnection();
    const ctx = new AudioContext();
    await ctx.resume();
    const ta = toneTrack(ctx, 440), tb = toneTrack(ctx, 660);
    a.addTrack(ta, new MediaStream([ta]));
    b.addTrack(tb, new MediaStream([tb]));
    a.onicecandidate = (e) => { if (e.candidate) b.addIceCandidate(e.candidate).catch(() => {}); };
    b.onicecandidate = (e) => { if (e.candidate) a.addIceCandidate(e.candidate).catch(() => {}); };
    const offer = await a.createOffer();
    await a.setLocalDescription(offer);
    let offerForB = a.localDescription;
    await b.setRemoteDescription(offerForB);
    const answer = await b.createAnswer();
    await b.setLocalDescription(answer);
    let answerForA = b.localDescription;
    if (opts && opts.fakeAnswerFingerprint) {
      answerForA = { type: 'answer', sdp: answerForA.sdp.replace(/^a=fingerprint:(\S+) .*$/gm, 'a=fingerprint:$1 ' + opts.fakeAnswerFingerprint) };
    }
    await a.setRemoteDescription(answerForA);
    return { a, b, cert, ctx };
  }

  async function waitState(pc, wanted, ms) {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (wanted.includes(pc.connectionState)) return pc.connectionState;
      await sleep(100);
    }
    return pc.connectionState + ' (timeout)';
  }

  async function remoteCertInfo(pc) {
    const info = {};
    const sender = pc.getSenders().find((s) => s.track);
    const transport = sender && sender.transport;
    info.hasTransport = !!transport;
    info.dtlsState = transport ? transport.state : null;
    info.getRemoteCertificatesType = transport ? typeof transport.getRemoteCertificates : null;
    if (transport && typeof transport.getRemoteCertificates === 'function') {
      try {
        const certs = transport.getRemoteCertificates();
        info.remoteCertCount = certs.length;
        info.remoteCertSha256 = certs.length ? await sha256(certs[0]) : null;
      } catch (err) { info.getRemoteCertificatesError = String(err); }
    }
    const stats = await pc.getStats();
    const byId = {};
    stats.forEach((s) => { byId[s.id] = s; });
    const certs = [];
    let transportStat = null;
    stats.forEach((s) => {
      if (s.type === 'certificate') certs.push({ id: s.id, fingerprint: s.fingerprint, algorithm: s.fingerprintAlgorithm, hasBase64: !!s.base64Certificate });
      if (s.type === 'transport') transportStat = s;
    });
    info.statsCertificates = certs;
    if (transportStat) {
      info.transport = { dtlsState: transportStat.dtlsState, dtlsRole: transportStat.dtlsRole, tlsVersion: transportStat.tlsVersion, dtlsCipher: transportStat.dtlsCipher, srtpCipher: transportStat.srtpCipher, hasRemoteCertificateId: !!transportStat.remoteCertificateId, hasLocalCertificateId: !!transportStat.localCertificateId };
      const rc = byId[transportStat.remoteCertificateId];
      if (rc && rc.base64Certificate) {
        info.statsRemoteCertSha256 = await sha256(b64ToBytes(rc.base64Certificate));
        info.statsRemoteCertFingerprintField = rc.fingerprint;
      }
    }
    let inbound = null;
    stats.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') inbound = s; });
    if (inbound) info.inboundAudio = { packetsReceived: inbound.packetsReceived, totalAudioEnergy: inbound.totalAudioEnergy, audioLevel: inbound.audioLevel };
    return info;
  }

  async function runProbe() {
    const r = { userAgent: navigator.userAgent, when: new Date().toISOString() };
    r.apis = {
      RTCPeerConnection: typeof RTCPeerConnection,
      generateCertificate: typeof RTCPeerConnection === 'function' ? typeof RTCPeerConnection.generateCertificate : 'n/a',
      RTCDtlsTransport: typeof RTCDtlsTransport,
      getRemoteCertificatesOnPrototype: typeof RTCDtlsTransport === 'function' ? typeof RTCDtlsTransport.prototype.getRemoteCertificates : 'n/a',
      RTCCertificateGetFingerprints: typeof RTCCertificate === 'function' ? typeof RTCCertificate.prototype.getFingerprints : 'n/a',
      mediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      setCodecPreferences: typeof RTCRtpTransceiver === 'function' ? typeof RTCRtpTransceiver.prototype.setCodecPreferences : 'n/a'
    };
    const p = await connectPair();
    r.certificate = { expires: p.cert.expires, fingerprints: p.cert.getFingerprints() };
    r.sdpFingerprintsOffer = sdpFps(p.a.localDescription.sdp);
    r.sdpFingerprintsAnswer = sdpFps(p.b.localDescription.sdp);
    r.sdpHasCrypto = /a=crypto:/.test(p.a.localDescription.sdp + p.b.localDescription.sdp);
    r.stateA = await waitState(p.a, ['connected'], 10000);
    r.stateB = await waitState(p.b, ['connected'], 10000);
    await sleep(2500);
    r.pcA = await remoteCertInfo(p.a);
    r.pcB = await remoteCertInfo(p.b);
    const certFp = p.cert.getFingerprints().find((f) => f.algorithm === 'sha-256');
    r.checks = {
      certFingerprintEqualsOfferSdp: !!certFp && r.sdpFingerprintsOffer.includes(certFp.value.toUpperCase()),
      remoteCertOnBEqualsAnchoredOfferFp: r.pcB.remoteCertSha256 ? r.pcB.remoteCertSha256 === (certFp && certFp.value.toUpperCase()) : null,
      statsRemoteCertOnBEqualsOfferFp: r.pcB.statsRemoteCertSha256 ? r.pcB.statsRemoteCertSha256 === (certFp && certFp.value.toUpperCase()) : null,
      remoteCertOnAEqualsAnswerSdpFp: r.pcA.remoteCertSha256 ? r.sdpFingerprintsAnswer.includes(r.pcA.remoteCertSha256) : null,
      statsRemoteCertOnAEqualsAnswerSdpFp: r.pcA.statsRemoteCertSha256 ? r.sdpFingerprintsAnswer.includes(r.pcA.statsRemoteCertSha256) : null
    };
    p.a.close(); p.b.close(); p.ctx.close();

    // The browser's own enforcement: the answerer's fingerprint is replaced
    // by a value that does not match its certificate.
    const fake = 'AA:'.repeat(31) + 'AA';
    const t = await connectPair({ fakeAnswerFingerprint: fake });
    const t0 = performance.now();
    r.tamperedAnswerFingerprint = { state: await waitState(t.a, ['connected', 'failed', 'closed'], 12000), afterMs: Math.round(performance.now() - t0) };
    t.a.close(); t.b.close(); t.ctx.close();
    return r;
  }

  document.getElementById('run').addEventListener('click', async () => {
    out.textContent = 'running...';
    try { window.__probeResult = await runProbe(); } catch (err) { window.__probeResult = { error: String(err) }; }
    out.textContent = JSON.stringify(window.__probeResult, null, 2);
  });
  document.getElementById('mic').addEventListener('click', async () => {
    const r = { userAgent: navigator.userAgent };
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      const tracks = s.getAudioTracks();
      r.granted = true; r.tracks = tracks.length;
      tracks.forEach((t) => t.stop());
      r.readyStateAfterStop = tracks.map((t) => t.readyState);
    } catch (err) { r.granted = false; r.error = err.name + ': ' + err.message; }
    window.__micResult = r;
    out.textContent = JSON.stringify(r, null, 2);
  });
})();
