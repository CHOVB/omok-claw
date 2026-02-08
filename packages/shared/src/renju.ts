import type { Board, PlayerColor } from "./index.js";

const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1]
] as const;

const BOARD_SIZE = 15;

type Point = { x: number; y: number };

type EvalResult = {
  forbidden: boolean;
  win: boolean;
  winColor?: PlayerColor;
  reason?: string;
};

const inBounds = (x: number, y: number) =>
  x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;

const getCell = (
  board: Board,
  x: number,
  y: number,
  virtuals?: Array<{ x: number; y: number; color: PlayerColor }>
) => {
  if (virtuals) {
    for (const v of virtuals) {
      if (x === v.x && y === v.y) return v.color;
    }
  }
  return board[y][x];
};

const countConsecutive = (
  board: Board,
  x: number,
  y: number,
  dx: number,
  dy: number,
  color: PlayerColor,
  virtuals?: Array<{ x: number; y: number; color: PlayerColor }>
) => {
  let left = 0;
  let cx = x - dx;
  let cy = y - dy;
  while (inBounds(cx, cy) && getCell(board, cx, cy, virtuals) === color) {
    left += 1;
    cx -= dx;
    cy -= dy;
  }
  let right = 0;
  cx = x + dx;
  cy = y + dy;
  while (inBounds(cx, cy) && getCell(board, cx, cy, virtuals) === color) {
    right += 1;
    cx += dx;
    cy += dy;
  }
  return { left, right, length: left + 1 + right };
};

const isOnSegment = (
  startX: number,
  startY: number,
  dx: number,
  dy: number,
  length: number,
  x: number,
  y: number
) => {
  if (dx === 0 && dy === 0) return false;
  let t: number | null = null;
  if (dx === 0) {
    if (x !== startX) return false;
    t = (y - startY) / dy;
  } else if (dy === 0) {
    if (y !== startY) return false;
    t = (x - startX) / dx;
  } else {
    const tx = (x - startX) / dx;
    const ty = (y - startY) / dy;
    if (tx !== ty) return false;
    t = tx;
  }
  return Number.isInteger(t) && t >= 0 && t < length;
};

const exactFiveIncluding = (
  board: Board,
  color: PlayerColor,
  placed: Point,
  include: Point,
  dx: number,
  dy: number,
  virtuals?: Array<{ x: number; y: number; color: PlayerColor }>
) => {
  const { left, length } = countConsecutive(
    board,
    placed.x,
    placed.y,
    dx,
    dy,
    color,
    virtuals
  );
  if (length !== 5) return false;
  const startX = placed.x - left * dx;
  const startY = placed.y - left * dy;
  return isOnSegment(startX, startY, dx, dy, length, include.x, include.y);
};

const hasExactFive = (board: Board, move: Point, color: PlayerColor) => {
  return DIRECTIONS.some(([dx, dy]) =>
    exactFiveIncluding(board, color, move, move, dx, dy)
  );
};

const hasFiveOrMore = (board: Board, move: Point, color: PlayerColor) => {
  return DIRECTIONS.some(([dx, dy]) => {
    const { length } = countConsecutive(board, move.x, move.y, dx, dy, color);
    return length >= 5;
  });
};

const hasOverline = (board: Board, move: Point, color: PlayerColor) => {
  return DIRECTIONS.some(([dx, dy]) => {
    const { length } = countConsecutive(board, move.x, move.y, dx, dy, color);
    return length >= 6;
  });
};

const countWinningEmptiesInDirection = (
  board: Board,
  color: PlayerColor,
  move: Point,
  dx: number,
  dy: number,
  virtualMove?: Point
) => {
  let count = 0;
  const moveVirtual = virtualMove ? { ...virtualMove, color } : undefined;
  for (let step = -4; step <= 4; step += 1) {
    const x = move.x + step * dx;
    const y = move.y + step * dy;
    if (!inBounds(x, y)) continue;
    if (getCell(board, x, y, moveVirtual ? [moveVirtual] : undefined) !== null) {
      continue;
    }
    const virtuals = [
      ...(moveVirtual ? [moveVirtual] : []),
      { x, y, color }
    ];
    if (exactFiveIncluding(board, color, { x, y }, move, dx, dy, virtuals)) {
      count += 1;
    }
  }
  return count;
};

const countFoursCreated = (board: Board, move: Point, color: PlayerColor) => {
  let fours = 0;
  for (const [dx, dy] of DIRECTIONS) {
    const count = countWinningEmptiesInDirection(board, color, move, dx, dy);
    if (count >= 1) fours += 1;
  }
  return fours;
};

const createsOpenFour = (
  board: Board,
  move: Point,
  color: PlayerColor,
  virtualMove?: Point
) => {
  for (const [dx, dy] of DIRECTIONS) {
    const count = countWinningEmptiesInDirection(
      board,
      color,
      move,
      dx,
      dy,
      virtualMove
    );
    if (count >= 2) return true;
  }
  return false;
};

const countOpenThreesCreatedByMove = (
  board: Board,
  move: Point,
  color: PlayerColor
) => {
  let count = 0;
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (board[y][x] !== null) continue;
      if (createsOpenFour(board, { x, y }, color, move)) {
        count += 1;
        if (count >= 2) return count;
      }
    }
  }
  return count;
};

export const evaluateMove = (
  board: Board,
  move: { x: number; y: number; color: PlayerColor }
): EvalResult => {
  const color = move.color;
  const isBlack = color === "black";

  if (isBlack) {
    const overline = hasOverline(board, move, color);
    const winExact = hasExactFive(board, move, color);
    const fours = countFoursCreated(board, move, color);
    const threes = countOpenThreesCreatedByMove(board, move, color);

    if (overline || fours >= 2 || threes >= 2) {
      return {
        forbidden: true,
        win: false,
        winColor: "white",
        reason: overline ? "overline" : fours >= 2 ? "double_four" : "double_three"
      };
    }

    if (winExact) {
      return { forbidden: false, win: true, winColor: "black", reason: "five_exact" };
    }

    return { forbidden: false, win: false };
  }

  if (hasFiveOrMore(board, move, color)) {
    return { forbidden: false, win: true, winColor: "white", reason: "five_or_more" };
  }

  return { forbidden: false, win: false };
};
