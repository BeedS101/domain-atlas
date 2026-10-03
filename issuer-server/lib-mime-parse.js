// Minimal MIME parser for inbound mail — the receiving-side counterpart
// to lib-smtp.js's buildMimeMessage(). Parses exactly what SPEC.md §13.3
// needs to read back out of a forwarded message: the From/To/Cc
// addresses and any attachment, decoded. Not a general-purpose parser —
// no RFC2047 encoded-word decoding for display names (only the bare
// address inside <...> or a bare address with no display name at all is
// ever extracted), no nested multipart/alternative handling beyond one
// level, no charset conversion beyond UTF-8/ASCII.

// Unfolds header continuation lines (RFC 5322: a line starting with
// whitespace is a continuation of the previous header) and splits the
// raw message into {headers: Map, body: string} at the first blank line.
function splitHeadersAndBody(raw) {
  const headerEnd = raw.indexOf('\r\n\r\n');
  const headerBlock = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
  const body = headerEnd === -1 ? '' : raw.slice(headerEnd + 4);
  const lines = headerBlock.split('\r\n');
  const headers = new Map();
  let lastKey = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && lastKey) {
      headers.set(lastKey, headers.get(lastKey) + ' ' + line.trim());
      continue;
    }
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    lastKey = key;
    headers.set(key, headers.has(key) ? headers.get(key) + ', ' + value : value);
  }
  return { headers, body };
}

// Pulls every bare email address out of a header value — handles
// "Display Name <addr@host>", a bare "addr@host", and comma-separated
// lists of either, which is all §13.3's own CC-addressing rule ever needs
// (display names are discardable; only addresses matter for identifying
// recipients).
function extractAddresses(headerValue) {
  if (!headerValue) return [];
  const matches = headerValue.match(/[^\s<>,"]+@[^\s<>,"]+/g);
  return matches ? matches.map((a) => a.toLowerCase()) : [];
}

function decodeBody(body, encoding) {
  const enc = (encoding || '7bit').toLowerCase();
  if (enc === 'base64') return Buffer.from(body.replace(/\r?\n/g, ''), 'base64').toString('utf8');
  if (enc === 'quoted-printable') {
    return body
      .replace(/=\r\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  return body; // 7bit/8bit — already plain text
}

function parseHeaderParams(headerValue) {
  const params = {};
  const parts = (headerValue || '').split(';');
  for (let i = 1; i < parts.length; i++) {
    const m = parts[i].match(/\s*([^=]+)=\s*"?([^"]*)"?\s*$/);
    if (m) params[m[1].trim().toLowerCase()] = m[2];
  }
  return params;
}

// Splits a multipart body on its boundary and returns each part as
// {headers: Map, body: string (raw, not yet decoded)}. One level only —
// a nested multipart part is returned as-is, raw, rather than recursed
// into, since nothing this feature sends or expects to receive nests
// more than one level deep (lib-smtp.js's own buildMimeMessage() never
// produces anything nested).
function splitMultipart(body, boundary) {
  const marker = '--' + boundary;
  const segments = body.split(marker).slice(1, -1); // drop preamble and the closing "--boundary--" tail
  return segments.map((seg) => {
    const trimmed = seg.replace(/^\r\n/, '').replace(/\r\n$/, '');
    return splitHeadersAndBody(trimmed);
  });
}

// parseMimeMessage(raw) -> {from, to, cc, subject, attachments: [{filename, contentType, content}], textBody}
// `content` is the fully decoded text of an attachment (this feature only
// ever attaches application/json, always text, never a genuinely binary
// payload, so decoding straight to a UTF-8 string is always correct here).
function parseMimeMessage(raw) {
  const { headers, body } = splitHeadersAndBody(raw);
  const contentType = headers.get('content-type') || 'text/plain';
  const result = {
    from: extractAddresses(headers.get('from'))[0] || null,
    to: extractAddresses(headers.get('to')),
    cc: extractAddresses(headers.get('cc')),
    subject: headers.get('subject') || '',
    textBody: '',
    attachments: []
  };

  if (!/^multipart\//i.test(contentType)) {
    result.textBody = decodeBody(body, headers.get('content-transfer-encoding'));
    return result;
  }

  const { boundary } = parseHeaderParams(contentType);
  if (!boundary) return result;
  for (const part of splitMultipart(body, boundary)) {
    const partContentType = part.headers.get('content-type') || 'text/plain';
    const disposition = part.headers.get('content-disposition') || '';
    const { filename } = parseHeaderParams(disposition.includes('filename') ? disposition : partContentType);
    const decoded = decodeBody(part.body, part.headers.get('content-transfer-encoding'));
    if (filename || /^application\//i.test(partContentType)) {
      result.attachments.push({ filename: filename || null, contentType: partContentType.split(';')[0].trim(), content: decoded });
    } else if (/^text\/plain/i.test(partContentType) && !result.textBody) {
      result.textBody = decoded;
    }
  }
  return result;
}

module.exports = { parseMimeMessage, extractAddresses, splitHeadersAndBody };
