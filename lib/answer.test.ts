import { test } from "node:test";
import assert from "node:assert/strict";
import { isCorrect, normalize } from "./answer";

test("normalize", () => {
  assert.equal(normalize("  The Beatles! "), "beatles");
  assert.equal(normalize("Ångström"), "angstrom");
  assert.equal(normalize("an Apple"), "apple");
  assert.equal(normalize("1,000"), "1000");
  assert.equal(normalize("twenty-one"), "21");
  assert.equal(normalize("two thousand and twenty four"), "2024");
  assert.equal(normalize("one hundred"), "100");
  assert.equal(normalize("U.S.A."), "usa");
  assert.equal(normalize("3.14"), "3.14");
  assert.equal(normalize("Rock & Roll"), "rock and roll");
});

test("exact and accepted answers", () => {
  assert.ok(isCorrect("paris", "Paris"));
  assert.ok(isCorrect("the beatles", "Beatles"));
  assert.ok(isCorrect("JFK", "John F. Kennedy", ["JFK", "Kennedy"]));
  assert.ok(isCorrect("Pelé", "Pele"));
});

test("numbers as digits or words, never fuzzy", () => {
  assert.ok(isCorrect("1969", "1969"));
  assert.ok(isCorrect("seven", "7"));
  assert.ok(isCorrect("7", "seven"));
  assert.ok(!isCorrect("1968", "1969"));
  assert.ok(!isCorrect("70", "7"));
});

test("fuzzy typos on longer answers", () => {
  assert.ok(isCorrect("Shakespear", "Shakespeare"));
  assert.ok(isCorrect("Mississipi", "Mississippi"));
  assert.ok(!isCorrect("Austria", "Australia"));
  assert.ok(!isCorrect("car", "cat"));
  assert.ok(!isCorrect("", "Paris"));
});
