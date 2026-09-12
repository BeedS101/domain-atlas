// Manual check for task #195 — in-world chess (extension/chess.js's engine
// plus the modal UI wired into viewer.js). The engine itself is already
// covered by node-level correctness checks (perft against the standard
// starting position and the "Kiwipete" position through depth 3, which
// between them exercise castling, en passant, promotion, and check
// detection — see the chess.js development notes) run directly against
// chess.js with `node`, not through a browser. This script instead
// exercises the UI SEAM: does clicking a board square actually call into
// the engine and re-render, does the bot reply on its own, does the
// promotion picker appear and work, does a forced checkmate position
// actually show up as one, do New Game / Close / difficulty / play-as-
// color all do what they say. Where a scenario needs a specific position
// (checkmate one move away, a pawn one step from promoting) that isn't
// worth waiting on the bot to wander into, this script injects a state
// directly into the page's own `chessGame` variable and re-renders — the
// same "set up the state, exercise the real UI path from there" approach
// as this suite's other harder-to-reach-by-clicking-alone scenarios.
//
// Chess needs no identity at all to PLAY (see handleInteractable's own
// comment in viewer.js) — STEPs 1-9 below exercise that with no
// onboarding/unlock step at all. Task #201 adds one exception: collecting a
// win's reward (gold, plus a trophy for Hard) does mint a real credential,
// so STEPs 10-12 create an identity the ordinary onboarding way and check
// it against the real wallet. Requires domain A's issuer-server on 8001 —
// unlike the rest of this file, STEPs 10-12 do exercise a real mint against
// it. Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const FILES = 'abcdefgh';

function sq(name) {
  const file = FILES.indexOf(name[0]);
  const rank = parseInt(name[1], 10) - 1;
  return rank * 8 + file;
}

// Mirrors the createIdentity() helper other manual-*.js scripts already use
// (e.g. manual-chat-dynamic-tabs.js) — the ordinary onboarding UI flow, not
// a shortcut, since STEP 9 below is specifically checking that a real
// AtlasWallet.mintAsset() call lands in a real wallet.
async function createIdentity(frame, password) {
  await frame.locator('#walletBtn').click();
  await frame.locator('#chooseNewBtn').click();
  await frame.locator('#newPasswordInput').fill(password);
  await frame.locator('#newPasswordConfirmInput').fill(password);
  await frame.locator('#confirmCreateBtn').click();
  await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
  await frame.locator('#seedConfirmCheck').check();
  await frame.locator('#seedConfirmBtn').click();
  await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
  await frame.locator('#walletBtn').click(); // close the wallet back down
}

async function projectInteractables(frame) {
  return frame.evaluate(() => new Promise((resolve) => {
    const check = () => {
      const scene = window.__atlasScene;
      if (scene && scene.interactables && scene.interactables.length) {
        const canvas = document.getElementById('scene');
        const originX = canvas.width / 2;
        const originY = canvas.height / 2 + 40;
        resolve(scene.interactables.map((m) => {
          const [x, y, z] = m.position;
          const p = project(x, y || 0, z, originX, originY);
          return { sx: p.x, sy: p.y - 16, label: m.label, action: m.action };
        }));
      } else {
        requestAnimationFrame(check);
      }
    };
    check();
  }));
}

async function clickSquare(frame, name) {
  await frame.locator('.chess-square[data-square="' + sq(name) + '"]').click();
}

// Task #201 helpers — read the reward straight out of the real wallet
// (AtlasWallet is a page global exactly like AtlasChess/chessGame above),
// not off the status line alone, so these checks confirm a real credential
// actually landed rather than just that the right words got printed.
async function goldBalance(frame, publicKey) {
  return frame.evaluate(async (publicKey) => {
    const wallet = await AtlasWallet.getWallet(publicKey);
    const entry = wallet.find((e) => e.credential.asset.class === 'atlas.element.gold');
    return entry ? entry.credential.quantity : 0;
  }, publicKey);
}

async function trophyCount(frame, publicKey) {
  return frame.evaluate(async (publicKey) => {
    const wallet = await AtlasWallet.getWallet(publicKey);
    return wallet.filter((e) => e.credential.asset.class === 'atlas.trophy.chess').length;
  }, publicKey);
}

// Wins a forced one-move checkmate for White (the player) from a freshly
// injected position, at whatever difficulty is currently selected in
// #chessDifficultyInput — reuses injectPosition's own back-rank-mate shape
// from STEP 6 above, just parameterized so STEPs 9-12 can each trigger a
// fresh win without repeating the same five lines four times.
async function winByBackRankMate(frame) {
  await injectPosition(frame, { a1: 'wq', e1: 'wk', f7: 'bp', g7: 'bp', h7: 'bp', h8: 'bk' }, { turn: 'w', playerColor: 'w' });
  await clickSquare(frame, 'a1');
  await clickSquare(frame, 'a8');
  await frame.waitForFunction(() => chessGame.status === 'checkmate', { timeout: 2000 });
}

// Injects a fully-formed game state directly (bypassing AtlasChess.createGame
// and every move that would normally lead there) and re-renders — see the
// header comment above for why this is the right tool for a scenario that
// needs a SPECIFIC position rather than whatever moves actually got played.
async function injectPosition(frame, boardMap, opts) {
  await frame.evaluate(({ boardMap, opts }) => {
    const board = new Array(64).fill(null);
    for (const [squareName, piece] of Object.entries(boardMap)) {
      const files = 'abcdefgh';
      const file = files.indexOf(squareName[0]);
      const rank = parseInt(squareName[1], 10) - 1;
      board[rank * 8 + file] = piece;
    }
    chessGame = {
      board, turn: opts.turn || 'w',
      castling: { wk: false, wq: false, bk: false, bq: false },
      enPassant: null, halfmoveClock: 0,
      playerColor: opts.playerColor || 'w',
      status: 'active', winner: null, lastMove: null,
      captured: { w: [], b: [] }, moveNumber: 1,
    };
    chessSelectedSquare = null;
    chessLegalTargets = [];
    chessBotThinking = false;
    renderChessAll();
  }, { boardMap, opts: opts || {} });
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-chess');
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

    console.log('STEP 1: the "Play Chess" table is a real interactable in the Plaza, and clicking it opens the modal with no identity prompt at all');
    const interactables = await projectInteractables(frame);
    const chessStall = interactables.find((m) => m.action === 'open-chess');
    if (!chessStall) throw new Error('Expected an "open-chess" interactable in the Plaza scene');
    await frame.locator('#scene').click({ position: { x: chessStall.sx, y: chessStall.sy } });
    await frame.waitForFunction(() => document.getElementById('chessModal').classList.contains('active'), { timeout: 5000 });
    const walletOpenedInstead = await frame.evaluate(() => document.getElementById('walletPanel').classList.contains('open'));
    if (walletOpenedInstead) throw new Error('Expected chess to skip the identity gate entirely — it never touches the wallet');
    const startSquareCount = await frame.locator('.chess-square').count();
    if (startSquareCount !== 64) throw new Error('Expected a rendered 8x8 board, got ' + startSquareCount + ' squares');
    console.log('PASS: modal opened from the in-scene stall, no wallet involved, 64 squares rendered');

    console.log('STEP 2: playing e2-e4 as White moves the piece and the bot (Black, Easy) replies on its own, no button to click for its turn');
    await frame.locator('#chessDifficultyInput').selectOption('easy');
    await clickSquare(frame, 'e2');
    const e4IsLegal = await frame.locator('.chess-square[data-square="' + sq('e4') + '"].legal-move').count();
    if (!e4IsLegal) throw new Error('Expected e4 to be highlighted as a legal destination for the e2 pawn');
    await clickSquare(frame, 'e4');
    await frame.waitForFunction(() => chessGame.board[28] === 'wp' && chessGame.board[12] === null, { timeout: 2000 }); // e4=28, e2=12
    await frame.waitForFunction(() => chessGame.turn === 'w' && !chessBotThinking, { timeout: 5000 });
    const movesSoFar = await frame.evaluate(() => chessGame.lastMove);
    if (!movesSoFar) throw new Error("Expected the bot's own reply to have landed as lastMove");
    console.log('PASS: e2-e4 applied, turn returned to White after the bot replied on its own ->', JSON.stringify(movesSoFar));

    console.log('STEP 3: clicking an illegal destination is inert — the piece stays put, no error, no move applied');
    const boardBefore = await frame.evaluate(() => chessGame.board.slice());
    await clickSquare(frame, 'e1'); // white king's home square — select it
    await clickSquare(frame, 'e5'); // not adjacent, not a legal king move
    const boardAfter = await frame.evaluate(() => chessGame.board.slice());
    if (JSON.stringify(boardBefore) !== JSON.stringify(boardAfter)) throw new Error('Expected an illegal target click to leave the board completely unchanged');
    console.log('PASS: illegal destination click left the position untouched');

    console.log('STEP 4: New Game resets to the standard starting position');
    await frame.locator('#chessNewGameBtn').click();
    const freshBoard = await frame.evaluate(() => chessGame.board.slice());
    if (freshBoard[sq('e2')] !== 'wp' || freshBoard[sq('e7')] !== 'bp' || freshBoard[sq('e4')] !== null) throw new Error('Expected New Game to restore the standard starting position');
    const freshStatus = await frame.locator('#chessStatus').textContent();
    if (!freshStatus.includes('Your move') || !freshStatus.includes('White')) throw new Error('Expected "Your move (White)" right after New Game, got: ' + freshStatus);
    console.log('PASS: New Game restored the standard position and "Your move (White)"');

    console.log('STEP 5: playing as Black lets the bot (White) move first, automatically');
    await frame.locator('#chessPlayerColorInput').selectOption('b');
    await frame.locator('#chessNewGameBtn').click();
    await frame.waitForFunction(() => chessGame.turn === 'b' && !chessBotThinking, { timeout: 5000 });
    const whiteMovedFirst = await frame.evaluate(() => chessGame.lastMove && chessGame.lastMove.from !== null);
    if (!whiteMovedFirst) throw new Error("Expected White (the bot) to have already made an opening move");
    console.log('PASS: bot opened as White with no action needed from the Black-playing visitor ->', await frame.evaluate(() => JSON.stringify(chessGame.lastMove)));
    await frame.locator('#chessPlayerColorInput').selectOption('w'); // reset for the rest of the script
    await frame.locator('#chessNewGameBtn').click();

    console.log('STEP 6: a forced one-move checkmate is detected and reported correctly (injected position — see this file\'s own header on why)');
    await injectPosition(frame, { a1: 'wq', e1: 'wk', f7: 'bp', g7: 'bp', h7: 'bp', h8: 'bk' }, { turn: 'w', playerColor: 'w' });
    await clickSquare(frame, 'a1');
    const a8IsLegal = await frame.locator('.chess-square[data-square="' + sq('a8') + '"].legal-move').count();
    if (!a8IsLegal) throw new Error('Expected Qa8# to be offered as a legal move from a1');
    await clickSquare(frame, 'a8');
    await frame.waitForFunction(() => chessGame.status === 'checkmate', { timeout: 2000 });
    const mateStatusText = await frame.locator('#chessStatus').textContent();
    if (!mateStatusText.includes('Checkmate') || !mateStatusText.includes('White wins') || !mateStatusText.includes('You won')) throw new Error('Expected a "Checkmate — White wins. You won!" style message, got: ' + mateStatusText);
    console.log('PASS: back-rank mate correctly detected and reported ->', mateStatusText);

    console.log('STEP 7: a pawn reaching the back rank shows the promotion picker, and the chosen piece actually lands on the board');
    await injectPosition(frame, { a7: 'wp', e1: 'wk', e8: 'bk' }, { turn: 'w', playerColor: 'w' });
    await clickSquare(frame, 'a7');
    await clickSquare(frame, 'a8');
    await frame.waitForFunction(() => document.getElementById('chessPromotionPicker').classList.contains('active'), { timeout: 2000 });
    // a7 = index 48, a8 = index 56 — plain literals here (not this file's
    // own Node-side sq() helper, which doesn't exist inside the page).
    const midState = await frame.evaluate(() => ({ a7: chessGame.board[48], a8: chessGame.board[56] }));
    if (midState.a7 !== 'wp' || midState.a8) throw new Error('Expected the move to stay pending (pawn still on a7, nothing yet on a8) until a promotion choice is made, got: ' + JSON.stringify(midState));
    await frame.locator('#chessPromotionPicker button[data-promo="n"]').click();
    await frame.waitForFunction(() => !document.getElementById('chessPromotionPicker').classList.contains('active'), { timeout: 2000 });
    const promotedPiece = await frame.evaluate(() => chessGame.board[56]); // a8
    if (promotedPiece !== 'wn') throw new Error('Expected the a7 pawn to have promoted to a white knight on a8, got: ' + promotedPiece);
    console.log('PASS: promotion picker appeared, held the move pending, and applied the chosen piece (knight) once resolved');

    console.log('STEP 8: Close hides the modal without ending the game; reopening the stall resumes the exact same position');
    const positionBeforeClose = await frame.evaluate(() => chessGame.board.slice());
    await frame.locator('#chessCloseBtn').click();
    await frame.waitForFunction(() => !document.getElementById('chessModal').classList.contains('active'), { timeout: 2000 });
    const freshInteractables = await projectInteractables(frame);
    const chessStallAgain = freshInteractables.find((m) => m.action === 'open-chess');
    await frame.locator('#scene').click({ position: { x: chessStallAgain.sx, y: chessStallAgain.sy } });
    await frame.waitForFunction(() => document.getElementById('chessModal').classList.contains('active'), { timeout: 5000 });
    const positionAfterReopen = await frame.evaluate(() => chessGame.board.slice());
    if (JSON.stringify(positionBeforeClose) !== JSON.stringify(positionAfterReopen)) throw new Error('Expected closing and reopening the modal to preserve the in-progress game');
    console.log('PASS: Close only hid the modal — the game (knight-on-a8 position from STEP 7) was exactly as left');

    console.log('STEP 9: winning with no identity yet shows a friendly note instead of a raw mint error (chess still needs no identity to play)');
    await frame.locator('#chessDifficultyInput').selectOption('easy');
    await winByBackRankMate(frame);
    await frame.waitForFunction(() => document.getElementById('chessStatus').textContent.includes('Create a wallet identity'), { timeout: 3000 });
    console.log('PASS: no-identity win degraded gracefully ->', await frame.locator('#chessStatus').textContent());

    console.log('STEP 10: winning on Easy with a real identity mints exactly 5 gold, no trophy');
    // The chess modal sits above everything else (z-index, see viewer.html)
    // and intercepts clicks, so #walletBtn needs it closed first — reopened
    // via the stall right after, same as STEP 8 already does.
    await frame.locator('#chessCloseBtn').click();
    await frame.waitForFunction(() => !document.getElementById('chessModal').classList.contains('active'), { timeout: 2000 });
    await createIdentity(frame, 'chess-reward-test-password');
    const publicKey = await frame.evaluate(() => AtlasWallet.getIdentity().then((i) => i.publicKey));
    const reopenInteractables = await projectInteractables(frame);
    const reopenChessStall = reopenInteractables.find((m) => m.action === 'open-chess');
    await frame.locator('#scene').click({ position: { x: reopenChessStall.sx, y: reopenChessStall.sy } });
    await frame.waitForFunction(() => document.getElementById('chessModal').classList.contains('active'), { timeout: 5000 });
    await winByBackRankMate(frame);
    await frame.waitForFunction(() => document.getElementById('chessStatus').textContent.includes('You earned'), { timeout: 5000 });
    const easyStatusText = await frame.locator('#chessStatus').textContent();
    if (!easyStatusText.includes('You earned 5 gold') || easyStatusText.includes('trophy')) throw new Error('Expected "You earned 5 gold!" with no trophy mention, got: ' + easyStatusText);
    const goldAfterEasy = await goldBalance(frame, publicKey);
    const trophiesAfterEasy = await trophyCount(frame, publicKey);
    if (goldAfterEasy !== 5) throw new Error('Expected a 5-gold wallet balance after an Easy win, got: ' + goldAfterEasy);
    if (trophiesAfterEasy !== 0) throw new Error('Expected no trophy after an Easy win, got: ' + trophiesAfterEasy);
    console.log('PASS: Easy win minted exactly 5 gold, no trophy ->', easyStatusText);

    console.log('STEP 11: winning on Hard mints 20 gold AND a trophy');
    await frame.locator('#chessDifficultyInput').selectOption('hard');
    await winByBackRankMate(frame);
    await frame.waitForFunction(() => document.getElementById('chessStatus').textContent.includes('You earned'), { timeout: 5000 });
    const hardStatusText = await frame.locator('#chessStatus').textContent();
    if (!hardStatusText.includes('You earned 20 gold') || !hardStatusText.includes('trophy')) throw new Error('Expected "You earned 20 gold + a trophy!", got: ' + hardStatusText);
    const goldAfterHard = await goldBalance(frame, publicKey);
    const trophiesAfterHard = await trophyCount(frame, publicKey);
    if (goldAfterHard !== 25) throw new Error('Expected a 25-gold running total (5 + 20) after the Hard win, got: ' + goldAfterHard);
    if (trophiesAfterHard !== 1) throw new Error('Expected exactly one trophy after the first Hard win, got: ' + trophiesAfterHard);
    console.log('PASS: Hard win minted 20 gold and a trophy ->', hardStatusText);

    console.log('STEP 12: winning on Hard again mints more gold but never a second trophy');
    await winByBackRankMate(frame);
    await frame.waitForFunction(() => document.getElementById('chessStatus').textContent.includes('You earned'), { timeout: 5000 });
    const secondHardStatusText = await frame.locator('#chessStatus').textContent();
    if (secondHardStatusText.includes('trophy')) throw new Error('Expected no trophy mention on a second Hard win (already held), got: ' + secondHardStatusText);
    const goldAfterSecondHard = await goldBalance(frame, publicKey);
    const trophiesAfterSecondHard = await trophyCount(frame, publicKey);
    if (goldAfterSecondHard !== 45) throw new Error('Expected a 45-gold running total (5 + 20 + 20) after the second Hard win, got: ' + goldAfterSecondHard);
    if (trophiesAfterSecondHard !== 1) throw new Error('Expected the trophy count to stay at exactly one, got: ' + trophiesAfterSecondHard);
    console.log('PASS: second Hard win added gold only — trophy stayed at exactly one ->', secondHardStatusText);

    console.log('\nALL CHESS CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
