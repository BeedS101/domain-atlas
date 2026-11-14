// Opens the probe as an extension page (chrome-extension://<id>/probe.html) in a tab: a toolbar popup would close
// when the system passkey dialog takes focus. The tab also opens once on install so the probe is not started from a
// copy of the HTML file on disk, which has no extension origin and cannot use passkeys.
const open = () => chrome.tabs.create({ url: chrome.runtime.getURL('probe.html') });
chrome.action.onClicked.addListener(open);
chrome.runtime.onInstalled.addListener((details) => { if (details.reason === 'install') open(); });
