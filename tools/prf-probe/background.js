// Opens the probe in a tab: a toolbar popup would close when the system passkey dialog takes focus.
chrome.action.onClicked.addListener(() => { chrome.tabs.create({ url: chrome.runtime.getURL('probe.html') }); });
