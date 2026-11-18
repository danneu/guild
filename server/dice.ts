// Rolls dice from a roll's text, such as "2d6+3". The grammar and its
// generated parser live in server/dice_parser.ts.

import { DiceSyntaxError, parse, type Sign, type Term } from "./dice_parser";

// A term once rolled. values holds each die, negated for a "-" term, or the
// constant's signed value.
export type RolledTerm = Term & { values: number[] };

// What roll did with a roll's text. Only OK carries a total, so no caller can
// show or store a total for text the roll refused. Its syntax is the text that
// was rolled.
export type RollResult =
  | { type: "OK"; syntax: string; total: number; rolls: RolledTerm[] }
  | { type: "INVALID"; message: string };

export type Rolled = Extract<RollResult, { type: "OK" }>;

// The most terms one roll may have.
const MAX_TERMS = 5;

// INVALID carries a message written for the roller. Any error other than the
// parser's refusal is a bug, and throws.
export function roll(syntax: string): RollResult {
  let terms: Term[];
  try {
    terms = parse(syntax);
  } catch (err) {
    if (err instanceof DiceSyntaxError) {
      return { type: "INVALID", message: err.message };
    }
    throw err;
  }
  if (terms.length > MAX_TERMS) {
    return {
      type: "INVALID",
      message: `Cannot have more than ${MAX_TERMS} roll terms`,
    };
  }
  for (const term of terms) {
    const message = refuseTerm(term);
    if (message !== null) {
      return { type: "INVALID", message };
    }
  }
  const rolls = terms.map((term) => ({ ...term, values: termValues(term) }));
  const total = rolls.reduce((memo, r) => memo + sum(r.values), 0);
  return { type: "OK", syntax, total, rolls };
}

////////////////////////////////////////////////////////////
// HELPERS
////////////////////////////////////////////////////////////

function sum(nums: number[]): number {
  return nums.reduce((memo, num) => memo + num, 0);
}

// Why a term may not be rolled, or null when it may. 999 is chosen so <input>
// boxes can just have maxlength="999".
function refuseTerm(term: Term): string | null {
  if (term.type === "Constant") {
    return term.value > 999 ? "Constant roll value cannot exceed 1000" : null;
  }
  if (term.sides > 999) {
    return "DiceRoll cannot have more than 999 sides";
  }
  if (term.count > 999) {
    return "DiceRoll cannot roll more than 999 dice";
  }
  return null;
}

function termValues(term: Term): number[] {
  if (term.type === "Constant") {
    return [term.sign === "-" ? -term.value : term.value];
  }
  return rollValues(term.sign, term.count, term.sides);
}

// for '3d6', diceCount=3, sides=6, output=[1, 5, 6]
function rollValues(sign: Sign, diceCount: number, sides: number): number[] {
  const values: number[] = [];
  for (let i = 0; i < diceCount; i++) {
    let val = Math.floor(Math.random() * sides) + 1;
    if (sign === "-") val = -val;
    values.push(val);
  }
  return values;
}
