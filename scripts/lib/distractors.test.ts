import { test } from "node:test";
import assert from "node:assert/strict";
import { numericDistractors, validDistractors } from "./distractors";

test("years get nearby, distinct, non-future years", () => {
  for (let i = 0; i < 50; i++) {
    const d = numericDistractors("1939", "year")!;
    assert.equal(d.length, 3);
    assert.equal(new Set(d).size, 3);
    for (const y of d.map(Number)) {
      assert.ok(y !== 1939 && Math.abs(y - 1939) <= 15);
    }
  }
  const recent = numericDistractors("2024", "year")!;
  assert.ok(recent.every((y) => Number(y) <= new Date().getFullYear()));
});

test("numbers keep their unit and stay positive", () => {
  for (let i = 0; i < 50; i++) {
    const d = numericDistractors("26 years", "number")!;
    assert.equal(new Set(d).size, 3);
    assert.ok(d.every((x) => /^\d+ years$/.test(x) && x !== "26 years"));
    assert.ok(numericDistractors("1", "number")!.every((x) => Number(x) > 1));
  }
  assert.equal(numericDistractors("Paris", "city"), null);
  assert.equal(numericDistractors("76 to 79 bible books", "number"), null);
  assert.equal(numericDistractors("5 to 7 minutes", "number"), null);
});

test("LLM options are rejected if they could be the right answer", () => {
  const q = { question: "Q?", answer: "United States", accepted_answers: ["USA"], answer_type: "country" };
  assert.deepEqual(validDistractors(["Canada", "Mexico", "Brazil"], q), ["Canada", "Mexico", "Brazil"]);
  assert.equal(validDistractors(["Canada", "USA", "Mexico"], q), null); // only 2 valid left
  assert.deepEqual(validDistractors(["Canada", "America", "Mexico", "Cuba"], q), ["Canada", "Mexico", "Cuba"]);
  assert.equal(validDistractors(["Canada", "Canada", "Mexico"], q), null);
  assert.equal(validDistractors("nope", q), null);
});

test("options that are partly right or echo the question are rejected", () => {
  const aldi = { question: "Who introduced the name Aldi in 1962?", answer: "The Albrecht brothers", accepted_answers: [], answer_type: "person" };
  assert.equal(validDistractors(["Theo Albrecht", "Aldi founders", "Karl Albrecht"], aldi), null);
  assert.deepEqual(validDistractors(["Dieter Schwarz", "Theo Albrecht", "Lidl founders", "Erivan Haub", "Georg Schaeffler"], aldi), ["Dieter Schwarz", "Lidl founders", "Erivan Haub"]);
  const sea = { question: "Which ocean is the largest?", answer: "Pacific Ocean", accepted_answers: [], answer_type: "place" };
  assert.deepEqual(validDistractors(["Atlantic Ocean", "Indian Ocean", "Arctic Ocean"], sea), ["Atlantic Ocean", "Indian Ocean", "Arctic Ocean"]);
  const php = { question: "Who created the PHP programming language?", answer: "Rasmus Lerdorf", accepted_answers: [], answer_type: "person" };
  assert.deepEqual(validDistractors(["Guido van Rossum", "Larry Wall", "Brendan Eich"], php), ["Guido van Rossum", "Larry Wall", "Brendan Eich"]);
  const war = { question: "Which battle ended Napoleon's rule?", answer: "Battle of Waterloo", accepted_answers: [], answer_type: "other" };
  assert.deepEqual(validDistractors(["Battle of Austerlitz", "Battle of Leipzig", "Battle of Borodino"], war), ["Battle of Austerlitz", "Battle of Leipzig", "Battle of Borodino"]);
});
