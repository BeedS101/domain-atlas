// Domain Atlas — chess (task #195)
//
// A self-contained, dependency-free chess engine plus a simple bot, for an
// in-world "Play Chess" interactable (see demo-domain-a's plaza scene and
// viewer.js's handleInteractable). Deliberately NOT wired into the asset/
// credential system at all — no manifest field, no signed credential, no
// SPEC.md change. This is exactly the kind of "only matters inside one
// domain" feature SPEC.md §10 already carves out for the protocol to have
// no opinion on (the same category chat, presence, and calendar already
// sit in) — a scene-local minigame, same spirit as the market's mining
// stalls, just with client-side rules instead of a mint.
//
// Human vs. bot only for now, one board per open panel, no persistence
// across a page reload — a deliberate v1 scope cut. Two-player (a real
// second visitor) is future work, tracked in the private backlog, not
// this file.
//
// Board representation: a plain 64-entry array, index = rank*8 + file,
// rank 0/file 0 = a1 (white's own corner), rank increasing toward black's
// side, matching how a real board is usually described. Each square holds
// either null or a two-character piece code: color ('w'/'b') + type
// ('p','n','b','r','q','k'), e.g. 'wp' for a white pawn. Everything below
// works in {rank, file} pairs and only converts to a flat index at the
// last moment, specifically to avoid the classic off-by-one/wraparound bug
// of doing pawn-capture arithmetic directly on flat indices (idx+7 "looks"
// like a diagonal move but silently wraps across the board edge for a
// pawn on the a-file or h-file if you're not careful).

const AtlasChess = (() => {
  const FILES = 'abcdefgh';

  function idx(rank, file) { return rank * 8 + file; }
  function rankOf(i) { return Math.floor(i / 8); }
  function fileOf(i) { return i % 8; }
  function inBounds(rank, file) { return rank >= 0 && rank < 8 && file >= 0 && file < 8; }
  function squareName(i) { return FILES[fileOf(i)] + (rankOf(i) + 1); }
  function colorOf(piece) { return piece ? piece[0] : null; }
  function typeOf(piece) { return piece ? piece[1] : null; }
  function opponent(color) { return color === 'w' ? 'b' : 'w'; }

  const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
  // A light center-distance bonus for knights/bishops and a small
  // advancement bonus for pawns — just enough that the bot doesn't play
  // moves that are materially equal but obviously pointless (like leaving
  // a knight on the rim forever). Not a real positional engine; a
  // disclosed simplification, same spirit as this project's other
  // "good enough for a demo, not a research project" cuts.
  const CENTER_DISTANCE = (() => {
    const table = new Array(64).fill(0);
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const dr = Math.abs(r - 3.5);
        const df = Math.abs(f - 3.5);
        table[idx(r, f)] = 3 - (dr + df); // ranges roughly -4..+3, higher = more central
      }
    }
    return table;
  })();

  function startingBoard() {
    const board = new Array(64).fill(null);
    const backRank = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
    for (let f = 0; f < 8; f++) {
      board[idx(0, f)] = 'w' + backRank[f];
      board[idx(1, f)] = 'wp';
      board[idx(6, f)] = 'bp';
      board[idx(7, f)] = 'b' + backRank[f];
    }
    return board;
  }

  function cloneState(state) {
    return {
      board: state.board.slice(),
      turn: state.turn,
      castling: Object.assign({}, state.castling),
      enPassant: state.enPassant,
      halfmoveClock: state.halfmoveClock,
      playerColor: state.playerColor,
      status: state.status,
      winner: state.winner,
      lastMove: state.lastMove ? Object.assign({}, state.lastMove) : null,
      captured: { w: state.captured.w.slice(), b: state.captured.b.slice() },
      moveNumber: state.moveNumber,
    };
  }

  function createGame(playerColor) {
    const state = {
      board: startingBoard(),
      turn: 'w',
      castling: { wk: true, wq: true, bk: true, bq: true },
      enPassant: null,
      halfmoveClock: 0,
      playerColor: playerColor === 'b' ? 'b' : 'w',
      status: 'active', // 'active' | 'checkmate' | 'stalemate' | 'draw'
      winner: null, // 'w' | 'b' | null
      lastMove: null,
      captured: { w: [], b: [] },
      moveNumber: 1,
    };
    return state;
  }

  // --- Attack detection -----------------------------------------------
  // Scans outward from the target square rather than checking every
  // piece's own move list — simpler to get right, and plenty fast for a
  // 64-square board with no time pressure beyond "feels instant to a
  // person clicking a square."
  const KNIGHT_DELTAS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const KING_DELTAS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const DIAGONAL_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const ORTHOGONAL_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  function isSquareAttacked(board, rank, file, byColor) {
    // Pawns: a byColor pawn attacks diagonally toward the opponent's side.
    const pawnDr = byColor === 'w' ? -1 : 1; // look one rank BEHIND the target, from byColor's own advancing direction
    for (const df of [-1, 1]) {
      const r = rank + pawnDr, f = file + df;
      if (inBounds(r, f) && board[idx(r, f)] === byColor + 'p') return true;
    }
    for (const [dr, df] of KNIGHT_DELTAS) {
      const r = rank + dr, f = file + df;
      if (inBounds(r, f) && board[idx(r, f)] === byColor + 'n') return true;
    }
    for (const [dr, df] of KING_DELTAS) {
      const r = rank + dr, f = file + df;
      if (inBounds(r, f) && board[idx(r, f)] === byColor + 'k') return true;
    }
    for (const [dr, df] of DIAGONAL_DIRS) {
      let r = rank + dr, f = file + df;
      while (inBounds(r, f)) {
        const piece = board[idx(r, f)];
        if (piece) {
          if (colorOf(piece) === byColor && (typeOf(piece) === 'b' || typeOf(piece) === 'q')) return true;
          break;
        }
        r += dr; f += df;
      }
    }
    for (const [dr, df] of ORTHOGONAL_DIRS) {
      let r = rank + dr, f = file + df;
      while (inBounds(r, f)) {
        const piece = board[idx(r, f)];
        if (piece) {
          if (colorOf(piece) === byColor && (typeOf(piece) === 'r' || typeOf(piece) === 'q')) return true;
          break;
        }
        r += dr; f += df;
      }
    }
    return false;
  }

  function findKing(board, color) {
    const target = color + 'k';
    for (let i = 0; i < 64; i++) if (board[i] === target) return i;
    return -1; // should never happen in a legal game — both kings always exist
  }

  function isInCheck(state, color) {
    const kingSquare = findKing(state.board, color);
    if (kingSquare < 0) return false;
    return isSquareAttacked(state.board, rankOf(kingSquare), fileOf(kingSquare), opponent(color));
  }

  // --- Pseudo-legal move generation (ignores whether it leaves you in
  // check — generateLegalMoves below filters that out) --------------------
  function generatePseudoMoves(state, color) {
    const { board } = state;
    const moves = [];
    for (let from = 0; from < 64; from++) {
      const piece = board[from];
      if (!piece || colorOf(piece) !== color) continue;
      const rank = rankOf(from), file = fileOf(from);
      const type = typeOf(piece);

      if (type === 'p') {
        const dir = color === 'w' ? 1 : -1;
        const startRank = color === 'w' ? 1 : 6;
        const promoteRank = color === 'w' ? 7 : 0;
        const oneRank = rank + dir;
        if (inBounds(oneRank, file) && !board[idx(oneRank, file)]) {
          pushPawnMove(moves, from, idx(oneRank, file), null, oneRank === promoteRank);
          const twoRank = rank + dir * 2;
          if (rank === startRank && !board[idx(twoRank, file)]) {
            moves.push({ from, to: idx(twoRank, file), promotion: null, needsPromotion: false, isDoublePawn: true, isEnPassant: false });
          }
        }
        for (const df of [-1, 1]) {
          const f = file + df;
          if (!inBounds(oneRank, f)) continue;
          const target = idx(oneRank, f);
          const targetPiece = board[target];
          if (targetPiece && colorOf(targetPiece) !== color) {
            pushPawnMove(moves, from, target, null, oneRank === promoteRank);
          } else if (!targetPiece && state.enPassant === target) {
            moves.push({ from, to: target, promotion: null, needsPromotion: false, isDoublePawn: false, isEnPassant: true });
          }
        }
      } else if (type === 'n') {
        for (const [dr, df] of KNIGHT_DELTAS) {
          const r = rank + dr, f = file + df;
          if (!inBounds(r, f)) continue;
          const targetPiece = board[idx(r, f)];
          if (!targetPiece || colorOf(targetPiece) !== color) moves.push(plainMove(from, idx(r, f)));
        }
      } else if (type === 'k') {
        for (const [dr, df] of KING_DELTAS) {
          const r = rank + dr, f = file + df;
          if (!inBounds(r, f)) continue;
          const targetPiece = board[idx(r, f)];
          if (!targetPiece || colorOf(targetPiece) !== color) moves.push(plainMove(from, idx(r, f)));
        }
        addCastlingMoves(state, color, from, moves);
      } else {
        const dirs = type === 'b' ? DIAGONAL_DIRS : type === 'r' ? ORTHOGONAL_DIRS : DIAGONAL_DIRS.concat(ORTHOGONAL_DIRS);
        for (const [dr, df] of dirs) {
          let r = rank + dr, f = file + df;
          while (inBounds(r, f)) {
            const targetPiece = board[idx(r, f)];
            if (!targetPiece) {
              moves.push(plainMove(from, idx(r, f)));
            } else {
              if (colorOf(targetPiece) !== color) moves.push(plainMove(from, idx(r, f)));
              break;
            }
            r += dr; f += df;
          }
        }
      }
    }
    return moves;
  }

  function plainMove(from, to) {
    return { from, to, promotion: null, needsPromotion: false, isDoublePawn: false, isEnPassant: false };
  }
  function pushPawnMove(moves, from, to, promotion, needsPromotion) {
    moves.push({ from, to, promotion, needsPromotion: !!needsPromotion, isDoublePawn: false, isEnPassant: false });
  }

  // Castling is generated with its own legality (empty squares, rights,
  // and that the king isn't in/through/into check) baked in directly,
  // rather than relying on generateLegalMoves' generic "does this leave
  // my king in check" filter for the in-between square — that filter only
  // ever checks the FINAL position, and a king can't legally pass THROUGH
  // check on its way to castling even though the final square is safe.
  function addCastlingMoves(state, color, kingFrom, moves) {
    if (isInCheck(state, color)) return; // can't castle out of check
    const rank = color === 'w' ? 0 : 7;
    const rights = state.castling;
    const opp = opponent(color);
    const empty = (f) => !state.board[idx(rank, f)];
    const safe = (f) => !isSquareAttacked(state.board, rank, f, opp);

    if ((color === 'w' ? rights.wk : rights.bk) && empty(5) && empty(6) && safe(5) && safe(6)) {
      moves.push({ from: kingFrom, to: idx(rank, 6), promotion: null, needsPromotion: false, isCastle: 'k', isEnPassant: false });
    }
    if ((color === 'w' ? rights.wq : rights.bq) && empty(1) && empty(2) && empty(3) && safe(2) && safe(3)) {
      moves.push({ from: kingFrom, to: idx(rank, 2), promotion: null, needsPromotion: false, isCastle: 'q', isEnPassant: false });
    }
  }

  // Applies a move with no legality checking at all — the caller
  // (generateLegalMoves' own self-check filter, or makeMove after it's
  // already validated against the legal list) is responsible for only
  // ever calling this with a move that's actually meant to happen.
  function applyMoveRaw(state, move) {
    const next = cloneState(state);
    const board = next.board;
    const piece = board[move.from];
    const color = colorOf(piece);
    const capturedPiece = board[move.to];

    if (move.isEnPassant) {
      const capturedSquare = idx(rankOf(move.from), fileOf(move.to));
      next.captured[color].push(board[capturedSquare]);
      board[capturedSquare] = null;
    } else if (capturedPiece) {
      next.captured[color].push(capturedPiece);
    }

    board[move.to] = move.promotion ? color + move.promotion : piece;
    board[move.from] = null;

    if (move.isCastle) {
      const rank = rankOf(move.from);
      if (move.isCastle === 'k') { board[idx(rank, 5)] = board[idx(rank, 7)]; board[idx(rank, 7)] = null; }
      else { board[idx(rank, 3)] = board[idx(rank, 0)]; board[idx(rank, 0)] = null; }
    }

    // Castling-rights bookkeeping: a king move always forfeits both of its
    // own side's rights; a rook move OR a rook being captured on its own
    // home square forfeits just that one — the "captured on its home
    // square" half matters even if the rook itself never moved.
    if (typeOf(piece) === 'k') {
      if (color === 'w') { next.castling.wk = false; next.castling.wq = false; }
      else { next.castling.bk = false; next.castling.bq = false; }
    }
    const forfeitIfHomeRook = (square, key) => {
      if (move.from === square || move.to === square) next.castling[key] = false;
    };
    forfeitIfHomeRook(idx(0, 0), 'wq');
    forfeitIfHomeRook(idx(0, 7), 'wk');
    forfeitIfHomeRook(idx(7, 0), 'bq');
    forfeitIfHomeRook(idx(7, 7), 'bk');

    next.enPassant = move.isDoublePawn ? idx((rankOf(move.from) + rankOf(move.to)) / 2, fileOf(move.from)) : null;
    next.halfmoveClock = (typeOf(piece) === 'p' || capturedPiece || move.isEnPassant) ? 0 : state.halfmoveClock + 1;
    if (color === 'b') next.moveNumber = state.moveNumber + 1;
    next.turn = opponent(color);
    next.lastMove = { from: move.from, to: move.to, isCastle: move.isCastle || null, isEnPassant: !!move.isEnPassant, promotion: move.promotion || null };
    return next;
  }

  function generateLegalMoves(state, color) {
    const pseudo = generatePseudoMoves(state, color);
    const legal = [];
    for (const move of pseudo) {
      const next = applyMoveRaw(state, move);
      if (!isInCheck(next, color)) legal.push(move);
    }
    return legal;
  }

  function insufficientMaterial(board) {
    // Deliberately simplified (documented, not an oversight): treats any
    // "no pawns/rooks/queens, at most one minor piece per side" position
    // as a draw, including opposite-colored bishops — a real edge case
    // exists where two bishops on opposite colors can force mate, but it's
    // vanishingly rare and not worth the extra bookkeeping for a demo bot.
    const counts = { w: [], b: [] };
    for (const piece of board) {
      if (!piece) continue;
      const type = typeOf(piece);
      if (type === 'k') continue;
      if (type === 'p' || type === 'r' || type === 'q') return false;
      counts[colorOf(piece)].push(type);
    }
    return counts.w.length <= 1 && counts.b.length <= 1;
  }

  function finalizeStatus(state) {
    const legalMoves = generateLegalMoves(state, state.turn);
    const inCheck = isInCheck(state, state.turn);
    if (legalMoves.length === 0) {
      state.status = inCheck ? 'checkmate' : 'stalemate';
      state.winner = inCheck ? opponent(state.turn) : null;
    } else if (insufficientMaterial(state.board)) {
      state.status = 'draw';
    } else if (state.halfmoveClock >= 100) {
      state.status = 'draw'; // fifty-move rule; threefold repetition isn't tracked (v1 scope cut)
    } else {
      state.status = 'active';
      state.winner = null;
    }
    return { legalMoves, inCheck };
  }

  function getLegalMovesFrom(state, from) {
    if (state.status !== 'active') return [];
    return generateLegalMoves(state, state.turn).filter((m) => m.from === from);
  }

  // The one entry point the UI (and the bot) should call to actually play
  // a move — re-validates against the real legal list rather than trusting
  // the caller, the same "never trust, always re-check" discipline the
  // rest of this project applies to anything that changes state.
  function makeMove(state, move) {
    if (state.status !== 'active') throw new Error('Game is already over.');
    const legal = generateLegalMoves(state, state.turn);
    const candidate = legal.find((m) => m.from === move.from && m.to === move.to && (m.needsPromotion ? (move.promotion === 'q' || move.promotion === 'r' || move.promotion === 'b' || move.promotion === 'n') : true));
    if (!candidate) throw new Error('Illegal move.');
    const finalMove = candidate.needsPromotion ? Object.assign({}, candidate, { promotion: move.promotion }) : candidate;
    const next = applyMoveRaw(state, finalMove);
    const { inCheck } = finalizeStatus(next);
    next.inCheck = inCheck; // convenience flag for the UI; not used internally
    return next;
  }

  // --- Bot -------------------------------------------------------------
  // Easy: a uniformly random legal move — no lookahead at all.
  // Medium: 2-ply negamax (its move, your best reply) on material alone.
  // Hard: 3-ply negamax with alpha-beta pruning and capture-first move
  // ordering, material plus a light centralization/advancement bonus.
  // Depth 4 was measured (see test/manual-chess.js's own timing note) at
  // up to ~2.5s on a mid-opening position in plain Node — fine on its own,
  // but this runs synchronously on the extension page's main thread with
  // no worker, so a busier middlegame could visibly stall the UI for
  // several seconds. Depth 3 stays under ~300ms in the same test while
  // still searching a full extra ply past Medium, which is the right
  // trade for a casual demo bot. All three share the same move generator
  // and legality rules — the difficulty only changes how much the bot
  // LOOKS AHEAD, never what counts as a legal move.
  const DIFFICULTY_DEPTH = { easy: 0, medium: 2, hard: 3 };

  function evaluateMaterialAndPosition(board) {
    let score = 0;
    for (let i = 0; i < 64; i++) {
      const piece = board[i];
      if (!piece) continue;
      const type = typeOf(piece);
      let value = PIECE_VALUES[type];
      if (type === 'n' || type === 'b' || type === 'q') value += CENTER_DISTANCE[i] * 4;
      if (type === 'p') {
        const advancement = colorOf(piece) === 'w' ? rankOf(i) : 7 - rankOf(i);
        value += advancement * 6;
      }
      score += colorOf(piece) === 'w' ? value : -value;
    }
    return score;
  }

  // Score is always from the perspective of the side about to move in
  // `state` — standard negamax convention, so the recursive call just
  // negates rather than needing a separate "am I maximizing or minimizing"
  // branch for each side.
  function negamax(state, depth, alpha, beta) {
    const legalMoves = generateLegalMoves(state, state.turn);
    if (legalMoves.length === 0) {
      if (isInCheck(state, state.turn)) return -100000 - depth; // prefer a slower loss / faster win, all else equal
      return 0; // stalemate
    }
    if (depth === 0) {
      const raw = evaluateMaterialAndPosition(state.board);
      return state.turn === 'w' ? raw : -raw;
    }
    // Captures first — a cheap, well-known move-ordering trick that lets
    // alpha-beta prune far more of the tree than trying moves in board
    // order would, which matters most at Hard's depth of 4.
    const ordered = legalMoves.slice().sort((a, b) => (state.board[b.to] ? 1 : 0) - (state.board[a.to] ? 1 : 0));
    let best = -Infinity;
    for (const move of ordered) {
      const finalMove = move.needsPromotion ? Object.assign({}, move, { promotion: 'q' }) : move; // bot always queens (v1 scope cut — see class comment)
      const next = applyMoveRaw(state, finalMove);
      const score = -negamax(next, depth - 1, -beta, -alpha);
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break; // beta cutoff
    }
    return best;
  }

  function getBotMove(state, difficulty) {
    const legalMoves = generateLegalMoves(state, state.turn);
    if (legalMoves.length === 0) return null;
    if (difficulty === 'easy') {
      return legalMoves[Math.floor(Math.random() * legalMoves.length)];
    }
    const depth = DIFFICULTY_DEPTH[difficulty] || DIFFICULTY_DEPTH.medium;
    let bestMove = null;
    let bestScore = -Infinity;
    const ordered = legalMoves.slice().sort((a, b) => (state.board[b.to] ? 1 : 0) - (state.board[a.to] ? 1 : 0));
    for (const move of ordered) {
      const finalMove = move.needsPromotion ? Object.assign({}, move, { promotion: 'q' }) : move;
      const next = applyMoveRaw(state, finalMove);
      const score = -negamax(next, depth - 1, -Infinity, Infinity);
      if (score > bestScore) { bestScore = score; bestMove = finalMove; }
    }
    return bestMove;
  }

  return {
    createGame,
    getLegalMovesFrom,
    makeMove,
    getBotMove,
    isInCheck,
    squareName,
    colorOf,
    typeOf,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AtlasChess;
