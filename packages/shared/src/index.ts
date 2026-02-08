export type PlayerColor = "black" | "white";

export type GamePhase =
  | "opening_1"
  | "opening_2"
  | "opening_3"
  | "opening_4"
  | "opening_5"
  | "midgame";

export type Move = {
  x: number;
  y: number;
  color: PlayerColor;
  moveNumber: number;
};

export type BoardCell = PlayerColor | null;
export type Board = BoardCell[][];

export { evaluateMove } from "./renju";
