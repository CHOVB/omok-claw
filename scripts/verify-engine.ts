import assert from "node:assert/strict";
import { evaluateMove, type Board } from "../packages/shared/src/index";

const emptyBoard = (): Board =>
  Array.from({ length: 15 }, () =>
    Array.from({ length: 15 }, () => null as "black" | "white" | null)
  );

const place = (board: Board, points: Array<[number, number, "black" | "white"]>) => {
  for (const [x, y, c] of points) board[y][x] = c;
};

const run = () => {
  {
    const b = emptyBoard();
    place(b, [
      [0, 7, "black"],
      [1, 7, "black"],
      [2, 7, "black"],
      [3, 7, "black"],
      [4, 7, "black"]
    ]);
    const r = evaluateMove(b, { x: 4, y: 7, color: "black" });
    assert.equal(r.forbidden, false);
    assert.equal(r.win, true);
    assert.equal(r.winColor, "black");
  }

  {
    const b = emptyBoard();
    place(b, [
      [0, 7, "black"],
      [1, 7, "black"],
      [2, 7, "black"],
      [3, 7, "black"],
      [4, 7, "black"],
      [5, 7, "black"]
    ]);
    const r = evaluateMove(b, { x: 5, y: 7, color: "black" });
    assert.equal(r.forbidden, true);
    assert.equal(r.reason, "overline");
    assert.equal(r.win, false);
    assert.equal(r.winColor, "white");
  }

  {
    const b = emptyBoard();
    place(b, [
      [0, 7, "white"],
      [1, 7, "white"],
      [2, 7, "white"],
      [3, 7, "white"],
      [4, 7, "white"],
      [5, 7, "white"]
    ]);
    const r = evaluateMove(b, { x: 5, y: 7, color: "white" });
    assert.equal(r.forbidden, false);
    assert.equal(r.win, true);
    assert.equal(r.winColor, "white");
  }

  {
    const b = emptyBoard();
    place(b, [
      [14, 0, "black"],
      [0, 2, "black"],
      [9, 2, "black"],
      [2, 3, "black"],
      [5, 3, "white"],
      [13, 3, "black"],
      [13, 4, "black"],
      [8, 5, "black"],
      [13, 5, "black"],
      [12, 6, "black"],
      [5, 7, "white"],
      [11, 7, "black"],
      [13, 7, "black"],
      [9, 9, "black"],
      [12, 11, "black"],
      [1, 12, "black"]
    ]);
    const r = evaluateMove(b, { x: 13, y: 5, color: "black" });
    assert.equal(r.forbidden, true);
    assert.equal(r.reason, "double_four");
  }

  console.log("engine verification passed");
};

run();