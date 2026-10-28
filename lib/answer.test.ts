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
  assert.ok(isCorrect("26", "26 years"));
  assert.ok(isCorrect("32 teams", "32"));
  assert.ok(isCorrect("thirty two", "32 teams"));
  assert.ok(!isCorrect("25", "26 years"));
  assert.ok(!isCorrect("26 days", "26 years"));
});

test("people can be named by surname", () => {
  assert.ok(isCorrect("mendeleev", "Dmitri Mendeleev", [], 0.85, "person"));
  assert.ok(isCorrect("mendeleyev", "Dmitri Mendeleev", [], 0.85, "person"));
  assert.ok(isCorrect("da vinci", "Leonardo da Vinci", [], 0.85, "person"));
  assert.ok(isCorrect("vinci", "Leonardo da Vinci", [], 0.85, "person"));
  assert.ok(!isCorrect("dmitri", "Dmitri Mendeleev", [], 0.85, "person"));
  assert.ok(!isCorrect("mendeleev", "Dmitri Mendeleev")); // only for person answers
  assert.ok(!isCorrect("ocean", "Pacific Ocean", [], 0.85, "place"));
  assert.ok(!isCorrect("li", "Bruce Li", [], 0.85, "person")); // too short to be safe
});

test("answers listing alternatives", () => {
  assert.ok(isCorrect("catwoman", "Selina Kyle / Catwoman"));
  assert.ok(isCorrect("selina kyle", "Selina Kyle / Catwoman"));
  assert.ok(isCorrect("Selina Kyle / Catwoman", "Selina Kyle / Catwoman"));
  assert.ok(isCorrect("bombay", "Mumbai (Bombay)"));
  assert.ok(isCorrect("mumbai", "Mumbai (Bombay)"));
  assert.ok(isCorrect("ac/dc", "AC/DC"));
  assert.ok(!isCorrect("ac", "AC/DC"));
  assert.ok(isCorrect("kyle", "Selina Kyle / Catwoman", [], 0.85, "person"));
});

test("city answers accept the city alone", () => {
  assert.ok(isCorrect("portland", "Portland, Maine", [], 0.85, "city"));
  assert.ok(isCorrect("Portland, Maine", "Portland, Maine", [], 0.85, "city"));
  assert.ok(!isCorrect("maine", "Portland, Maine", [], 0.85, "city"));
  assert.ok(!isCorrect("usa", "Portland, Maine", [], 0.85, "city"));
  assert.ok(!isCorrect("crosby", "Crosby, Stills & Nash", [], 0.85, "title"));
});

test("common aliases and acronyms", () => {
  assert.ok(isCorrect("usa", "United States", [], 0.85, "country"));
  assert.ok(isCorrect("USA", "the United States"));
  assert.ok(isCorrect("U.S.", "United States"));
  assert.ok(isCorrect("america", "United States of America"));
  assert.ok(isCorrect("uk", "United Kingdom"));
  assert.ok(isCorrect("ussr", "Soviet Union"));
  assert.ok(isCorrect("holland", "Netherlands"));
  assert.ok(isCorrect("ww2", "World War II"));
  assert.ok(isCorrect("second world war", "World War II"));
  assert.ok(isCorrect("nasa", "National Aeronautics and Space Administration"));
  assert.ok(isCorrect("UN", "United Nations"));
  assert.ok(!isCorrect("uk", "United States"));
  assert.ok(!isCorrect("ww1", "World War II"));
  assert.ok(!isCorrect("jk", "John Kennedy", [], 0.85, "person"));
  assert.ok(!isCorrect("p", "Pacific Ocean"));
});

test("fuzzy typos on longer answers", () => {
  assert.ok(isCorrect("Shakespear", "Shakespeare"));
  assert.ok(isCorrect("Mississipi", "Mississippi"));
  assert.ok(!isCorrect("Austria", "Australia"));
  assert.ok(!isCorrect("car", "cat"));
  assert.ok(!isCorrect("", "Paris"));
});
