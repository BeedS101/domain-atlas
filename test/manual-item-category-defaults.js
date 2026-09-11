// Manual check for #152 (follow-up to #151): a domain-level DEFAULT for
// policy.acceptedItemClasses, and trailing-".*" CATEGORY matching — both
// added after Bruno hit the exact friction live while writing his own
// evtec.co.za manifest: (1) copy-pasting the identical acceptedItemClasses
// array into every world in a domain, and (2) expecting "atlas.wearable"/
// "atlas.element" to cover their whole families ("atlas.wearable.ring",
// "atlas.element.iron"/"atlas.element.gold") when the matching was always
// an exact string check.
//
// Exercises the real, page-global functions directly against synthetic
// manifest/world/entry objects — same technique manual-asset-viewer.js
// uses for its "neither thumbnail nor model" case — rather than editing
// the demo domain's own spatial.json, since these are pure functions with
// no network/wallet dependency once a manifest is loaded (entering a world
// is still needed first, since giveawayClassFor() and
// isAssetCompatibleWithWorld() close over currentManifest for the
// trustedIssuers: "self" comparison).
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts. Assumes issuer-server is already running on 8001
// (see README §1) — 8002 isn't needed for this one.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

function fakeEntry(cls, issuerDomain) {
  return { credential: { asset: { class: cls }, issuer: { domain: issuerDomain } } };
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-category-defaults');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    console.log('SETUP: in Example Plaza, currentManifest/currentWorld live');

    console.log('STEP 1: classMatchesAny — trailing ".*" matches the whole family, exact entries still match only themselves');
    const matchResults = await frame.evaluate(() => ({
      wildcardHitsIron: classMatchesAny('atlas.element.iron', ['atlas.element.*']),
      wildcardHitsGold: classMatchesAny('atlas.element.gold', ['atlas.element.*']),
      wildcardMissesElementary: classMatchesAny('atlas.elementary.thing', ['atlas.element.*']),
      exactMissesRing: classMatchesAny('atlas.wearable.ring', ['atlas.wearable']),
      exactHitsWearable: classMatchesAny('atlas.wearable', ['atlas.wearable'])
    }));
    if (!matchResults.wildcardHitsIron || !matchResults.wildcardHitsGold) throw new Error('Expected "atlas.element.*" to match both iron and gold, got: ' + JSON.stringify(matchResults));
    if (matchResults.wildcardMissesElementary !== false) throw new Error('Expected "atlas.element.*" to NOT match "atlas.elementary.thing" (prefix must stop at the dot), got true');
    if (matchResults.exactMissesRing !== false) throw new Error('Expected plain "atlas.wearable" to NOT match "atlas.wearable.ring" (no implicit family match), got true');
    if (!matchResults.exactHitsWearable) throw new Error('Expected plain "atlas.wearable" to still match itself exactly');
    console.log('PASS: wildcard categories match their family; exact entries stay exact');

    console.log('STEP 2: effectiveAcceptedItemClasses — world\'s own array (even empty) always wins over the domain default; only a MISSING field falls back');
    const fallbackResults = await frame.evaluate(() => {
      const domainDefault = { acceptedItemClasses: ['atlas.wearable', 'atlas.element.*'] };
      const worldWithNoOwnField = { policy: { itemDropsAllowed: true } };
      const worldWithEmptyOwnArray = { policy: { itemDropsAllowed: true, acceptedItemClasses: [] } };
      const worldWithOwnArray = { policy: { itemDropsAllowed: true, acceptedItemClasses: ['com.example.custom'] } };
      return {
        inheritsDomainDefault: effectiveAcceptedItemClasses(domainDefault, worldWithNoOwnField),
        emptyArrayNotOverridden: effectiveAcceptedItemClasses(domainDefault, worldWithEmptyOwnArray),
        ownArrayWinsOutright: effectiveAcceptedItemClasses(domainDefault, worldWithOwnArray)
      };
    });
    if (fallbackResults.inheritsDomainDefault.join(',') !== 'atlas.wearable,atlas.element.*') throw new Error('Expected a world with no acceptedItemClasses field to inherit the domain default, got: ' + JSON.stringify(fallbackResults.inheritsDomainDefault));
    if (fallbackResults.emptyArrayNotOverridden.length !== 0) throw new Error('Expected a world\'s own EMPTY acceptedItemClasses to stay empty (not be replaced by the domain default), got: ' + JSON.stringify(fallbackResults.emptyArrayNotOverridden));
    if (fallbackResults.ownArrayWinsOutright.join(',') !== 'com.example.custom') throw new Error('Expected a world\'s own non-empty array to win outright over the domain default, got: ' + JSON.stringify(fallbackResults.ownArrayWinsOutright));
    console.log('PASS: domain default only fills in for a genuinely missing field, never merges with or overrides a world\'s own declaration');

    console.log('STEP 3: isAssetCompatibleWithWorld end to end — domain default + wildcard category together, exactly Bruno\'s evtec.co.za scenario');
    const compatResults = await frame.evaluate((args) => {
      const manifest = { domain: 'evtec.co.za', acceptedItemClasses: ['atlas.wearable', 'atlas.element.*'] };
      const world = { policy: { itemDropsAllowed: true, trustedIssuers: 'self' } }; // no own acceptedItemClasses — inherits the domain default
      return {
        wearableFromSelfCompatible: isAssetCompatibleWithWorld(args.wearableFromSelf, world, manifest),
        ironFromSelfCompatible: isAssetCompatibleWithWorld(args.ironFromSelf, world, manifest),
        ringFromSelfNotCompatible: isAssetCompatibleWithWorld(args.ringFromSelf, world, manifest),
        goldFromOtherDomainNotCompatible: isAssetCompatibleWithWorld(args.goldFromOther, world, manifest)
      };
    }, {
      wearableFromSelf: fakeEntry('atlas.wearable', 'evtec.co.za'),
      ironFromSelf: fakeEntry('atlas.element.iron', 'evtec.co.za'),
      ringFromSelf: fakeEntry('atlas.wearable.ring', 'evtec.co.za'), // exact "atlas.wearable" in the list should NOT cover this
      goldFromOther: fakeEntry('atlas.element.gold', 'someone-else.example') // right class family, wrong issuer under trustedIssuers: "self"
    });
    if (!compatResults.wearableFromSelfCompatible) throw new Error('Expected a plain atlas.wearable from the domain itself to be compatible via the inherited domain default');
    if (!compatResults.ironFromSelfCompatible) throw new Error('Expected atlas.element.iron to be compatible via the "atlas.element.*" category entry');
    if (compatResults.ringFromSelfNotCompatible) throw new Error('Expected atlas.wearable.ring to stay INCOMPATIBLE — "atlas.wearable" in the list is exact, not a family match');
    if (compatResults.goldFromOtherDomainNotCompatible) throw new Error('Expected gold from a different issuer to be rejected by trustedIssuers: "self", even though its class matches "atlas.element.*"');
    console.log('PASS: domain-default + wildcard category correctly combine with trustedIssuers — exactly the evtec.co.za scenario now works with one shared array');

    console.log('STEP 4: giveawayClassFor skips wildcard entries — a world/domain declaring only categories has nothing concrete to hand out');
    const giveawayResults = await frame.evaluate(() => {
      const onlyWildcards = { policy: { itemDropsAllowed: true, acceptedItemClasses: ['atlas.element.*', 'atlas.wearable.*'] } };
      const mixedList = { policy: { itemDropsAllowed: true, acceptedItemClasses: ['atlas.element.*', 'atlas.badge'] } };
      return {
        onlyWildcardsGivesNull: giveawayClassFor(onlyWildcards),
        mixedListSkipsToConcrete: giveawayClassFor(mixedList)
      };
    });
    if (giveawayResults.onlyWildcardsGivesNull !== null) throw new Error('Expected giveawayClassFor to return null when every entry is a wildcard category, got: ' + giveawayResults.onlyWildcardsGivesNull);
    if (giveawayResults.mixedListSkipsToConcrete !== 'atlas.badge') throw new Error('Expected giveawayClassFor to skip the leading wildcard and pick the first concrete class, got: ' + giveawayResults.mixedListSkipsToConcrete);
    console.log('PASS: give-away logic never tries to hand out a wildcard category as if it were a real class');

    console.log('\nALL CHECKS PASSED — #152 domain-level default + ".*" category matching both working correctly, and composing correctly with #151\'s trustedIssuers check.');
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
